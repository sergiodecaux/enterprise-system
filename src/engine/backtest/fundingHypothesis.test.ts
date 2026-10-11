import assert from 'node:assert/strict'
import { FUNDING_CELLS, FUNDING_HORIZONS_H, FUNDING_P_HI, FUNDING_P_LO, FUNDING_WINDOW } from './config'
import { cellKey, fadeHit, fundingTail, percentileType7 } from './fundingHypothesis'

assert.deepEqual([...FUNDING_HORIZONS_H], [8, 24])
assert.equal(FUNDING_P_LO, 10)
assert.equal(FUNDING_P_HI, 90)
assert.equal(FUNDING_WINDOW, 90)
assert.deepEqual([...FUNDING_CELLS], ['high_pos|8h', 'low_neg|8h', 'high_pos|24h', 'low_neg|24h'])

const flat = Array.from({ length: 90 }, (_, i) => i / 1000)
assert.equal(percentileType7(flat, 10) > flat[0]!, true)
assert.equal(fundingTail(flat[45]!, flat), null)
assert.equal(fundingTail(1, flat), 'high_pos')
assert.equal(fundingTail(-0.05, Array.from({ length: 90 }, () => -0.0001)), 'low_neg')
assert.equal(fundingTail(0.00001, Array.from({ length: 89 }, () => 0.01)), null)
assert.equal(fadeHit('high_pos', -0.01), 'hit')
assert.equal(fadeHit('high_pos', 0.01), 'invalidated')
assert.equal(fadeHit('low_neg', 0), 'undecided')
assert.equal(cellKey('high_pos', 8), 'high_pos|8h')
assert.throws(() => cellKey('high_pos', 4))

console.log('funding hypothesis lock ok')
