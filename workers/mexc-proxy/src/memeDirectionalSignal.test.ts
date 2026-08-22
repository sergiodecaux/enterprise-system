import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inspectMemeCandleDirections,
  movementPhase,
  patternTier,
  tailBlocked,
} from './memeDirectionalSignal'
import type { Candle } from './peakFuelFail'

function candle(
  index: number,
  open: number,
  close: number,
  volume: number,
  highPad = 0.002,
  lowPad = 0.002
): Candle {
  return [
    1_700_000_000_000 + index * 60_000,
    open,
    Math.max(open, close) + highPad,
    Math.min(open, close) - lowPad,
    close,
    volume,
  ]
}

test('classifies quiet price with rising volume as accumulation', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 36; index++) {
    const recent = index >= 31
    candles.push(
      candle(
        index,
        1 + (index % 2) * 0.0003,
        1 + ((index + 1) % 2) * 0.0003,
        recent ? 160 : 100,
        0.01,
        0.01
      )
    )
  }
  assert.equal(movementPhase(candles), 'ACCUMULATION')
})

test('classifies a high-location move with fading volume as extension', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 46; index++) {
    const open = 1 + index * 0.004
    candles.push(candle(index, open, open + 0.003, index >= 41 ? 45 : 100))
  }
  assert.equal(movementPhase(candles), 'EXTENSION_UP')
})

test('classifies a balanced bounded market as range', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 46; index++) {
    const open =
      index >= 40 ? 1.008 : index % 2 === 0 ? 1.004 : 1.012
    const close =
      index >= 40 ? 1.008 : index % 2 === 0 ? 1.012 : 1.004
    candles.push(candle(index, open, close, 100, 0.004, 0.004))
  }
  assert.equal(movementPhase(candles), 'RANGE')
})

test('nominates a short after rejection from the top of a range', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 42; index++) {
    const open = index % 2 === 0 ? 1.003 : 1.014
    const close = index % 2 === 0 ? 1.014 : 1.003
    candles.push(candle(index, open, close, 100, 0.003, 0.003))
  }
  candles.push(candle(42, 1.012, 1.017, 100, 0.003, 0.003))
  candles.push([
    1_700_000_000_000 + 43 * 60_000,
    1.018,
    1.025,
    1.015,
    1.016,
    100,
  ])
  const short = inspectMemeCandleDirections(candles, 0).find(
    (candidate) => candidate.side === 'SHORT'
  )
  assert.ok(short)
  assert.ok(short.patterns.includes('range_high_reject'))
})

test('blocks a long after an oversized two-hour tail', () => {
  const candles: Candle[] = []
  for (let index = 0; index < 121; index++) {
    const open = 1 + index * 0.0017
    candles.push(candle(index, open, open + 0.001, 100))
  }
  assert.equal(tailBlocked(candles, 'LONG'), true)
})

test('assigns candlestick pattern tiers', () => {
  assert.equal(patternTier(['failed_breakdown']), 'S')
  assert.equal(patternTier(['higher_low']), 'A')
  assert.equal(patternTier(['volume_expansion']), 'B')
})
