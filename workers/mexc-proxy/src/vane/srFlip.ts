import {
  RETEST_TTL_BARS_5M,
  VANE_STATE_PREFIX,
  type Candle,
  type Side,
  type VaneKv,
  type VanePath,
  type VanePhase,
  type VaneSymbolState,
  type VaneZoneGeom,
  type ZoneGrade,
} from './types'

export async function loadVaneState(
  kv: VaneKv | undefined,
  symbol: string
): Promise<VaneSymbolState | null> {
  if (!kv) return null
  const raw = await kv.get(VANE_STATE_PREFIX + symbol)
  if (!raw) return null
  try {
    return JSON.parse(raw) as VaneSymbolState
  } catch {
    return null
  }
}

export async function saveVaneState(
  kv: VaneKv | undefined,
  state: VaneSymbolState
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(VANE_STATE_PREFIX + state.symbol, JSON.stringify(state))
  } catch {
    /* quota */
  }
}

export function flipSide(origin: Side): Side {
  return origin === 'LONG' ? 'SHORT' : 'LONG'
}

/** 5m close beyond zone = confirmed break (not wick sweep alone) */
export function breakConfirmed(
  originSide: Side,
  zone: VaneZoneGeom,
  candles5m: Candle[]
): boolean {
  const last = candles5m[candles5m.length - 1]
  if (!last) return false
  const close = last[4]
  if (originSide === 'LONG') return close < zone.zoneLow * 0.9985
  return close > zone.zoneHigh * 1.0015
}

export function volumeSpikeOnBreak(candles5m: Candle[]): boolean {
  if (candles5m.length < 8) return false
  const last = candles5m[candles5m.length - 1]!
  const base = candles5m.slice(-8, -1)
  const avg = base.reduce((s, c) => s + c[5], 0) / base.length
  return avg > 0 && last[5] >= avg * 1.8
}

/**
 * Retest quality: approach from beyond zone on declining volume, small bodies.
 * Toxic = impulsive reclaim on rising volume.
 */
export function assessRetestQuality(opts: {
  originSide: Side
  zone: VaneZoneGeom
  price: number
  candles5m: Candle[]
}): { ready: boolean; toxic: boolean; note: string } {
  const { originSide, zone, price, candles5m } = opts
  const near =
    originSide === 'LONG'
      ? price >= zone.zoneLow * 0.997 && price <= zone.zoneHigh * 1.002
      : price <= zone.zoneHigh * 1.003 && price >= zone.zoneLow * 0.998

  if (!near) {
    return { ready: false, toxic: false, note: 'ждём поднос к пробитой зоне' }
  }

  const recent = candles5m.slice(-5)
  if (recent.length < 3) {
    return { ready: false, toxic: false, note: 'мало 5m баров для ретеста' }
  }

  const vols = recent.map((c) => c[5])
  const declining =
    vols[vols.length - 1]! <= vols[0]! * 0.85 ||
    vols[vols.length - 1]! <=
      vols.reduce((s, v) => s + v, 0) / vols.length
  const last = recent[recent.length - 1]!
  const range = last[2] - last[3]
  const body = Math.abs(last[4] - last[1])
  const smallBody = range > 0 ? body / range <= 0.55 : true
  const avgVol =
    recent.slice(0, -1).reduce((s, c) => s + c[5], 0) /
    Math.max(1, recent.length - 1)
  const toxic =
    avgVol > 0 &&
    last[5] >= avgVol * 2.2 &&
    range > 0 &&
    body / range >= 0.65

  if (toxic) {
    return {
      ready: false,
      toxic: true,
      note: 'токсичный ретест: импульсный откат на объёме — abort',
    }
  }
  if (declining && smallBody) {
    return {
      ready: true,
      toxic: false,
      note: 'ретест compressive — лимит на flip ок',
    }
  }
  return {
    ready: false,
    toxic: false,
    note: 'ретест ещё не compressive',
  }
}

