import type { OhlcvCandle } from '../../api/mexc'
import { calculateAtr } from '../smc'

export type MarketRegime =
  | 'TRENDING_STRONG'
  | 'TRENDING_WEAK'
  | 'RANGING'
  | 'VOLATILE_CHOP'

/**
 * ATR + simple DI proxy → market regime for ScoreCard gate.
 */
export function detectMarketRegime(
  candles1h: OhlcvCandle[],
  _candles4h?: OhlcvCandle[]
): MarketRegime {
  if (candles1h.length < 20) return 'RANGING'

  const slice = candles1h.slice(-20)
  const atr = calculateAtr(candles1h, 14) ?? 0
  const avgBody =
    slice.reduce((s, c) => s + Math.abs(c[4] - c[1]), 0) / slice.length
  const atrRatio = avgBody > 0 ? atr / avgBody : 1

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
