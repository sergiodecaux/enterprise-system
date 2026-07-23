/**
 * Portable SSL/BSL liquidity zones — mirrors Mini App smc/findTradeZones.
 * Used by Telegram bot scanner + watches so signals share the same zone logic.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'
type Strength = 'WEAK' | 'MEDIUM' | 'STRONG'

export interface EqualLevel {
  price: number
  type: 'HIGH' | 'LOW'
  touches: number
  strength: Strength
  isActive: boolean
  distancePct: number
}

export interface LiquidityMap {
  equalHighs: EqualLevel[]
  equalLows: EqualLevel[]
  nearestBSL: EqualLevel | null
  nearestSSL: EqualLevel | null
  liquidityBoost: number
}

export interface SmartZonePlan {
  source: 'SSL' | 'BSL' | 'SWING' | 'ATR'
  side: Side
  zoneLow: number
  zoneHigh: number
  mid: number
  limitEntry: number
  invalidate: number
  /** Nearest opposite liquidity — where price can fly */
  target: number
  targetLabel: string
  strength: number
  touches: number
  distancePct: number
  /** APPROACH / TOUCH / FAR */
  phase: 'FAR' | 'APPROACH' | 'TOUCH'
  reasoning: string[]
}

export interface ZoneFuel {
  /** Book aligned with bounce side */
  bookOk: boolean
  bookImb: number | null
  /** Wick sweep / reclaim into zone */
  reactionOk: boolean
  reactionNote: string
  /** Enough “fuel” to reach nearest liquidity */
  fuelOk: boolean
  fuelNote: string
  scoreAdj: number
  lines: string[]
}

function swings(
  candles: Candle[],
  lookback = 80
): { highs: Array<[number, number]>; lows: Array<[number, number]> } {
  const slice = candles.slice(-Math.min(candles.length, lookback + 4))
  const highs: Array<[number, number]> = []
  const lows: Array<[number, number]> = []
  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i][2]
    const l = slice[i][3]
    if (
      h > slice[i - 1][2] &&
      h > slice[i - 2][2] &&
      h > slice[i + 1][2] &&
      h > slice[i + 2][2]
    ) {
      highs.push([i, h])
    }
    if (
      l < slice[i - 1][3] &&
      l < slice[i - 2][3] &&
      l < slice[i + 1][3] &&
      l < slice[i + 2][3]
    ) {
      lows.push([i, l])
    }
  }
  return { highs, lows }
}

function cluster(
  points: Array<[number, number]>,
  type: 'HIGH' | 'LOW',
  price: number,
  tolerancePct = 0.003
): EqualLevel[] {
  const used = new Set<number>()
  const out: EqualLevel[] = []
  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue
    const [, p0] = points[i]
    const prices = [p0]
    used.add(i)
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue
      const [, pj] = points[j]
      if (Math.abs(p0 - pj) / p0 <= tolerancePct) {
        prices.push(pj)
        used.add(j)
      }
    }
    if (prices.length < 2) continue
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    const touches = prices.length
    const isActive = type === 'HIGH' ? price < avg : price > avg
    const distancePct = (Math.abs(price - avg) / price) * 100
    const strength: Strength =
      touches >= 5 ? 'STRONG' : touches >= 3 ? 'MEDIUM' : 'WEAK'
    out.push({
      price: avg,
      type,
      touches,
      strength,
      isActive,
      distancePct,
    })
  }
  const order = { STRONG: 3, MEDIUM: 2, WEAK: 1 }
  return out
    .sort(
      (a, b) =>
        order[b.strength] - order[a.strength] ||
        (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1) ||
        a.distancePct - b.distancePct
    )
    .slice(0, 6)
}

/** Same semantics as Mini App buildLiquidityMap */
export function buildLiquidityMap(
  candles: Candle[],
  price: number
): LiquidityMap {
  if (!(price > 0) || candles.length < 20) {
    return {
      equalHighs: [],
      equalLows: [],
      nearestBSL: null,
      nearestSSL: null,
      liquidityBoost: 0,
    }
  }
  const { highs, lows } = swings(candles)
  const equalHighs = cluster(highs, 'HIGH', price)
  const equalLows = cluster(lows, 'LOW', price)
  const nearestBSL =
    equalHighs
      .filter((l) => l.price > price)
      .sort((a, b) => a.price - b.price)[0] ?? null
  const nearestSSL =
    equalLows
      .filter((l) => l.price < price)
      .sort((a, b) => b.price - a.price)[0] ?? null

  const boostOf = (level: EqualLevel | null): number => {
    if (!level?.isActive) return 0
    const mul =
      level.strength === 'STRONG' ? 1 : level.strength === 'MEDIUM' ? 0.6 : 0.3
    const d = level.distancePct
    if (d < 0.5) return 0.5 * mul
    if (d < 1.5) return 2 * mul
    if (d < 3) return 1 * mul
    if (d < 5) return 0.5 * mul
    return 0
  }

  return {
    equalHighs,
    equalLows,
    nearestBSL,
    nearestSSL,
    liquidityBoost: Math.min(2, Math.max(boostOf(nearestBSL), boostOf(nearestSSL))),
  }
}

