import type { OhlcvCandle } from '../../api/mexc'

export interface ToxicResult {
  detected: boolean
  wickRatio: number
  entryBlocked: boolean
  scorePenalty: number
  label: string
  emoji: string
}

/**
 * Shredder / Wick-to-Body: тени >70% на последних 20 свечах 1m → TOXIC.
 */
export function detectToxicChop(ohlcv1m: OhlcvCandle[]): ToxicResult {
  const empty: ToxicResult = {
    detected: false,
    wickRatio: 0,
    entryBlocked: false,
    scorePenalty: 0,
    label: '',
    emoji: '',
  }

  if (ohlcv1m.length < 20) return empty

  const window = ohlcv1m.slice(-20)
  let wickSum = 0
  let rangeSum = 0

  for (const c of window) {
    const [, open, high, low, close] = c
    const range = high - low
    if (range <= 0) continue
    const body = Math.abs(close - open)
    const wicks = range - body
    wickSum += wicks
    rangeSum += range
  }

  if (rangeSum <= 0) return empty
  const wickRatio = wickSum / rangeSum

  if (wickRatio >= 0.7) {
    return {
      detected: true,
      wickRatio,
      entryBlocked: true,
      scorePenalty: 50,
      emoji: '☠️',
      label: `TOXIC / CHOP | wick ${(wickRatio * 100).toFixed(0)}% — пила убивает депозит`,
    }
  }

  return { ...empty, wickRatio }
}
