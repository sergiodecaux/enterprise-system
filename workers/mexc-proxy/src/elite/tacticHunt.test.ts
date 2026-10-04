import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTacticReady,
  judgeTacticHunt,
  pickHuntSymbols,
  tacticAllowsEntry,
  unionHuntUniverse,
  type TacticHuntInput,
} from './tacticHunt'

function base(partial: Partial<TacticHuntInput> = {}): TacticHuntInput {
  return {
    symbol: 'ETH_USDT',
    price: 100,
    atr: 1.2,
    chg24: 1.4,
    fundingPct: 0.01,
    bias1h: 'BULL',
    bias4h: 'BULL',
    bias1d: 'BULL',
    high24: 104,
    low24: 96,
    ssl: { price: 99.4, isActive: true },
    bsl: { price: 103.2, isActive: true },
    zoneLong: {
      source: 'SSL',
      side: 'LONG',
      zoneLow: 99.1,
      zoneHigh: 100.2,
      mid: 99.6,
      limitEntry: 99.7,
      invalidate: 98.4,
      target: 103.2,
      targetLabel: '4H BSL',
      strength: 7,
      touches: 3,
      distancePct: -0.4,
      phase: 'TOUCH',
      tf: '4H',
      confluence: 1,
      reasoning: [],
    },
    zoneShort: null,
    pdh: 104,
    pdl: 96,
    rsi: 54,
    sessionDead: false,
    ...partial,
  }
}

test('READY long: unused SSL, unused BSL ahead, in zone', () => {
  const v = judgeTacticHunt(base())
  assert.ok(v)
  assert.equal(v.side, 'LONG')
  assert.equal(v.shelf, 'READY')
  assert.equal(isTacticReady(v), true)
  assert.equal(v.doNotChase, false)
})

test('never fires WAIT as entry — fuel still far', () => {
  const v = judgeTacticHunt(
    base({
      price: 100.5,
      ssl: { price: 98.8, isActive: true },
      bsl: { price: 107.6, isActive: true },
      pdh: 108,
      high24: 108,
      zoneLong: {
        ...base().zoneLong!,
        phase: 'FAR',
        zoneLow: 98.3,
        zoneHigh: 99.1,
        mid: 98.8,
        limitEntry: 98.85,
        target: 107.6,
        distancePct: -1.7,
      },
    })
  )
  assert.ok(v)
  assert.equal(v.shelf, 'WAIT')
  assert.equal(isTacticReady(v), false)
})

test('never fires STREAM as a new entry — already stretched to target', () => {
  const v = judgeTacticHunt(
    base({
      price: 103.05,
      ssl: { price: 99.4, isActive: true },
      bsl: { price: 103.2, isActive: true },
      zoneLong: {
        ...base().zoneLong!,
        phase: 'FAR',
        zoneLow: 99.1,
        zoneHigh: 100.2,
        mid: 99.6,
      },
    })
  )
  assert.ok(v)
  assert.equal(v.shelf, 'STREAM')
  assert.equal(isTacticReady(v), false)
  assert.equal(tacticAllowsEntry(v, 'LONG'), false)
})

test('spent fuel is not re-hunted', () => {
  const v = judgeTacticHunt(
    base({
      ssl: { price: 99.4, isActive: false },
      zoneLong: null,
    })
  )
  assert.equal(v, null)
})

test('daily against blocks long', () => {
  const v = judgeTacticHunt(
    base({
      bias1d: 'BEAR',
      bias4h: 'BEAR',
      bias1h: 'BEAR',
      pdl: 96,
      bsl: { price: 103.2, isActive: false },
      zoneShort: null,
    })
  )
  assert.equal(v, null)
})

test('target already swept is not an entry', () => {
  const v = judgeTacticHunt(
    base({
      price: 104.4,
      bsl: { price: 103.2, isActive: false },
      pdh: 103.2,
      high24: 103.2,
      zoneLong: {
        ...base().zoneLong!,
        target: 103.2,
        phase: 'FAR',
      },
    })
  )
  assert.equal(v, null)
})

test('one coin one side — daily long wins over a short draft', () => {
  const v = judgeTacticHunt(
    base({
      zoneShort: {
        source: 'BSL',
        side: 'SHORT',
        zoneLow: 102.6,
        zoneHigh: 103.8,
        mid: 103.2,
        limitEntry: 103.1,
        invalidate: 104.4,
        target: 96.8,
        targetLabel: 'PDL',
        strength: 6,
        touches: 2,
        distancePct: 3.1,
        phase: 'FAR',
        tf: '4H',
        confluence: 1,
        reasoning: [],
      },
    })
  )
  assert.ok(v)
  assert.equal(v.side, 'LONG')
})

test('universe is pinned plus favorites; batch keeps favorites', () => {
  const universe = unionHuntUniverse(['OP_USDT', 'ETH_USDT'])
  assert.ok(universe.includes('BTC_USDT'))
  assert.ok(universe.includes('OP_USDT'))
  const batch = pickHuntSymbols(universe, ['OP_USDT', 'ETH_USDT'])
  assert.ok(batch.includes('OP_USDT'))
  assert.ok(batch.includes('ETH_USDT'))
  assert.ok(batch.length <= 10)
})