export function advanceVanePhase(opts: {
  prev: VaneSymbolState | null
  symbol: string
  originSide: Side
  zone: VaneZoneGeom
  grade: ZoneGrade
  phaseGeom: 'FAR' | 'APPROACH' | 'TOUCH'
  candles5m: Candle[]
  price: number
  score: number
  tier: 'TIER1' | 'TIER2' | null
}): { state: VaneSymbolState; emitPath: VanePath | null } {
  const now = Date.now()
  const base: VaneSymbolState = opts.prev ?? {
    symbol: opts.symbol,
    phase: 'MONITOR',
    originSide: opts.originSide,
    path: null,
    tier: null,
    zone: opts.zone,
    score: opts.score,
    armedAt: null,
    breakConfirmedAt: null,
    retestBarsLeft: RETEST_TTL_BARS_5M,
    updatedAt: now,
    reason: '',
  }

  let phase: VanePhase = base.phase
  let path: VanePath | null = null
  let reason = ''
  let armedAt = base.armedAt
  let breakConfirmedAt = base.breakConfirmedAt
  let retestBarsLeft = base.retestBarsLeft
  let emitPath: VanePath | null = null

  // Refresh zone geometry while monitoring / touching
  const zone = opts.zone

  if (opts.phaseGeom === 'FAR' && phase === 'MONITOR') {
    return {
      state: {
        ...base,
        zone,
        score: opts.score,
        tier: opts.tier,
        updatedAt: now,
        reason: 'далеко от зоны',
      },
      emitPath: null,
    }
  }

  if (opts.phaseGeom === 'APPROACH' || opts.phaseGeom === 'TOUCH') {
    if (phase === 'MONITOR' || phase === 'ZONE_TOUCH') {
      phase = 'ZONE_TOUCH'
    }
  }

  if (phase === 'ZONE_TOUCH' || phase === 'STRONG_HOLD') {
    if (opts.grade === 'STRONG' && opts.phaseGeom === 'TOUCH') {
      phase = 'STRONG_HOLD'
      path = 'HOLD'
      reason = 'зона сильная — HOLD LONG/SHORT'
      emitPath = 'HOLD'
    } else if (opts.grade === 'WEAK') {
      phase = 'WEAK_BREAK'
      reason = 'зона слабая — отмена hold, ждём фиксацию пробоя'
    }
  }

  if (phase === 'WEAK_BREAK' || phase === 'BREAK_ARMED') {
    if (
      breakConfirmed(opts.originSide, zone, opts.candles5m) &&
      volumeSpikeOnBreak(opts.candles5m)
    ) {
      phase = 'BREAK_ARMED'
      breakConfirmedAt = now
      armedAt = now
      retestBarsLeft = RETEST_TTL_BARS_5M
      reason = 'пробой зафиксирован 5m + volume spike'
      phase = 'RETEST_WAIT'
    }
  }

  if (phase === 'RETEST_WAIT') {
    retestBarsLeft = Math.max(0, retestBarsLeft - 1)
    const rq = assessRetestQuality({
      originSide: opts.originSide,
      zone,
      price: opts.price,
      candles5m: opts.candles5m,
    })
    if (rq.toxic || retestBarsLeft <= 0) {
      phase = 'ABORT'
      reason = rq.toxic ? rq.note : 'TTL ретеста истёк — abort'
    } else if (rq.ready && opts.grade !== 'WEAK') {
      // On flip side we want opposing walls (asks for short after long break)
      phase = opts.originSide === 'LONG' ? 'SHORT_LIMIT' : 'LONG_LIMIT'
      path = 'FLIP'
      reason = rq.note
      emitPath = 'FLIP'
    } else {
      reason = rq.note
    }
  }

  if (phase === 'ABORT') {
    // Reset to monitor next cycle
    return {
      state: {
        symbol: opts.symbol,
        phase: 'MONITOR',
        originSide: opts.originSide,
        path: null,
        tier: opts.tier,
        zone,
        score: opts.score,
        armedAt: null,
        breakConfirmedAt: null,
        retestBarsLeft: RETEST_TTL_BARS_5M,
        updatedAt: now,
        reason,
      },
      emitPath: null,
    }
  }

  return {
    state: {
      symbol: opts.symbol,
      phase,
      originSide: opts.originSide,
      path,
      tier: opts.tier,
      zone,
      score: opts.score,
      armedAt,
      breakConfirmedAt,
      retestBarsLeft,
      updatedAt: now,
      reason,
    },
    emitPath,
  }
}
