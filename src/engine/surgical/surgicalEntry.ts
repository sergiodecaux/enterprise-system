import type { OhlcvCandle } from '../../api/mexc'
import type { TradeSide } from '../smc'
import type {
  AbsorptionCandle,
  LiquidityRaidResult,
  LTFChoCHResult,
  MmIntentSnapshot,
  MSSResult,
  OTESniperZone,
  SurgicalEntrySnapshot,
  SurgicalEntryStatus,
} from '../types'

export interface SurgicalEntryInput {
  side: TradeSide
  price: number
  candles1m?: OhlcvCandle[] | null
  candles5m?: OhlcvCandle[] | null
  mmIntent?: MmIntentSnapshot | null
  ote?: OTESniperZone | null
  mss?: MSSResult | null
  raid?: LiquidityRaidResult | null
  absorption?: AbsorptionCandle | null
  ltfChoCH?: LTFChoCHResult | null
  /** OB/FVG confluence zone */
  zoneTop?: number | null
  zoneBottom?: number | null
  /** Buyer aggression ratio if known */
  buyToSellRatio?: number | null
  /** Previous snapshot to preserve sweep clock */
  previous?: SurgicalEntrySnapshot | null
  /** ATR-ish for invalidation distance (absolute price) */
  atr?: number | null
}

const SWEEP_TOL = 0.0008 // 0.08%
const LOOKBACK_1M = 45
const LOOKBACK_5M = 24

function empty(
  side: TradeSide,
  status: SurgicalEntryStatus,
  reason: string,
  extra: Partial<SurgicalEntrySnapshot> = {}
): SurgicalEntrySnapshot {
  return {
    status,
    side,
    microTarget: null,
    macroTarget: null,
    sweepPrice: null,
    sweepAt: null,
    confirmations: [],
    limitEntry: null,
    zoneTop: null,
    zoneBottom: null,
    invalidation: null,
    reason,
    updatedAt: Date.now(),
    ...extra,
  }
}

/**
 * Ювелирный вход:
 * 1) WAITING_SWEEP — ждём wick через microTarget (SSL для LONG / BSL для SHORT)
 * 2) WAITING_CONFIRM — свип был, ждём CHoCH / MSS / absorption / reclaim
 * 3) READY — лимитка в OTE / зоне reclaim
 * 4) INVALIDATED / MISSED
 */
