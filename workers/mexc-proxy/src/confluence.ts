/**
 * Portable Mini App confluence for the Worker bot:
 * Order Blocks, FVG, liquidity raid, absorption + lightweight ScoreCard.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'
type Style = 'SCALP' | 'INTRADAY' | 'SWING'
type Bias = 'BULL' | 'BEAR' | 'FLAT'
type Regime =
  | 'TRENDING_STRONG'
  | 'TRENDING_WEAK'
  | 'RANGING'
  | 'VOLATILE_CHOP'

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  strength: number
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
}

export interface RaidResult {
  detected: boolean
  type: 'BULL_SWEEP' | 'BEAR_SWEEP' | 'NONE'
  label: string
  scoreBoost: number
}

export interface AbsorptionResult {
  detected: boolean
  label: string
  scoreBoost: number
  sideHint: Side | null
}

export type ScoreGrade = 'A+' | 'A' | 'B' | 'SKIP'

export interface BotScoreCard {
  grade: ScoreGrade
  ready: boolean
  total: number
  max: number
  percent: number
  factors: string[]
  missing: string[]
}

export function findOrderBlocks(candles: Candle[], maxBlocks = 4): OrderBlock[] {
  if (candles.length < 20) return []
  const opens = candles.map((c) => c[1])
  const closes = candles.map((c) => c[4])
  const volumes = candles.map((c) => c[5])
  const out: OrderBlock[] = []

  for (let i = 2; i < candles.length - 3; i++) {
    const body = Math.abs(closes[i] - opens[i])
    if (!(body > 0)) continue
    let avg = 0
    const n = Math.min(10, i)
    for (let k = 0; k < n; k++) {
      avg += Math.abs(closes[i - n + k] - opens[i - n + k])
    }
    avg /= n || 1
    if (!(avg > 0)) continue

    const isRed = closes[i] < opens[i]
    const isGreen = closes[i] > opens[i]
    const top = Math.max(opens[i], closes[i])
    const bottom = Math.min(opens[i], closes[i])

    if (isRed) {
      let impulseUp = 0
      for (let j = 1; j < Math.min(4, candles.length - i); j++) {
        impulseUp += Math.max(0, closes[i + j] - opens[i + j])
      }
      if (impulseUp > avg * 2.5) {
        let valid = true
        for (let k = i + 1; k < candles.length; k++) {
          if (closes[k] < bottom) {
            valid = false
            break
          }
        }
        if (valid) {
          out.push({
            type: 'BULLISH',
            top,
            bottom,
            strength: Math.min(10, Math.floor(impulseUp / avg)),
          })
        }
      }
    }

    if (isGreen) {
      let impulseDown = 0
      for (let j = 1; j < Math.min(4, candles.length - i); j++) {
        impulseDown += Math.max(0, opens[i + j] - closes[i + j])
      }
      if (impulseDown > avg * 2.5) {
        let valid = true
        for (let k = i + 1; k < candles.length; k++) {
          if (closes[k] > top) {
            valid = false
            break
          }
        }
        if (valid) {
          out.push({
            type: 'BEARISH',
            top,
            bottom,
            strength: Math.min(10, Math.floor(impulseDown / avg)),
          })
        }
      }
    }
  }

  return out.sort((a, b) => b.strength - a.strength).slice(0, maxBlocks)
}

export function findFvg(candles: Candle[], maxGaps = 4): FairValueGap[] {
  if (candles.length < 5) return []
  const out: FairValueGap[] = []
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1]
    const next = candles[i + 1]
    // Bullish FVG: gap up (prev high < next low)
    if (prev[2] < next[3]) {
      out.push({ type: 'BULLISH', top: next[3], bottom: prev[2] })
    }
    // Bearish FVG: gap down (prev low > next high)
    if (prev[3] > next[2]) {
      out.push({ type: 'BEARISH', top: prev[3], bottom: next[2] })
    }
  }
  return out.slice(-maxGaps)
}

export function priceInBand(
  price: number,
  top: number,
  bottom: number,
  pad = 0.0015
): boolean {
  const hi = Math.max(top, bottom) * (1 + pad)
  const lo = Math.min(top, bottom) * (1 - pad)
  return price >= lo && price <= hi
}

export function detectLiquidityRaid(
  candles: Candle[],
  side: Side,
  lookback = 20,
  freshness = 5
): RaidResult {
  const none: RaidResult = {
    detected: false,
    type: 'NONE',
    label: 'raid: нет',
    scoreBoost: 0,
  }
  if (candles.length < 10) return none
  const slice = candles.slice(-Math.min(lookback + 5, candles.length))
  const highs = slice.map((c) => c[2])
  const lows = slice.map((c) => c[3])
  const closes = slice.map((c) => c[4])
  const last = slice.length - 1

  if (side === 'LONG') {
    for (let i = last; i >= Math.max(1, last - freshness); i--) {
      let localLow = Infinity
      for (let j = Math.max(0, i - lookback); j < i; j++) {
        localLow = Math.min(localLow, lows[j])
      }
      if (!(localLow < Infinity)) continue
      if (lows[i] < localLow && closes[i] > localLow) {
        const ago = last - i
        return {
          detected: true,
          type: 'BULL_SWEEP',
          label: `🎯 SSL raid @ ${localLow} (${ago} бар назад)`,
          scoreBoost: ago <= freshness ? 2 : 0.5,
        }
      }
    }
  } else {
    for (let i = last; i >= Math.max(1, last - freshness); i--) {
      let localHigh = -Infinity
      for (let j = Math.max(0, i - lookback); j < i; j++) {
        localHigh = Math.max(localHigh, highs[j])
      }
      if (!(localHigh > -Infinity)) continue
      if (highs[i] > localHigh && closes[i] < localHigh) {
        const ago = last - i
        return {
          detected: true,
          type: 'BEAR_SWEEP',
          label: `🎯 BSL raid @ ${localHigh} (${ago} бар назад)`,
          scoreBoost: ago <= freshness ? 2 : 0.5,
        }
      }
    }
  }
  return none
}

export function detectAbsorption(candles: Candle[], lookback = 10): AbsorptionResult {
  const empty: AbsorptionResult = {
    detected: false,
    label: 'absorption: нет',
    scoreBoost: 0,
    sideHint: null,
  }
  if (candles.length < lookback + 20) return empty

  let avgVol = 0
  const baseStart = candles.length - lookback - 20
  for (let i = baseStart; i < candles.length - lookback; i++) {
    avgVol += candles[i][5]
  }
  avgVol /= 20
  if (!(avgVol > 0)) return empty

  let best = empty
  for (let i = candles.length - lookback; i < candles.length; i++) {
    const [, o, h, l, c, v] = candles[i]
    const range = h - l
    if (!(range > 0)) continue
    const body = Math.abs(c - o)
    const bodyRatio = body / range
    const lowerWick = (Math.min(o, c) - l) / range
    const upperWick = (h - Math.max(o, c)) / range
    const mult = v / avgVol
    if (mult < 2.5 || bodyRatio > 0.35) continue

    if (lowerWick >= 0.45 && mult > (best.scoreBoost || 0)) {
      best = {
        detected: true,
        label: `Поглощение лонг ×${mult.toFixed(1)} (нижний фитиль)`,
        scoreBoost: 2,
        sideHint: 'LONG',
      }
    }
    if (upperWick >= 0.45 && mult > (best.scoreBoost || 0)) {
      best = {
        detected: true,
        label: `Поглощение шорт ×${mult.toFixed(1)} (верхний фитиль)`,
        scoreBoost: 2,
        sideHint: 'SHORT',
      }
    }
  }
  return best
}

function gradeOf(total: number, style: Style): ScoreGrade {
  const t =
    style === 'SCALP'
      ? { ap: 11, a: 9, b: 7 }
      : style === 'SWING'
        ? { ap: 9, a: 7, b: 5 }
        : { ap: 10, a: 8, b: 6 }
  if (total >= t.ap) return 'A+'
  if (total >= t.a) return 'A'
  if (total >= t.b) return 'B'
  return 'SKIP'
}

/**
 * Worker ScoreCard — same 12-pt spirit as Mini App, using available bot inputs.
 */
