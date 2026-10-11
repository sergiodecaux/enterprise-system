/**
 * Phase 1.5. Recompute significance, R:R and outcome shares from the
 * aggregates already stored in calibrationTable.json. Does not fetch history.
 *   npx tsx src/engine/backtest/enrichPhase15.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { annotateGroup, annotateHoldout } from './calibrationStats'
import type { CalibrationGroup, CalibrationTable, HoldoutGroup } from './types'

const path = join(dirname(fileURLToPath(import.meta.url)), 'calibrationTable.json')
const raw = JSON.parse(readFileSync(path, 'utf8')) as CalibrationTable
const groups = raw.groups.map((g) => annotateGroup(g as CalibrationGroup))
const holdout = annotateHoldout(groups, raw.holdout as HoldoutGroup[])
const table: CalibrationTable = {
  ...raw,
  totals: {
    ...raw.totals,
    groupsSignificant: groups.filter((g) => g.significantVsRandom).length,
    groupsSurvive: holdout.filter((h) => h.survives).length,
  },
  checks: {
    significantVsRandom: 'Wilson 95% lower bound of the 50-bar win rate is above 0.5',
    avgRR: 'avgMfeAtr / avgMaeAtr on the 50-bar horizon',
    invalidatedShare: '1 - winRate - undecidedShare',
    survives:
      'train status ok, train and holdout both significant vs 0.5, avgRR > 1, holdout n >= 10, not overfit',
    rawEventsPersisted: false,
  },
  groups,
  holdout,
}
writeFileSync(path, JSON.stringify(table, null, 2))

const pct = (v: number | null) => (v == null ? '  n/a' : `${(v * 100).toFixed(1)}%`)
const num = (v: number | null) => (v == null ? ' n/a' : v.toFixed(2))
console.log(
  `significant ${table.totals.groupsSignificant}  survive ${table.totals.groupsSurvive}  of ${groups.length}`
)
console.log('holdout, all ok groups')
console.log(
  'key                         n   train   hold   inv   wilsonLo  sig  rr  overfit'
)
for (const h of holdout) {
  const g = groups.find((x) => x.key === h.key)
  if (g?.status !== 'ok') continue
  console.log(
    [
      h.key.padEnd(28),
      String(h.n).padStart(3),
      pct(h.trainWinRate).padStart(7),
      pct(h.winRate).padStart(7),
      pct(h.invalidatedShare).padStart(6),
      pct(h.wilsonLo).padStart(8),
      h.significantVsRandom ? 'yes' : ' no',
      num(g.avgRR).padStart(5),
      h.overfit ? 'yes' : 'no',
    ].join(' ')
  )
}
