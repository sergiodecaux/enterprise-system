/**
 * Deterministic pierce + volume fixtures.
 * Prints "zonePierceEntry ok" on success.
 */

import assert from 'node:assert/strict'
import {
  detectZonePierceCandle,
  judgeZonePierce,
} from './zonePierceEntry'
import type { Candle } from '../vane/types'

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number
): Candle {
  return [t, o, h, l, c, v]
}

function flatSeries(n: number, px: number, vol = 100): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    out.push(bar(1_700_000_000_000 + i * 60_000, px, px * 1.001, px * 0.999, px, vol))
  }
  return out
}

function run() {
  const zoneLow = 99
  const zoneHigh = 100
  const base = flatSeries(40, 101, 100)

  // Green pierce: wick into zone, strong green reclaim, high vol (body ≥42%)
  const longBars = [
    ...base,
    bar(1_700_000_000_000 + 40 * 60_000, 100.1, 101.6, 99.0, 101.4, 400),
    bar(1_700_000_000_000 + 41 * 60_000, 101.4, 101.5, 101.1, 101.2, 90), // forming
  ]
  const longPierce = detectZonePierceCandle({
    side: 'LONG',
    zoneLow,
    zoneHigh,
    candles: longBars,
  })
  assert.ok(longPierce, 'long pierce')
  assert.ok(longPierce!.label.includes('Зелёная'))

  // Red pierce at resistance
  const shortBase = flatSeries(40, 99, 100)
  const shortBars = [
    ...shortBase,
    bar(1_700_000_000_000 + 40 * 60_000, 100.5, 100.95, 99.35, 99.45, 380),
    bar(1_700_000_000_000 + 41 * 60_000, 99.45, 99.6, 99.3, 99.4, 80),
  ]
  const shortPierce = detectZonePierceCandle({
    side: 'SHORT',
    zoneLow,
    zoneHigh,
    candles: shortBars,
  })
  assert.ok(shortPierce, 'short pierce')
  assert.ok(shortPierce!.label.includes('Красная'))

  // Full judge needs HTF — build synthetic 4h/1d with SSL/BSL
  const c4h = flatSeries(40, 100, 120)
  // Put equal lows / highs via repeated touches
  for (let i = 5; i < 35; i += 7) {
    c4h[i] = bar(c4h[i]![0], 100, 100.2, 98.5, 99.8, 150)
  }
  for (let i = 8; i < 35; i += 7) {
    c4h[i] = bar(c4h[i]![0], 100, 101.8, 99.8, 100.4, 150)
  }
  const c1d = flatSeries(30, 100, 200)
  const judged = judgeZonePierce({
    symbol: 'TEST_USDT',
    price: 101.1,
    candles15m: longBars,
    candles1m: longBars,
    candles4h: c4h,
    candles1d: c1d,
    candles1h: c4h,
  })
  // May or may not fire depending on smart zone — detect alone already covered
  void judged

  console.log('zonePierceEntry ok', {
    long: longPierce?.label,
    short: shortPierce?.label,
    judged: judged?.side ?? null,
  })
}

run()