export function buildBotScoreCard(opts: {
  side: Side
  style: Style
  bias4h: Bias
  bias1h: Bias
  align: 'WITH_TREND' | 'COUNTER'
  regime: Regime
  bookImb: number | null
  raid: RaidResult
  absorption: AbsorptionResult
  inOrderBlock: boolean
  inFvg: boolean
  hasHtfZone: boolean
  zoneStrength: number
  entry: number
  sl: number
  tp: number
  toxicBook: boolean
}): BotScoreCard {
  const factors: string[] = []
  const missing: string[] = []
  let total = 0
  const max = 12

  if (opts.toxicBook) {
    return {
      grade: 'SKIP',
      ready: false,
      total: 0,
      max,
      percent: 0,
      factors: ['❌ Spoof/toxic book — SKIP'],
      missing: ['чистый стакан'],
    }
  }

  // 1. HTF structure 0–2
  const a4 =
    (opts.side === 'LONG' && opts.bias4h === 'BULL') ||
    (opts.side === 'SHORT' && opts.bias4h === 'BEAR')
  const a1 =
    (opts.side === 'LONG' && opts.bias1h === 'BULL') ||
    (opts.side === 'SHORT' && opts.bias1h === 'BEAR')
  let htf = 0
  if (a4 && a1) {
    htf = 2
    factors.push('✅ HTF 4H+1H aligned')
  } else if (a4 || a1) {
    htf = 1
    factors.push(a4 ? '⚠️ только 4H aligned' : '⚠️ только 1H aligned')
  } else {
    factors.push(
      opts.align === 'COUNTER' ? '⚠️ HTF counter (нужен raid/OB)' : '❌ HTF against'
    )
    if (opts.align !== 'COUNTER') missing.push('HTF alignment')
  }
  total += htf

  // 2. Book / MM proxy 0–2
  let book = 0
  if (opts.bookImb != null) {
    const aligned =
      (opts.side === 'LONG' && opts.bookImb >= 18) ||
      (opts.side === 'SHORT' && opts.bookImb <= -18)
    const soft =
      (opts.side === 'LONG' && opts.bookImb >= 8) ||
      (opts.side === 'SHORT' && opts.bookImb <= -8)
    if (aligned) {
      book = 2
      factors.push(`✅ OBI за вход (${opts.bookImb.toFixed(0)}%)`)
    } else if (soft) {
      book = 1
      factors.push(`⚠️ OBI слабо за (${opts.bookImb.toFixed(0)}%)`)
    } else {
      factors.push(`❌ OBI не за сторону (${opts.bookImb.toFixed(0)}%)`)
      missing.push('стакан')
    }
  } else {
    factors.push('⚠️ OBI нет данных')
  }
  total += book

  // 3. Orderflow proxy 0–2 (absorption)
  let flow = 0
  if (
    opts.absorption.detected &&
    (opts.absorption.sideHint == null || opts.absorption.sideHint === opts.side)
  ) {
    flow = 2
    factors.push(`✅ ${opts.absorption.label}`)
  } else if (opts.absorption.detected) {
    flow = 0
    factors.push(`❌ absorption против стороны`)
    missing.push('absorption')
  } else {
    factors.push('⚠️ absorption нет')
  }
  total += flow

  // 4. Liquidity sweep 0–1
  if (opts.raid.detected) {
    total += 1
    factors.push(`✅ ${opts.raid.label}`)
  } else {
    factors.push('⚠️ raid нет')
    missing.push('liquidity raid')
  }

  // 5. OB / FVG entry 0–1
  if (opts.inOrderBlock || opts.inFvg) {
    total += 1
    factors.push(
      opts.inOrderBlock && opts.inFvg
        ? '✅ в OB + FVG'
        : opts.inOrderBlock
          ? '✅ в Order Block'
          : '✅ в FVG'
    )
  } else {
    factors.push('⚠️ вне OB/FVG')
    missing.push('OB/FVG')
  }

  // 6. HTF zone quality 0–1
  if (opts.hasHtfZone && opts.zoneStrength >= 6) {
    total += 1
    factors.push(`✅ HTF зона сила ${opts.zoneStrength}/10`)
  } else if (opts.hasHtfZone) {
    factors.push(`⚠️ HTF зона слабая ${opts.zoneStrength}/10`)
  } else {
    factors.push('❌ нет HTF SSL/BSL')
    missing.push('HTF zone')
  }

  // 7. Regime 0–1
  if (
    (opts.regime === 'TRENDING_STRONG' || opts.regime === 'TRENDING_WEAK') &&
    opts.align === 'WITH_TREND'
  ) {
    total += 1
    factors.push(`✅ режим ${opts.regime} + trend`)
  } else if (opts.regime === 'RANGING' && opts.align === 'COUNTER') {
    total += 1
    factors.push('✅ range + mean-reversion')
  } else if (opts.regime === 'VOLATILE_CHOP') {
    factors.push('❌ VOLATILE_CHOP')
    missing.push('режим')
  } else {
    factors.push(`⚠️ режим ${opts.regime}`)
  }

  // 8. R:R 0–1
  const risk = Math.abs(opts.entry - opts.sl)
  const reward = Math.abs(opts.tp - opts.entry)
  const rr = risk > 0 ? reward / risk : 0
  if (rr >= 1.8) {
    total += 1
    factors.push(`✅ R:R 1:${rr.toFixed(1)}`)
  } else if (rr >= 1.2) {
    factors.push(`⚠️ R:R 1:${rr.toFixed(1)}`)
  } else {
    factors.push(`❌ R:R 1:${rr.toFixed(1)}`)
    missing.push('R:R')
  }

  const grade = gradeOf(total, opts.style)
  return {
    grade,
    ready: grade === 'A+' || grade === 'A',
    total,
    max,
    percent: Math.round((total / max) * 100),
    factors,
    missing: [...new Set(missing)],
  }
}

