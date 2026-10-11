/**
 * Walk-forward checks on a real MEXC fixture.
 *   npx tsx src/engine/backtest/backtest.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OhlcvCandle } from '../../api/mexc'
import { bonferroniZ, buildGroups, wilsonInterval } from './calibrationStats'
import { featureVectorOf } from './featureVector'
import { bookAt, snapsFromRead, structureAt } from './backtestRunner'
import { labelOutcome } from './outcomeLabeler'
import type { HistorySeries, LabeledEvent } from './types'

const dir = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(join(dir, 'fixtures', 'btc-structure.json'), 'utf8')
) as HistorySeries

function cloneSeries(s: HistorySeries): HistorySeries {
  const copy = (rows: OhlcvCandle[]) => rows.map((c) => [...c] as OhlcvCandle)
  return { m15: copy(s.m15), h1: copy(s.h1), h4: copy(s.h4), d1: copy(s.d1) }
}

function idsAt(series: HistorySeries, asOfMs: number): string[] {
  const book = bookAt(series, asOfMs)
  const read = structureAt('BTC/USDT:USDT', book)
  return snapsFromRead(book, read)
    .map((s) => `${s.tf}|${s.kind}|${s.timeSec}|${s.level}|${s.side}`)
    .sort()
}

const asOf = fixture.h1[80]![0] + 3_600_000
const before = idsAt(fixture, asOf)
const mutated = cloneSeries(fixture)
for (const row of [mutated.m15, mutated.h1, mutated.h4, mutated.d1]) {
  for (const c of row) {
    if (c[0] < asOf) continue
    c[2] = c[2] * 1.25
    c[3] = c[3] * 0.75
    c[4] = c[2]
  }
}
const after = idsAt(mutated, asOf)
assert.deepEqual(after, before, 'future bars changed the event seen at N')
assert.ok(before.length > 0, 'fixture produced no held event at the check bar')

const book = bookAt(fixture, asOf)
const snap = snapsFromRead(book, structureAt('BTC/USDT:USDT', book))[0]
assert.ok(snap, 'missing snap')
const future = fixture.h1.filter((c) => c[0] >= asOf).slice(0, 20)
const labeled = labelOutcome({
  side: snap.side,
  entry: snap.entry,
  target: snap.target,
  invalidation: snap.level,
  atr: snap.atr,
  future,
})
const h20 = labeled.find((h) => h.horizon === 20)
assert.ok(h20)
let fav = 0
let adv = 0
for (const c of future) {
  if (snap.side === 'UP') {
    fav = Math.max(fav, c[2] - snap.entry)
    adv = Math.max(adv, snap.entry - c[3])
  } else {
    fav = Math.max(fav, snap.entry - c[3])
    adv = Math.max(adv, c[2] - snap.entry)
  }
}
assert.ok(snap.atr > 0)
assert.equal(h20.mfeAtr, fav / snap.atr)
assert.equal(h20.maeAtr, adv / snap.atr)

const seed = labeled[labeled.length - 1]!
const week0 = 20_000
const made: LabeledEvent[] = []
for (let i = 0; i < 40; i++) {
  const week = week0 + (i % 3)
  made.push({
    tf: '4h',
    kind: 'BOS',
    side: 'UP',
    level: snap.level,
    timeSec: snap.timeSec,
    target: snap.target,
    trend: snap.trend,
    location: snap.location,
    priorSweep: false,
    volumeRatio: snap.volumeRatio,
    body: snap.body,
    htfZone: snap.htfZone,
    atr: snap.atr,
    entry: snap.entry,
    symbol: i % 2 === 0 ? 'BTC/USDT:USDT' : 'ETH/USDT:USDT',
    discoveredMs: Date.UTC(2026, 0, 5) + i * 86_400_000,
    weekKey: week,
    oi: 'unknown',
    holdout: false,
    features: featureVectorOf({ ...snap, kind: 'BOS', tf: '4h', priorSweep: false, body: 'weak' }),
    horizons: [
      { horizon: 5, result: 'undecided', mfeAtr: seed.mfeAtr, maeAtr: seed.maeAtr, barsToTarget: null },
      { horizon: 20, result: i % 2 === 0 ? 'hit' : 'undecided', mfeAtr: h20.mfeAtr, maeAtr: h20.maeAtr, barsToTarget: i % 2 === 0 ? 4 : null },
      { horizon: 50, result: i % 2 === 0 ? 'hit' : 'undecided', mfeAtr: seed.mfeAtr, maeAtr: seed.maeAtr, barsToTarget: i % 2 === 0 ? 10 : null },
    ],
  })
}
const concentrated = buildGroups(made)[0]
assert.ok(concentrated)
assert.equal(concentrated.n, 40)
assert.ok(concentrated.uniqueWeeks < 8)
assert.equal(concentrated.status, 'concentrated')
assert.equal(concentrated.winRate, 0.5)
assert.equal(concentrated.undecidedShare, 0.5)
assert.equal(concentrated.invalidatedShare, 0)
assert.equal(concentrated.significantVsRandom, false)
assert.ok(concentrated.avgRR != null && concentrated.avgRR > 0)

const spread: LabeledEvent[] = made.map((e, i) => ({ ...e, weekKey: week0 + i }))
const wideOrOk = buildGroups(spread)[0]
assert.ok(wideOrOk)
assert.ok(wideOrOk.uniqueWeeks >= 8)
assert.notEqual(wideOrOk.status, 'concentrated')
assert.notEqual(wideOrOk.status, 'insufficient')
const w = wilsonInterval(20, 40)
assert.ok(w.width > 0)
assert.equal(wideOrOk.wilsonWidth, w.width)

const few = buildGroups(made.slice(0, 10))[0]
assert.equal(few?.status, 'insufficient')
assert.equal(few?.winRate, null)

assert.ok(Math.abs(bonferroniZ(1) - 1.96) < 0.002)
assert.ok(bonferroniZ(2) > bonferroniZ(1))

const splitSource = Array.from({ length: 60 }, (_, i) => {
  const body = i < 30 ? ('displacement' as const) : ('weak' as const)
  const base = made[i % made.length]!
  const hit = body === 'displacement' ? i % 5 !== 0 : i % 2 === 0
  return {
    ...base,
    body,
    weekKey: week0 + 1000 + i,
    features: { ...base.features, body },
    horizons: base.horizons.map((h) =>
      h.horizon === 50 ? { ...h, result: hit ? ('hit' as const) : ('invalidated' as const) } : h
    ),
  }
})
const split = buildGroups(splitSource, ['body'])
assert.equal(split.length, 2)
const strong = split.find((g) => g.body === 'displacement')
const flat = split.find((g) => g.body === 'weak')
assert.ok(strong && flat)
assert.equal(strong.n, 30)
assert.equal(flat.n, 30)
assert.ok(strong.adjustedLo != null && strong.wilsonLo != null)
assert.ok(strong.adjustedLo < strong.wilsonLo)
assert.equal(flat.significantVsRandom, false)

console.log('backtest harness ok')
