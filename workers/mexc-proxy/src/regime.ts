/**
 * Lightweight BTC/market regime for cron scanner (mirrors app marketRegime.ts).
 */

export type MarketRegime =
  | 'TRENDING_STRONG'
  | 'TRENDING_WEAK'
  | 'RANGING'
  | 'VOLATILE_CHOP'

type Candle = [number, number, number, number, number, number]

function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    sum += Math.max(
      c[2] - c[3],
      Math.abs(c[2] - prev[4]),
      Math.abs(c[3] - prev[4])
    )
  }
  return sum / period
}

export function detectMarketRegime(candles1h: Candle[]): MarketRegime {
  if (candles1h.length < 20) return 'RANGING'

  const slice = candles1h.slice(-20)
  const atrVal = atr(candles1h, 14)
  const avgBody =
    slice.reduce((s, c) => s + Math.abs(c[4] - c[1]), 0) / slice.length
  const atrRatio = avgBody > 0 ? atrVal / avgBody : 1

  const window = candles1h.slice(-15)
  const highs = window.map((c) => c[2])
  const lows = window.map((c) => c[3])

  const highMoves: number[] = []
  const lowMoves: number[] = []
  for (let i = 1; i < highs.length; i++) {
    highMoves.push(highs[i] - highs[i - 1])
    lowMoves.push(lows[i - 1] - lows[i])
  }

  let plusSum = 0
  let minusSum = 0
  for (let i = 0; i < highMoves.length; i++) {
    const h = highMoves[i]
    const l = lowMoves[i]
    if (h > l && h > 0) plusSum += h
    if (l > h && l > 0) minusSum += l
  }
  const n = highMoves.length || 1
  const plusDI = plusSum / n
  const minusDI = minusSum / n
  const total = plusDI + minusDI
  const adxProxy = total > 0 ? (Math.abs(plusDI - minusDI) / total) * 100 : 0

  if (adxProxy > 30 && atrRatio < 3) return 'TRENDING_STRONG'
  if (adxProxy > 20) return 'TRENDING_WEAK'
  if (atrRatio > 3) return 'VOLATILE_CHOP'
  return 'RANGING'
}

/** Regime policy — allow SCALP/INTRA × TREND/COUNTER with score floors, not hard silence */
export function regimeAllows(
  regime: MarketRegime,
  style: 'SCALP' | 'INTRADAY' | 'SWING',
  align: 'WITH_TREND' | 'COUNTER',
  score: number,
  /** Memes: allow more scalps in range/chop — otherwise almost never emit */
  softForMeme = false
): { ok: boolean; reason?: string; scoreAdj: number } {
  let scoreAdj = score

  if (regime === 'VOLATILE_CHOP') {
    // Scalp still allowed if score is solid; counter needs more
    if (style === 'SCALP' && score < (softForMeme ? 76 : 82)) {
      return { ok: false, reason: 'regime:chop_weak_scalp', scoreAdj }
    }
    if (align === 'COUNTER' && score < (softForMeme ? 80 : 86)) {
      return { ok: false, reason: 'regime:chop_weak_counter', scoreAdj }
    }
    scoreAdj += softForMeme ? 1 : 2
  }

  if (regime === 'RANGING') {
    if (style === 'SCALP' && align === 'COUNTER' && score < (softForMeme ? 80 : 86)) {
      return { ok: false, reason: 'regime:range_weak_scalp_counter', scoreAdj }
    }
    if (style === 'SCALP' && score < (softForMeme ? 74 : 80)) {
      return { ok: false, reason: 'regime:range_weak_scalp', scoreAdj }
    }
    if (align === 'COUNTER' && score < (softForMeme ? 78 : 84)) {
      return { ok: false, reason: 'regime:range_weak_counter', scoreAdj }
    }
    // Mean-reversion friendly for intraday counter when score clears floor
    if (align === 'COUNTER' && style === 'INTRADAY') {
      scoreAdj = Math.min(99, scoreAdj + 2)
    }
  }

  if (regime === 'TRENDING_STRONG' && align === 'WITH_TREND') {
    scoreAdj = Math.min(99, scoreAdj + 3)
  }
  if (regime === 'TRENDING_STRONG' && align === 'COUNTER' && score < (softForMeme ? 82 : 88)) {
    return { ok: false, reason: 'regime:strong_trend_blocks_weak_counter', scoreAdj }
  }
  if (regime === 'TRENDING_WEAK' && align === 'WITH_TREND') {
    scoreAdj = Math.min(99, scoreAdj + 1)
  }

  return { ok: true, scoreAdj }
}