/** Analyze HTF candles for confluence around price/side */
export function analyzeConfluence(opts: {
  candles4h: Candle[]
  candles1m: Candle[]
  side: Side
  price: number
}): {
  inOrderBlock: boolean
  inFvg: boolean
  raid: RaidResult
  absorption: AbsorptionResult
  lines: string[]
} {
  const obs = findOrderBlocks(opts.candles4h, 5)
  const fvgs = findFvg(opts.candles4h, 5)
  const wantOb = opts.side === 'LONG' ? 'BULLISH' : 'BEARISH'
  const inOrderBlock = obs.some(
    (ob) =>
      ob.type === wantOb && priceInBand(opts.price, ob.top, ob.bottom, 0.002)
  )
  const inFvg = fvgs.some(
    (f) =>
      f.type === wantOb && priceInBand(opts.price, f.top, f.bottom, 0.002)
  )
  const raid = detectLiquidityRaid(opts.candles1m, opts.side)
  const absorption = detectAbsorption(opts.candles1m)
  const lines = [
    inOrderBlock ? `OB ${wantOb} активен` : 'OB: цена вне блока',
    inFvg ? `FVG ${wantOb} активен` : 'FVG: нет/вне',
    raid.label,
    absorption.label,
  ]
  return { inOrderBlock, inFvg, raid, absorption, lines }
}