function band(mid: number, pct = 0.004): { top: number; bottom: number } {
  return { top: mid * (1 + pct), bottom: mid * (1 - pct) }
}

function phaseOf(price: number, low: number, high: number): SmartZonePlan['phase'] {
  if (price >= low * 0.998 && price <= high * 1.002) return 'TOUCH'
  const mid = (low + high) / 2
  const dist = Math.abs(price - mid) / price
  if (dist <= 0.0045) return 'APPROACH'
  return 'FAR'
}

/**
 * Pick SSL (LONG) or BSL (SHORT) like the Mini App — target = opposite liquidity.
 * Falls back to null if no medium/strong pool (caller uses ATR plan).
 */
export function findSmartZone(
  side: Side,
  price: number,
  map: LiquidityMap,
  atr: number
): SmartZonePlan | null {
  if (!(price > 0)) return null

  if (side === 'LONG') {
    const ssl =
      map.equalLows
        .filter((l) => l.isActive && l.strength !== 'WEAK' && l.price < price * 1.002)
        .sort(
          (a, b) =>
            a.distancePct - b.distancePct ||
            (b.strength === 'STRONG' ? 1 : 0) - (a.strength === 'STRONG' ? 1 : 0)
        )[0] ?? map.nearestSSL
    if (!ssl || ssl.strength === 'WEAK') return null
    const { top, bottom } = band(ssl.price, 0.004)
    const target = map.nearestBSL?.price ?? price + Math.max(atr * 2.2, price * 0.012)
    const targetLabel = map.nearestBSL
      ? `BSL ×${map.nearestBSL.touches} (${map.nearestBSL.strength}) @ ${map.nearestBSL.price}`
      : `swing/ATR цель @ ${target}`
    const strength = ssl.strength === 'STRONG' ? 9 : 7
    return {
      source: 'SSL',
      side,
      zoneLow: bottom,
      zoneHigh: top,
      mid: ssl.price,
      limitEntry: (bottom + Math.min(ssl.price, top)) / 2,
      invalidate: bottom * 0.994,
      target,
      targetLabel,
      strength,
      touches: ssl.touches,
      distancePct: ((ssl.price - price) / price) * 100,
      phase: phaseOf(price, bottom, top),
      reasoning: [
        `Зона LONG = SSL ×${ssl.touches} (${ssl.strength}) — как в приложении`,
        `Ближайшая ликвидность вверх: ${targetLabel}`,
        `Фаза: ${phaseOf(price, bottom, top)} · до зоны ${ssl.distancePct.toFixed(2)}%`,
      ],
    }
  }

  const bsl =
    map.equalHighs
      .filter((l) => l.isActive && l.strength !== 'WEAK' && l.price > price * 0.998)
      .sort(
        (a, b) =>
          a.distancePct - b.distancePct ||
          (b.strength === 'STRONG' ? 1 : 0) - (a.strength === 'STRONG' ? 1 : 0)
      )[0] ?? map.nearestBSL
  if (!bsl || bsl.strength === 'WEAK') return null
  const { top, bottom } = band(bsl.price, 0.004)
  const target = map.nearestSSL?.price ?? price - Math.max(atr * 2.2, price * 0.012)
  const targetLabel = map.nearestSSL
    ? `SSL ×${map.nearestSSL.touches} (${map.nearestSSL.strength}) @ ${map.nearestSSL.price}`
    : `swing/ATR цель @ ${target}`
  const strength = bsl.strength === 'STRONG' ? 9 : 7
  return {
    source: 'BSL',
    side,
    zoneLow: bottom,
    zoneHigh: top,
    mid: bsl.price,
    limitEntry: (top + Math.max(bsl.price, bottom)) / 2,
    invalidate: top * 1.006,
    target,
    targetLabel,
    strength,
    touches: bsl.touches,
    distancePct: ((bsl.price - price) / price) * 100,
    phase: phaseOf(price, bottom, top),
    reasoning: [
      `Зона SHORT = BSL ×${bsl.touches} (${bsl.strength}) — как в приложении`,
      `Ближайшая ликвидность вниз: ${targetLabel}`,
      `Фаза: ${phaseOf(price, bottom, top)} · до зоны ${bsl.distancePct.toFixed(2)}%`,
    ],
  }
}