export function resolveSurgicalEntry(
  input: SurgicalEntryInput
): SurgicalEntrySnapshot {
  const side = input.side
  const price = input.price
  const hunt = input.mmIntent?.hunt
  const micro =
    hunt?.microTarget ??
    (input.raid?.sweptLevel && input.raid.type !== 'NONE'
      ? input.raid.sweptLevel
      : null)
  const macro = hunt?.macroTarget ?? null

  if (!micro || micro <= 0) {
    // Fallback: OTE + LTF confirm without MM micro — still surgical if READY
    return resolveWithoutMicro(input)
  }

  const atr = input.atr ?? price * 0.004
  const candles = pickCandles(input)
  const sweep = detectMicroSweep(candles, micro, side, input.previous)

  if (!sweep.swept) {
    return empty(side, 'WAITING_SWEEP', `Ждём sweep @ ${fmt(micro)}`, {
      microTarget: micro,
      macroTarget: macro,
      invalidation: side === 'LONG' ? micro - atr * 0.8 : micro + atr * 0.8,
    })
  }

  // Invalidation after sweep
  const inv =
    side === 'LONG'
      ? Math.min(sweep.extreme, micro) - atr * 0.35
      : Math.max(sweep.extreme, micro) + atr * 0.35

  if (side === 'LONG' && price < inv) {
    return empty(side, 'INVALIDATED', 'Цена ушла ниже sweep — сетап сломан', {
      microTarget: micro,
      macroTarget: macro,
      sweepPrice: sweep.price,
      sweepAt: sweep.at,
      invalidation: inv,
    })
  }
  if (side === 'SHORT' && price > inv) {
    return empty(side, 'INVALIDATED', 'Цена ушла выше sweep — сетап сломан', {
      microTarget: micro,
      macroTarget: macro,
      sweepPrice: sweep.price,
      sweepAt: sweep.at,
      invalidation: inv,
    })
  }

  // Missed: already ran to macro / far past without fill near limit zone
  if (macro != null && macro > 0) {
    const towardMacro =
      side === 'LONG' ? price >= macro * 0.998 : price <= macro * 1.002
    if (towardMacro) {
      return empty(side, 'MISSED', 'Магнит ликвидности уже отработан', {
        microTarget: micro,
        macroTarget: macro,
        sweepPrice: sweep.price,
        sweepAt: sweep.at,
        invalidation: inv,
      })
    }
  }

  const confirms = collectConfirmations(input, side, sweep)
  const zone = computeLimitZone(input, side, sweep, micro)

  if (confirms.length === 0) {
    return {
      status: 'WAITING_CONFIRM',
      side,
      microTarget: micro,
      macroTarget: macro,
      sweepPrice: sweep.price,
      sweepAt: sweep.at,
      confirmations: [],
      limitEntry: zone.mid,
      zoneTop: zone.top,
      zoneBottom: zone.bottom,
      invalidation: inv,
      reason: `Sweep @ ${fmt(sweep.price)} — ждём CHoCH / MSS / absorption / reclaim`,
      updatedAt: Date.now(),
    }
  }

  // Missed fill: price already left entry zone toward target by >0.6%
  if (zone.mid != null) {
    const leftZone =
      side === 'LONG'
        ? price > zone.top! * 1.006
        : price < zone.bottom! * 0.994
    if (leftZone) {
      return empty(side, 'MISSED', 'Цена ушла без заполнения лимитки', {
        microTarget: micro,
        macroTarget: macro,
        sweepPrice: sweep.price,
        sweepAt: sweep.at,
        confirmations: confirms,
        limitEntry: zone.mid,
        zoneTop: zone.top,
        zoneBottom: zone.bottom,
        invalidation: inv,
      })
    }
  }

  return {
    status: 'READY',
    side,
    microTarget: micro,
    macroTarget: macro,
    sweepPrice: sweep.price,
    sweepAt: sweep.at,
    confirmations: confirms,
    limitEntry: zone.mid,
    zoneTop: zone.top,
    zoneBottom: zone.bottom,
    invalidation: inv,
    reason: `Лимит ${fmt(zone.mid!)} · ${confirms.slice(0, 2).join(' + ')}`,
    updatedAt: Date.now(),
  }
}

function resolveWithoutMicro(input: SurgicalEntryInput): SurgicalEntrySnapshot {
  const side = input.side
  const confirms = collectConfirmations(input, side, {
    swept: true,
    price: input.price,
    extreme: input.price,
    at: Date.now(),
    reclaimMid: input.price,
  })
  const ote = input.ote
  const hasOte =
    ote?.isActive &&
    ((side === 'LONG' && ote.direction === 'LONG') ||
      (side === 'SHORT' && ote.direction === 'SHORT'))

  if (!hasOte && confirms.length === 0) {
    return empty(side, 'IDLE', 'Нет microTarget и нет LTF-подтверждения')
  }

  if (confirms.length === 0) {
    return empty(side, 'WAITING_CONFIRM', 'OTE есть — ждём LTF confirm', {
      limitEntry: ote ? (ote.zoneTop + ote.zoneBottom) / 2 : null,
      zoneTop: ote?.zoneTop ?? null,
      zoneBottom: ote?.zoneBottom ?? null,
    })
  }

  const zone = computeLimitZone(input, side, {
    swept: true,
    price: input.ltfChoCH?.surgicalEntryPrice ?? input.price,
    extreme: input.price,
    at: Date.now(),
    reclaimMid:
      input.ltfChoCH?.surgicalEntryPrice ??
      (ote ? (ote.zoneTop + ote.zoneBottom) / 2 : input.price),
  }, null)

  const inOrNear =
    zone.bottom != null &&
    zone.top != null &&
    input.price >= zone.bottom * 0.997 &&
    input.price <= zone.top * 1.003

  if (!inOrNear && !input.ltfChoCH?.surgicalEntryDetected) {
    return empty(side, 'WAITING_CONFIRM', 'Confirm есть — ждём цену в зоне входа', {
      confirmations: confirms,
      limitEntry: zone.mid,
      zoneTop: zone.top,
      zoneBottom: zone.bottom,
    })
  }

  return {
    status: 'READY',
    side,
    microTarget: null,
    macroTarget: null,
    sweepPrice: null,
    sweepAt: null,
    confirmations: confirms,
    limitEntry: zone.mid,
    zoneTop: zone.top,
    zoneBottom: zone.bottom,
    invalidation:
      side === 'LONG'
        ? (zone.bottom ?? input.price) * 0.994
        : (zone.top ?? input.price) * 1.006,
    reason: `Лимит ${fmt(zone.mid!)} · ${confirms.slice(0, 2).join(' + ')}`,
    updatedAt: Date.now(),
  }
}

