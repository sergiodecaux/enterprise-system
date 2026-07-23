/**
 * HTF liquidity zones for the Telegram bot.
 * Rule: real fuel lives on 4H+ (and Daily). 15m/1H are timing only — never primary zone source.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'
type Strength = 'WEAK' | 'MEDIUM' | 'STRONG'
export type ZoneTf = '4H' | '1D' | '1H'

export interface EqualLevel {
  price: number
  type: 'HIGH' | 'LOW'
  touches: number
  strength: Strength
  isActive: boolean
  distancePct: number
  /** Primary timeframe that formed the pool */
  tf: ZoneTf
  /** Extra HTF confluence (1H echo / daily align) */
  confluence: number
}

export interface LiquidityMap {
  equalHighs: EqualLevel[]
  equalLows: EqualLevel[]
  nearestBSL: EqualLevel | null
  nearestSSL: EqualLevel | null
  liquidityBoost: number
  /** Human-readable: which TF drove the map */
  primaryTf: ZoneTf
}

export interface SmartZonePlan {
  source: 'SSL' | 'BSL' | 'SWING' | 'ATR'
  side: Side
  zoneLow: number
  zoneHigh: number
  mid: number
  limitEntry: number
  invalidate: number
  target: number
  targetLabel: string
  /** 1–10 numeric strength (HTF-weighted) */
  strength: number
  touches: number
  distancePct: number
  phase: 'FAR' | 'APPROACH' | 'TOUCH'
  tf: ZoneTf
  confluence: number
  reasoning: string[]
}

export interface ZoneFuel {
  bookOk: boolean
  bookImb: number | null
  reactionOk: boolean
  reactionNote: string
  fuelOk: boolean
  fuelNote: string
  scoreAdj: number
  lines: string[]
}

