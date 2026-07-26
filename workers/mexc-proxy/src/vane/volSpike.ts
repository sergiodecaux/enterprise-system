import { atr } from './mexc'
import type { Candle } from './types'

/** Pause entries when 1m ATR spikes > 3× recent day average */
export function volSpikePause(candles1m: Candle[]): {
  pause: boolean
  atr1m: number
  dayAvg: number
  ratio: number
  reason?: string
} {
  if (candles1m.length < 40) {
    return { pause: false, atr1m: 0, dayAvg: 0, ratio: 0 }
  }
  const atr1m = atr(candles1m, 8)
  const daySlice = candles1m.slice(-120)
  let sum = 0
  let n = 0
  for (let i = 14; i < daySlice.length; i++) {
    const c = daySlice[i]!
    const prev = daySlice[i - 1]!
    sum += Math.max(
      c[2] - c[3],
      Math.abs(c[2] - prev[4]),
      Math.abs(c[3] - prev[4])
    )
    n++
  }
  const dayAvg = n > 0 ? sum / n : 0
  const ratio = dayAvg > 0 ? atr1m / dayAvg : 0
  if (ratio >= 3) {
    return {
      pause: true,
      atr1m,
      dayAvg,
      ratio,
      reason: `vol spike ATR1m ×${ratio.toFixed(1)} vs day — пауза`,
    }
  }
  return { pause: false, atr1m, dayAvg, ratio }
}