function pickCandles(input: SurgicalEntryInput): OhlcvCandle[] {
  if (input.candles1m && input.candles1m.length >= 15) {
    return input.candles1m.slice(-LOOKBACK_1M)
  }
  if (input.candles5m && input.candles5m.length >= 10) {
    return input.candles5m.slice(-LOOKBACK_5M)
  }
  return []
}

interface SweepHit {
  swept: boolean
  price: number
  extreme: number
  at: number
  reclaimMid: number
}

function detectMicroSweep(
  candles: OhlcvCandle[],
  micro: number,
  side: TradeSide,
  previous?: SurgicalEntrySnapshot | null
): SweepHit {
  if (
    previous?.sweepPrice != null &&
    previous.side === side &&
    previous.microTarget != null &&
    Math.abs(previous.microTarget - micro) / micro < 0.002 &&
    (previous.status === 'WAITING_CONFIRM' ||
      previous.status === 'READY' ||
      previous.status === 'MISSED')
  ) {
    return {
      swept: true,
      price: previous.sweepPrice,
      extreme: previous.sweepPrice,
      at: previous.sweepAt ?? Date.now(),
      reclaimMid: previous.limitEntry ?? previous.sweepPrice,
    }
  }

  if (candles.length < 3) {
    return { swept: false, price: 0, extreme: 0, at: 0, reclaimMid: 0 }
  }

  const lo = micro * (1 - SWEEP_TOL)
  const hi = micro * (1 + SWEEP_TOL)

  for (let i = candles.length - 1; i >= Math.max(0, candles.length - LOOKBACK_1M); i--) {
    const c = candles[i]
    const [, , high, low, close] = c
    const ts = c[0]

    if (side === 'LONG') {
      // SSL hunt: wick below micro, close back above
      if (low <= hi && close > lo) {
        const reclaim = candles[Math.min(i + 1, candles.length - 1)]
        const mid =
          (reclaim[2] + reclaim[3]) / 2 || (high + low) / 2
        return {
          swept: true,
          price: low,
          extreme: low,
          at: ts,
          reclaimMid: mid,
        }
      }
    } else {
      // BSL hunt: wick above micro, close back below
      if (high >= lo && close < hi) {
        const reclaim = candles[Math.min(i + 1, candles.length - 1)]
        const mid =
          (reclaim[2] + reclaim[3]) / 2 || (high + low) / 2
        return {
          swept: true,
          price: high,
          extreme: high,
          at: ts,
          reclaimMid: mid,
        }
      }
    }
  }

  return { swept: false, price: 0, extreme: 0, at: 0, reclaimMid: 0 }
}

