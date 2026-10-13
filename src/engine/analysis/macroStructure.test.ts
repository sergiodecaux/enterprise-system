import assert from 'node:assert/strict'
import {
  MACRO_MIN_SAMPLES,
  deriveMacroStructure,
  readIndexStructure,
} from './macroStructure'

// Deterministic shaped series — we test the classification math, not markets.
const rising = Array.from({ length: 30 }, (_, i) => 100 + i) // steady up
const falling = Array.from({ length: 30 }, (_, i) => 160 - i) // steady down
const flat = Array.from({ length: 30 }, (_, i) => 100 + (i % 2)) // oscillate ±1

// Rising series → UP trend, last sits near the top of its range.
const up = readIndexStructure('TOTAL3', rising)
assert.equal(up.trend, 'UP')
assert.equal(up.location, 'HIGH')
assert.equal(up.samples, 30)
assert.equal((up.changePct ?? 0) > 0, true)

// Falling series → DOWN trend, last near the bottom.
const down = readIndexStructure('BTC.D', falling)
assert.equal(down.trend, 'DOWN')
assert.equal(down.location, 'LOW')

// Flat oscillation → RANGE.
const range = readIndexStructure('OTHERS', flat)
assert.equal(range.trend, 'RANGE')

// Too few points → NA, honest "not enough data".
const scarce = readIndexStructure('OTHERS', [100, 101, 102])
assert.equal(scarce.trend, 'NA')
assert.equal(scarce.location, 'NA')
assert.equal(scarce.samples < MACRO_MIN_SAMPLES, true)

// BTC.D down + TOTAL3 up + OTHERS up → tailwind for alts, positive tilt.
const tail = deriveMacroStructure({ btcD: falling, total3: rising, others: rising })
assert.equal(tail.bias, 'TAILWIND')
assert.equal(tail.altTilt > 0, true)

// BTC.D up + TOTAL3 down + OTHERS down → headwind, negative tilt.
const head = deriveMacroStructure({ btcD: rising, total3: falling, others: falling })
assert.equal(head.bias, 'HEADWIND')
assert.equal(head.altTilt < 0, true)

// No data at all → NA, zero tilt (never fabricate a lean).
const none = deriveMacroStructure({ btcD: null, total3: null, others: [100, 101] })
assert.equal(none.bias, 'NA')
assert.equal(none.altTilt, 0)

console.log('macroStructure read ok')
