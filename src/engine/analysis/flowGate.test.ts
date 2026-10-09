import assert from 'node:assert/strict'
import type { OhlcvCandle } from '../../api/mexc'
import { oiCaseOf, readFlow } from './flowGate'
import { measureSessionWalk } from './sessionWalk'

function bar(ms: number, open: number, high: number, low: number, close: number, vol = 100): OhlcvCandle {
  return [ms, open, high, low, close, vol]
}

assert.equal(oiCaseOf(0.4, 0.6), 'NEW_LONGS')
assert.equal(oiCaseOf(-0.4, 0.6), 'NEW_SHORTS')
assert.equal(oiCaseOf(0.4, -0.6), 'SHORT_COVER')
assert.equal(oiCaseOf(-0.4, -0.6), 'LONG_EXIT')

const quiet: OhlcvCandle[] = []
for (let i = 0; i < 20; i++) quiet.push(bar(i * 900_000, 100, 101, 99, 100.4, 100))
quiet.push(bar(20 * 900_000, 100, 110, 99, 109, 40))
const dead = readFlow({
  book: 'BTC',
  side: 'LONG',
  trigger: 'ACCEPT',
  structural: true,
  candles15m: quiet,
  price: 109,
})
assert.equal(dead.verdict, 'VETO')
assert.match(dead.clause, /пустая/)

const alive: OhlcvCandle[] = []
for (let i = 0; i < 20; i++) alive.push(bar(i * 900_000, 100, 101, 99, 100.2, 100))
alive.push(bar(20 * 900_000, 100, 110, 99, 109, 180))
const go = readFlow({
  book: 'COMMODITY',
  side: 'LONG',
  trigger: 'ACCEPT',
  structural: true,
  candles15m: alive,
  price: 109,
  crowd: { longShortRatio: 3, known: true },
})
assert.equal(go.verdict, 'CONFIRM')
assert.equal(go.confidenceDelta >= 0, true)
assert.equal(go.clause.includes('счета'), false)

const exitShort = readFlow({
  book: 'BTC',
  side: 'SHORT',
  trigger: 'ACCEPT',
  structural: true,
  candles15m: alive,
  price: 109,
  oi: {
    oi: 1,
    changePct: -0.8,
    priceChangePct: -0.4,
    confirmsMove: true,
    diverges: false,
    divergenceType: 'NONE',
    samples: 6,
  },
})
assert.equal(exitShort.verdict, 'VETO')
assert.match(exitShort.clause, /лонги уже вышли/)

const hour = 3_600_000
const start = Date.UTC(2026, 0, 1)
const hours: OhlcvCandle[] = []
for (let i = 0; i < 24 * 8; i++) {
  const ms = start + i * hour
  const utcH = new Date(ms).getUTCHours()
  const london = utcH >= 7 && utcH < 13
  const span = london && utcH === 10 ? 10 : 1
  hours.push(bar(ms, 100, 100 + span, 100, 100 + span * 0.4, 10))
}
const now = Date.UTC(2026, 0, 8, 10, 30, 0)
const walk = measureSessionWalk({ candles1h: hours, price: 100, now })
assert.equal(walk.name, 'LONDON')
assert.ok(walk.samples >= 4, `samples ${walk.samples}`)
assert.ok(Math.abs(walk.medianRange - 10) < 1.5, `median ${walk.medianRange}`)
assert.ok(walk.remaining < walk.medianRange, `remaining ${walk.remaining}`)

console.log('flow and session ok', walk.samples, walk.medianRange.toFixed(2), walk.remaining.toFixed(2))