function collectConfirmations(
  input: SurgicalEntryInput,
  side: TradeSide,
  sweep: SweepHit
): string[] {
  const out: string[] = []

  if (side === 'LONG') {
    if (input.ltfChoCH?.detected) {
      out.push(
        input.ltfChoCH.surgicalEntryDetected
          ? 'CHoCH+surgical'
          : 'CHoCH 1m'
      )
    }
    if (input.mss?.detected && input.mss.direction === 'BULLISH') {
      out.push('MSS 5m')
    }
    if (input.absorption?.detected) out.push('Absorption')
    if (input.raid?.isFresh && input.raid.type === 'BULL_SWEEP') {
      out.push('Bull sweep')
    }
    if ((input.buyToSellRatio ?? 0) >= 1.6) out.push('Tape buy')
  } else {
    if (input.mss?.detected && input.mss.direction === 'BEARISH') {
      out.push('MSS 5m')
    }
    if (input.raid?.isFresh && input.raid.type === 'BEAR_SWEEP') {
      out.push('Bear sweep')
    }
    if (detectBearishAbsorption(input.candles5m ?? input.candles1m)) {
      out.push('Absorption↓')
    }
    if ((input.buyToSellRatio ?? 99) <= 0.65) out.push('Tape sell')
  }

  // Structure reclaim after sweep wick
  if (sweep.swept && input.price > 0) {
    if (side === 'LONG' && input.price > sweep.price * 1.0005) {
      if (!out.includes('Reclaim')) out.push('Reclaim')
    }
    if (side === 'SHORT' && input.price < sweep.price * 0.9995) {
      if (!out.includes('Reclaim')) out.push('Reclaim')
    }
  }

  // Reclaim alone is weak — need ≥1 stronger tag OR reclaim+OTE
  const strong = out.filter((c) => c !== 'Reclaim')
  if (strong.length === 0) {
    const oteOk =
      input.ote?.isActive &&
      ((side === 'LONG' && input.ote.direction === 'LONG') ||
        (side === 'SHORT' && input.ote.direction === 'SHORT'))
    if (oteOk && out.includes('Reclaim')) return ['Reclaim', 'OTE']
    return [] // only reclaim without structure = still waiting
  }

  return out
}

function computeLimitZone(
  input: SurgicalEntryInput,
  side: TradeSide,
  sweep: SweepHit,
  micro: number | null
): { top: number; bottom: number; mid: number } {
  const ote = input.ote
  const oteAligned =
    ote?.isActive &&
    ((side === 'LONG' && ote.direction === 'LONG') ||
      (side === 'SHORT' && ote.direction === 'SHORT'))

  if (oteAligned && ote) {
    const mid = (ote.zoneTop + ote.zoneBottom) / 2
    return { top: ote.zoneTop, bottom: ote.zoneBottom, mid }
  }

  if (
    input.zoneTop != null &&
    input.zoneBottom != null &&
    input.zoneTop > input.zoneBottom
  ) {
    const mid = (input.zoneTop + input.zoneBottom) / 2
    return {
      top: input.zoneTop,
      bottom: input.zoneBottom,
      mid,
    }
  }

  if (input.ltfChoCH?.surgicalEntryPrice) {
    const p = input.ltfChoCH.surgicalEntryPrice
    const pad = p * 0.0015
    return { top: p + pad, bottom: p - pad, mid: p }
  }

  const mid = sweep.reclaimMid || micro || input.price
  const pad = mid * 0.0012
  if (side === 'LONG') {
    return {
      top: mid + pad,
      bottom: Math.min(mid - pad, sweep.extreme || mid),
      mid,
    }
  }
  return {
    top: Math.max(mid + pad, sweep.extreme || mid),
    bottom: mid - pad,
    mid,
  }
}

function detectBearishAbsorption(
  candles: OhlcvCandle[] | null | undefined
): boolean {
  if (!candles || candles.length < 30) return false
  const lookback = 10
  const baseStart = candles.length - lookback - 20
  let avg = 0
  for (let i = baseStart; i < candles.length - lookback; i++) avg += candles[i][5]
  avg /= 20
  if (avg <= 0) return false

  for (let i = candles.length - lookback; i < candles.length; i++) {
    const [, open, high, low, close, volume] = candles[i]
    const range = high - low
    if (range <= 0) continue
    const body = Math.abs(close - open)
    const upper = high - Math.max(open, close)
    if (
      volume / avg >= 2.3 &&
      body / range <= 0.35 &&
      upper / range >= 0.45
    ) {
      return true
    }
  }
  return false
}

function fmt(n: number): string {
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toPrecision(5)
}

/** Sniper / trade open only when READY */
export function isSurgicalReady(
  s: SurgicalEntrySnapshot | null | undefined
): boolean {
  return s?.status === 'READY' && s.limitEntry != null && s.limitEntry > 0
}
