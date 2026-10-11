import assert from 'node:assert/strict'
import { OI_BAR_MS, pickHoldVolBefore } from './oiLog'

const ts = 1_000_000_000_000
const hour = OI_BAR_MS
const before = pickHoldVolBefore(
  [
    { ts: ts - 15 * 60_000, holdVol: 1 },
    { ts: ts - 4 * hour, holdVol: 10 },
    { ts: ts - 8 * hour, holdVol: 7 },
  ],
  ts
)
assert.equal(before?.holdVol, 10)
assert.equal(pickHoldVolBefore([{ ts: ts - 15 * 60_000, holdVol: 1 }], ts), null)
console.log('oi log ok')
