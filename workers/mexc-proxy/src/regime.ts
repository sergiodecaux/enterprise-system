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

/** Regime policy for scanner emit */
export function regimeAllows(
  regime: MarketRegime,
  style: 'SCALP' | 'INTRADAY' | 'SWING',
  align: 'WITH_TREND' | 'COUNTER',
  score: number
): { ok: boolean; reason?: string; scoreAdj: number } {
  let scoreAdj = score

  if (regime === 'VOLATILE_CHOP') {
    if (style === 'SCALP') {
      return { ok: false, reason: 'regime:chop_blocks_scalp', scoreAdj }
    }
    if (align === 'COUNTER' && score < 90) {
      return { ok: false, reason: 'regime:chop_blocks_counter', scoreAdj }
    }
    scoreAdj += 4 // need stronger confluence to clear 60% later
  }

  if (regime === 'RANGING') {
    if (style === 'SCALP' && align === 'COUNTER') {
      return { ok: false, reason: 'regime:range_blocks_scalp_counter', scoreAdj }
    }
    if (style === 'SCALP' && score < 86) {
      return { ok: false, reason: 'regime:range_tight_scalp', scoreAdj }
    }
    if (align === 'COUNTER' && score < 88) {
      return { ok: false, reason: 'regime:range_blocks_weak_counter', scoreAdj }
    }
  }

  if (regime === 'TRENDING_STRONG' && align === 'WITH_TREND') {
    scoreAdj = Math.min(99, scoreAdj + 3)
  }

  return { ok: true, scoreAdj }
}
