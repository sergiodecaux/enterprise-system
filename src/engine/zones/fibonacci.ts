import type { OhlcvCandle } from '../../api/mexc'
import type { PriceLevel } from '../indicators/types'
import { calculateFibonacciLevels } from '../smc'

/**
 * Fibonacci / OTE levels from swing high/low of visible candles
 */
export function calculateFibPriceLevels(candles: OhlcvCandle[]): PriceLevel[] {
  if (candles.length < 20) return []

  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const high = Math.max(...highs)
  const low = Math.min(...lows)
  if (high <= low) return []

  const lastClose = candles[candles.length - 1][4]
  const mid = (high + low) / 2
  const direction: 'UP' | 'DOWN' = lastClose >= mid ? 'UP' : 'DOWN'

  const fibLevels = calculateFibonacciLevels(high, low, direction)

  return [
    {
      id: 'fib_618',
      type: 'FIB_618',
      price: fibLevels['0.618'],
      label: '0.618',
      color: 'rgba(100, 200, 255, 0.6)',
      lineStyle: 2,
    },
    {
      id: 'fib_786',
      type: 'FIB_786',
      price: fibLevels['0.786'],
      label: '0.786',
      color: 'rgba(100, 200, 255, 0.5)',
      lineStyle: 2,
    },
    {
      id: 'fib_ote_top',
      type: 'FIB_OTE',
      price: fibLevels.ote_top,
      label: 'OTE Top',
      color: 'rgba(255, 165, 0, 0.6)',
      lineStyle: 1,
    },
    {
      id: 'fib_ote_bottom',
      type: 'FIB_OTE',
      price: fibLevels.ote_bottom,
      label: 'OTE Bottom',
      color: 'rgba(255, 165, 0, 0.6)',
      lineStyle: 1,
    },
  ]
}