function swings(
  candles: Candle[],
  lookback = 90
): { highs: Array<[number, number]>; lows: Array<[number, number]> } {
  const slice = candles.slice(-Math.min(candles.length, lookback + 4))
  const highs: Array<[number, number]> = []
  const lows: Array<[number, number]> = []
  // Wider pivot for HTF: 3 bars each side reduces noise vs LTF 2-bar pivots
  for (let i = 3; i < slice.length - 3; i++) {
    const h = slice[i][2]
    const l = slice[i][3]
    if (
      h > slice[i - 1][2] &&
      h > slice[i - 2][2] &&
      h > slice[i - 3][2] &&
      h > slice[i + 1][2] &&
      h > slice[i + 2][2] &&
      h > slice[i + 3][2]
    ) {
      highs.push([i, h])
    }
    if (
      l < slice[i - 1][3] &&
      l < slice[i - 2][3] &&
      l < slice[i - 3][3] &&
      l < slice[i + 1][3] &&
      l < slice[i + 2][3] &&
      l < slice[i + 3][3]
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
  tf: ZoneTf,
  /** Wider band on higher TF — equal liquidity pools are fatter */
  tolerancePct: number
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
    // HTF: even 2 equal swings matter; still need ≥2 for a "pool"
    if (prices.length < 2) continue
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length
    const touches = prices.length
    const isActive = type === 'HIGH' ? price < avg : price > avg
    const distancePct = (Math.abs(price - avg) / price) * 100

    // Strength is TF-aware: 2 touches on 4H ≈ medium; on 1H ≈ weak
    let strength: Strength = 'WEAK'
    if (tf === '1D') {
      strength = touches >= 3 ? 'STRONG' : touches >= 2 ? 'MEDIUM' : 'WEAK'
    } else if (tf === '4H') {
      strength = touches >= 4 ? 'STRONG' : touches >= 2 ? 'MEDIUM' : 'WEAK'
    } else {
      // 1H alone never STRONG
      strength = touches >= 5 ? 'MEDIUM' : 'WEAK'
    }

    out.push({
      price: avg,
      type,
      touches,
      strength,
      isActive,
      distancePct,
      tf,
      confluence: 0,
    })
  }
  return out
}

function nearPrice(a: number, b: number, pct = 0.006): boolean {
  return Math.abs(a - b) / Math.max(a, b) <= pct
}

/**
 * Merge Daily + 4H pools (primary). 1H only adds confluence — never creates the zone alone.
 */
export function buildHtfLiquidityMap(opts: {
  candles4h: Candle[]
  candles1d?: Candle[]
  candles1h?: Candle[]
  price: number
}): LiquidityMap {
  const { price } = opts
  const empty: LiquidityMap = {
    equalHighs: [],
    equalLows: [],
    nearestBSL: null,
    nearestSSL: null,
    liquidityBoost: 0,
    primaryTf: '4H',
  }
  if (!(price > 0)) return empty

  const from4h =
    opts.candles4h.length >= 24
      ? (() => {
          const { highs, lows } = swings(opts.candles4h, 80)
          return {
            highs: cluster(highs, 'HIGH', price, '4H', 0.0055),
            lows: cluster(lows, 'LOW', price, '4H', 0.0055),
          }
        })()
      : { highs: [], lows: [] }

  const from1d =
    opts.candles1d && opts.candles1d.length >= 20
      ? (() => {
          const { highs, lows } = swings(opts.candles1d, 60)
          return {
            highs: cluster(highs, 'HIGH', price, '1D', 0.007),
            lows: cluster(lows, 'LOW', price, '1D', 0.007),
          }
        })()
      : { highs: [], lows: [] }

  const from1h =
    opts.candles1h && opts.candles1h.length >= 40
      ? (() => {
          const { highs, lows } = swings(opts.candles1h, 70)
          return {
            highs: cluster(highs, 'HIGH', price, '1H', 0.0035),
            lows: cluster(lows, 'LOW', price, '1H', 0.0035),
          }
        })()
      : { highs: [], lows: [] }

  // Seed with Daily, then 4H (Daily wins on near-duplicate)
  const merge = (
    primary: EqualLevel[],
    secondary: EqualLevel[],
    echo: EqualLevel[]
  ): EqualLevel[] => {
    const out: EqualLevel[] = []
    const pushOrBoost = (lvl: EqualLevel) => {
      const hit = out.find((x) => nearPrice(x.price, lvl.price, 0.008))
      if (hit) {
        // Prefer higher TF identity; stack confluence + touches
        hit.touches = Math.max(hit.touches, lvl.touches)
        hit.confluence += 1 + (lvl.tf === '1D' ? 2 : lvl.tf === '4H' ? 1 : 0)
        if (lvl.tf === '1D' || (lvl.tf === '4H' && hit.tf === '1H')) {
          hit.tf = lvl.tf
        }
        if (lvl.strength === 'STRONG') hit.strength = 'STRONG'
        else if (lvl.strength === 'MEDIUM' && hit.strength === 'WEAK') {
          hit.strength = 'MEDIUM'
        }
        // 4H+1D align → force STRONG
        if (hit.confluence >= 2 && hit.tf !== '1H') hit.strength = 'STRONG'
        return
      }
      out.push({ ...lvl })
    }
    for (const l of primary) pushOrBoost(l)
    for (const l of secondary) pushOrBoost(l)
    // 1H echo only boosts existing HTF pools — does not invent new signal zones
    for (const l of echo) {
      const hit = out.find((x) => nearPrice(x.price, l.price, 0.007))
      if (hit && hit.tf !== '1H') {
        hit.confluence += 1
        if (hit.strength === 'MEDIUM' && hit.confluence >= 2) {
          hit.strength = 'STRONG'
        }
      }
    }
    const order = { STRONG: 3, MEDIUM: 2, WEAK: 1 }
    const tfOrder = { '1D': 3, '4H': 2, '1H': 1 }
    return out
      .sort(
        (a, b) =>
          order[b.strength] - order[a.strength] ||
          tfOrder[b.tf] - tfOrder[a.tf] ||
          b.confluence - a.confluence ||
          (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1) ||
          a.distancePct - b.distancePct
      )
      .slice(0, 8)
  }

  const equalHighs = merge(from1d.highs, from4h.highs, from1h.highs)
  const equalLows = merge(from1d.lows, from4h.lows, from1h.lows)

  // Drop pure 1H leftovers (should be none, but guard)
  const htfHighs = equalHighs.filter((l) => l.tf === '4H' || l.tf === '1D')
  const htfLows = equalLows.filter((l) => l.tf === '4H' || l.tf === '1D')

  const nearestBSL =
    htfHighs
      .filter((l) => l.price > price && l.strength !== 'WEAK')
      .sort((a, b) => a.price - b.price)[0] ?? null
  const nearestSSL =
    htfLows
      .filter((l) => l.price < price && l.strength !== 'WEAK')
      .sort((a, b) => b.price - a.price)[0] ?? null

  const boostOf = (level: EqualLevel | null): number => {
    if (!level?.isActive || level.strength === 'WEAK') return 0
    const tfMul = level.tf === '1D' ? 1.35 : level.tf === '4H' ? 1.0 : 0.25
    const strMul =
      level.strength === 'STRONG' ? 1.0 : level.strength === 'MEDIUM' ? 0.55 : 0.15
    const confMul = 1 + Math.min(0.5, level.confluence * 0.15)
    const d = level.distancePct
    let distMul = 0
    if (d < 0.8) distMul = 0.55
    else if (d < 2.0) distMul = 1.0
    else if (d < 4.0) distMul = 0.75
    else if (d < 7.0) distMul = 0.4
    return 2.2 * tfMul * strMul * confMul * distMul
  }

  return {
    equalHighs: htfHighs,
    equalLows: htfLows,
    nearestBSL,
    nearestSSL,
    liquidityBoost: Math.min(
      2.5,
      Math.max(boostOf(nearestBSL), boostOf(nearestSSL))
    ),
    primaryTf: from1d.highs.length || from1d.lows.length ? '1D' : '4H',
  }
}

/** @deprecated use buildHtfLiquidityMap — kept for call-site migration */
export function buildLiquidityMap(
  candles: Candle[],
  price: number
): LiquidityMap {
  // Treat unknown series as 4H only if long enough; otherwise empty (no LTF fake zones)
  if (candles.length >= 24) {
    return buildHtfLiquidityMap({ candles4h: candles, price })
  }
  return {
    equalHighs: [],
    equalLows: [],
    nearestBSL: null,
    nearestSSL: null,
    liquidityBoost: 0,
    primaryTf: '4H',
  }
}

function band(mid: number, pct: number): { top: number; bottom: number } {
  return { top: mid * (1 + pct), bottom: mid * (1 - pct) }
}

function phaseOf(price: number, low: number, high: number): SmartZonePlan['phase'] {
  if (price >= low * 0.998 && price <= high * 1.002) return 'TOUCH'
  const mid = (low + high) / 2
  const dist = Math.abs(price - mid) / price
  // HTF approach window is wider
  if (dist <= 0.008) return 'APPROACH'
  return 'FAR'
}

function numericStrength(level: EqualLevel): number {
  let n = level.tf === '1D' ? 8 : level.tf === '4H' ? 7 : 3
  if (level.strength === 'STRONG') n += 2
  else if (level.strength === 'MEDIUM') n += 0
  else n -= 3
  n += Math.min(2, level.confluence)
  n += Math.min(1, Math.max(0, level.touches - 2) * 0.5)
  return Math.max(1, Math.min(10, Math.round(n)))
}

/**
 * Only MEDIUM+ on 4H/1D. Weak / 1H-only → null (caller must not sell it as a strong zone).
 */
export function findSmartZone(
  side: Side,
  price: number,
  map: LiquidityMap,
  atr: number
): SmartZonePlan | null {
  if (!(price > 0)) return null

  const bandPct = map.primaryTf === '1D' ? 0.0065 : 0.0055

  if (side === 'LONG') {
    const ssl = [...map.equalLows]
      .filter(
        (l) =>
          l.isActive &&
          l.strength !== 'WEAK' &&
          (l.tf === '4H' || l.tf === '1D') &&
          l.price < price * 1.004
      )
      .sort(
        (a, b) =>
          numericStrength(b) - numericStrength(a) ||
          a.distancePct - b.distancePct
      )[0]
    if (!ssl) return null
    // Reject "medium" that is too far — but 4H ×2 touches IS a real pool
    if (ssl.distancePct > 6.5) return null
    if (
      ssl.strength === 'MEDIUM' &&
      ssl.tf === '4H' &&
      ssl.touches < 2
    ) {
      return null
    }
    // Thin medium without any echo only if single touch (shouldn't happen)
    if (
      ssl.strength === 'MEDIUM' &&
      ssl.confluence < 1 &&
      ssl.touches < 2
    ) {
      return null
    }

    const { top, bottom } = band(ssl.price, bandPct)
    const targetLvl = map.nearestBSL
    const target =
      targetLvl && targetLvl.strength !== 'WEAK'
        ? targetLvl.price
        : price + Math.max(atr * 3.2, price * 0.018)
    const targetLabel = targetLvl
      ? `${targetLvl.tf} BSL ×${targetLvl.touches} (${targetLvl.strength}) @ ${targetLvl.price}`
      : `HTF swing/ATR цель @ ${target}`
    const strength = numericStrength(ssl)
    return {
      source: 'SSL',
      side,
      zoneLow: bottom,
      zoneHigh: top,
      mid: ssl.price,
      limitEntry: (bottom + Math.min(ssl.price, top)) / 2,
      invalidate: bottom * 0.992,
      target,
      targetLabel,
      strength,
      touches: ssl.touches,
      distancePct: ((ssl.price - price) / price) * 100,
      phase: phaseOf(price, bottom, top),
      tf: ssl.tf,
      confluence: ssl.confluence,
      reasoning: [
        `HTF зона LONG = ${ssl.tf} SSL ×${ssl.touches} (${ssl.strength}, сила ${strength}/10)`,
        ssl.confluence > 0
          ? `Конфлюенс ×${ssl.confluence} (4H/D/1H echo)`
          : 'Конфлюенс: только один HTF пул',
        `Цель полёта: ${targetLabel}`,
        `Фаза ${phaseOf(price, bottom, top)} · до зоны ${ssl.distancePct.toFixed(2)}%`,
        '15m/скальп — только тайминг реакции, не источник зоны',
      ],
    }
  }

  const bsl = [...map.equalHighs]
    .filter(
      (l) =>
        l.isActive &&
        l.strength !== 'WEAK' &&
        (l.tf === '4H' || l.tf === '1D') &&
        l.price > price * 0.996
    )
    .sort(
      (a, b) =>
        numericStrength(b) - numericStrength(a) ||
        a.distancePct - b.distancePct
    )[0]
  if (!bsl) return null
  if (bsl.distancePct > 6.5) return null
  if (bsl.strength === 'MEDIUM' && bsl.tf === '4H' && bsl.touches < 2) {
    return null
  }
  if (bsl.strength === 'MEDIUM' && bsl.confluence < 1 && bsl.touches < 2) {
    return null
  }

  const { top, bottom } = band(bsl.price, bandPct)
  const targetLvl = map.nearestSSL
  const target =
    targetLvl && targetLvl.strength !== 'WEAK'
      ? targetLvl.price
      : price - Math.max(atr * 3.2, price * 0.018)
  const targetLabel = targetLvl
    ? `${targetLvl.tf} SSL ×${targetLvl.touches} (${targetLvl.strength}) @ ${targetLvl.price}`
    : `HTF swing/ATR цель @ ${target}`
  const strength = numericStrength(bsl)
  return {
    source: 'BSL',
    side,
    zoneLow: bottom,
    zoneHigh: top,
    mid: bsl.price,
    limitEntry: (top + Math.max(bsl.price, bottom)) / 2,
    invalidate: top * 1.008,
    target,
    targetLabel,
    strength,
    touches: bsl.touches,
    distancePct: ((bsl.price - price) / price) * 100,
    phase: phaseOf(price, bottom, top),
    tf: bsl.tf,
    confluence: bsl.confluence,
    reasoning: [
      `HTF зона SHORT = ${bsl.tf} BSL ×${bsl.touches} (${bsl.strength}, сила ${strength}/10)`,
      bsl.confluence > 0
        ? `Конфлюенс ×${bsl.confluence} (4H/D/1H echo)`
        : 'Конфлюенс: только один HTF пул',
      `Цель полёта: ${targetLabel}`,
      `Фаза ${phaseOf(price, bottom, top)} · до зоны ${bsl.distancePct.toFixed(2)}%`,
      '15m/скальп — только тайминг реакции, не источник зоны',
    ],
  }
}

/** LTF reaction timing only — does not define the zone */
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

  let reactionOk = false
  let reactionNote = 'реакции на HTF-зоне ещё нет (ждём 1m reclaim)'
  const recent = opts.candles1m.slice(-12)
  if (recent.length >= 3) {
    for (const c of recent) {
      const [, , high, low, close] = c
      if (opts.side === 'LONG') {
        if (low <= mid * 1.0015 && close > mid * 0.999 && close > low * 1.0012) {
          reactionOk = true
          reactionNote = '1m reclaim после слика HTF SSL — тайминг ок'
          break
        }
      } else if (
        high >= mid * 0.9985 &&
        close < mid * 1.001 &&
        close < high * 0.9988
      ) {
        reactionOk = true
        reactionNote = '1m reject после слика HTF BSL — тайминг ок'
        break
      }
    }
    if (!reactionOk && inside) {
      reactionNote = 'цена в HTF-зоне — ждём закрепление / слабину на 1m'
    }
  }
  if (reactionOk) {
    scoreAdj += 4
    lines.push(`✓ Тайминг: ${reactionNote}`)
  } else {
    lines.push(`· Тайминг: ${reactionNote}`)
  }

  let bookOk = false
  const imb = opts.bookImb
  if (imb == null) {
    lines.push('· Стакан: нет данных')
  } else {
    bookOk =
      (opts.side === 'LONG' && imb >= 14) || (opts.side === 'SHORT' && imb <= -14)
    const against =
      (opts.side === 'LONG' && imb <= -20) || (opts.side === 'SHORT' && imb >= 20)
    if (bookOk) {
      scoreAdj += 5
      lines.push(
        `✓ Топливо стакана: OBI ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}% за сторону`
      )
    } else if (against) {
      scoreAdj -= 6
      lines.push(`✗ Стакан против HTF-зоны: OBI ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}%`)
    } else {
      lines.push(`· Стакан нейтрален: OBI ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}%`)
    }
  }

  const fuelOk = bookOk && (reactionOk || inside)
  const fuelNote = fuelOk
    ? 'топлива хватает до ближайшей HTF-ликвидности'
    : 'топлива мало — не форсировать вход в слабую реакцию'

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

export function zoneProbabilityAdj(
  zone: SmartZonePlan | null,
  fuel: ZoneFuel | null
): { adj: number; factors: string[] } {
  const factors: string[] = []
  let adj = 0
  if (!zone || zone.source === 'ATR') {
    return {
      adj: -4,
      factors: ['−4% нет HTF SSL/BSL 4H+ — сигнал без сильной зоны'],
    }
  }
  if (zone.tf === '1D') {
    adj += 6
    factors.push(`+6% Daily ${zone.source} сила ${zone.strength}/10`)
  } else {
    adj += zone.strength >= 8 ? 5 : zone.strength >= 6 ? 3 : 1
    factors.push(
      `+${zone.strength >= 8 ? 5 : zone.strength >= 6 ? 3 : 1}% 4H ${zone.source} сила ${zone.strength}/10`
    )
  }
  if (zone.confluence >= 2) {
    adj += 3
    factors.push(`+3% конфлюенс HTF ×${zone.confluence}`)
  } else if (zone.confluence >= 1) {
    adj += 1
    factors.push('+1% частичный конфлюенс')
  }
  if (zone.phase === 'APPROACH') {
    adj += 2
    factors.push('+2% подход к HTF-зоне')
  } else if (zone.phase === 'TOUCH') {
    adj += 1
    factors.push('+1% касание HTF-зоны')
  }
  if (fuel) {
    adj += Math.max(-5, Math.min(5, Math.round(fuel.scoreAdj * 0.55)))
    if (fuel.fuelOk) factors.push('+топливо стакана на HTF-зоне')
    else if (fuel.scoreAdj < 0) factors.push('−стакан против HTF-зоны')
  }
  // Hard: weak numeric strength should not look like A+
  if (zone.strength < 6) {
    adj -= 3
    factors.push('−3% зона слабее 6/10 — осторожно')
  }
  return { adj, factors }
}