/** Reaction + book fuel at/near zone (for watches and alert scoring) */
export function assessZoneFuel(opts: {
  side: Side
  price: number
  zoneLow: number
  zoneHigh: number
  candles1m: Candle[]
  bookImb: number | null
}): ZoneFuel {
  const inside =
    opts.price >= opts.zoneLow * 0.998 && opts.price <= opts.zoneHigh * 1.002
  const mid = (opts.zoneLow + opts.zoneHigh) / 2
  const lines: string[] = []
  let scoreAdj = 0

  // Reaction: wick through micro then close back (reclaim)
  let reactionOk = false
  let reactionNote = 'реакции ещё нет'
  const recent = opts.candles1m.slice(-8)
  if (recent.length >= 3) {
    for (const c of recent) {
      const [, , high, low, close] = c
      if (opts.side === 'LONG') {
        if (low <= mid * 1.001 && close > mid * 0.9995 && close > low * 1.001) {
          reactionOk = true
          reactionNote = 'wick-sweep SSL + reclaim (слабость поглощена)'
          break
        }
      } else if (
        high >= mid * 0.999 &&
        close < mid * 1.0005 &&
        close < high * 0.999
      ) {
        reactionOk = true
        reactionNote = 'wick-sweep BSL + reject (жадность поглощена)'
        break
      }
    }
    if (!reactionOk && inside) {
      reactionNote = 'цена в зоне — ждём закрепление / слабину'
    }
  }
  if (reactionOk) {
    scoreAdj += 5
    lines.push(`✓ Реакция: ${reactionNote}`)
  } else {
    lines.push(`· Реакция: ${reactionNote}`)
  }

  let bookOk = false
  const imb = opts.bookImb
  if (imb == null) {
    lines.push('· Стакан: нет данных')
  } else {
    bookOk =
      (opts.side === 'LONG' && imb >= 12) || (opts.side === 'SHORT' && imb <= -12)
    const against =
      (opts.side === 'LONG' && imb <= -18) || (opts.side === 'SHORT' && imb >= 18)
    if (bookOk) {
      scoreAdj += 4
      lines.push(`✓ Топливо стакана: OBI ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}% за сторону`)
    } else if (against) {
      scoreAdj -= 5
      lines.push(`✗ Стакан против: OBI ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}%`)
    } else {
      lines.push(`· Стакан нейтрален: OBI ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}%`)
    }
  }

  const fuelOk = bookOk && (reactionOk || inside)
  const fuelNote = fuelOk
    ? 'топлива хватает до ближайшей ликвидности'
    : 'топлива пока мало — не форсировать вход'

  if (fuelOk) {
    scoreAdj += 3
    lines.push(`✓ ${fuelNote}`)
  } else {
    lines.push(`· ${fuelNote}`)
  }

  return {
    bookOk,
    bookImb: imb,
    reactionOk,
    reactionNote,
    fuelOk,
    fuelNote,
    scoreAdj,
    lines,
  }
}

/** Probability nudge from zone strength / phase / liquidity magnet */
export function zoneProbabilityAdj(
  zone: SmartZonePlan | null,
  fuel: ZoneFuel | null
): { adj: number; factors: string[] } {
  const factors: string[] = []
  let adj = 0
  if (!zone || zone.source === 'ATR') {
    return { adj: 0, factors: ['зона: ATR-fallback (нет SSL/BSL medium+)'] }
  }
  adj += zone.strength >= 9 ? 5 : 3
  factors.push(
    `+${zone.strength >= 9 ? 5 : 3}% сильная зона ${zone.source} ×${zone.touches}`
  )
  if (zone.phase === 'APPROACH') {
    adj += 2
    factors.push('+2% цена подходит к зоне')
  } else if (zone.phase === 'TOUCH') {
    adj += 1
    factors.push('+1% касание зоны')
  }
  if (fuel) {
    adj += Math.max(-4, Math.min(6, Math.round(fuel.scoreAdj * 0.6)))
    if (fuel.fuelOk) factors.push('+топливо стакана/реакции')
    else if (fuel.scoreAdj < 0) factors.push('−стакан против зоны')
  }
  return { adj, factors }
}
