/**
 * Deterministic bounce composer smoke test.
 * Prints "findBounceSetups ok" on success.
 */

import { findBounceSetups } from './findBounceSetups'
import type { OhlcvCandle } from '../../api/mexc'

function candle(
  i: number,
  close: number,
  low = close * 0.998,
  high = close * 1.002
): OhlcvCandle {
  const t = 1_700_000_000_000 + i * 60_000
  return [t, close, high, low, close, 1000]
}

function run() {
  const price = 100
  const candles: OhlcvCandle[] = []
  // Flat tape with equal lows around 98 and equal highs around 102
  for (let i = 0; i < 80; i++) {
    const c = 100 + Math.sin(i / 7) * 0.4
    const touchedLow = i % 11 === 0
    const touchedHigh = i % 13 === 0
    candles.push(
      candle(
        i,
        c,
        touchedLow ? 98 : c * 0.999,
        touchedHigh ? 102 : c * 1.001
      )
    )
  }

  const result = findBounceSetups({
    candles,
    symbol: 'TEST_USDT',
    flatSymbol: 'TESTUSDT',
    price,
    atr: 0.5,
    tradeStyle: 'INTRADAY',
  })

  if (!Array.isArray(result.zones) || !Array.isArray(result.arrows)) {
    throw new Error('bad shape')
  }
  for (const a of result.arrows) {
    if (!(a.from > 0) || !(a.to > 0)) throw new Error('bad arrow')
    if (a.side === 'LONG' && a.to <= a.from) throw new Error('long target')
    if (a.side === 'SHORT' && a.to >= a.from) throw new Error('short target')
  }
  for (const lim of result.limits) {
    if (!(lim.price > 0)) throw new Error('bad limit')
  }

  console.log('findBounceSetups ok', {
    zones: result.zones.length,
    limits: result.limits.length,
    arrows: result.arrows.length,
    setups: result.setups.length,
  })
}

run()
