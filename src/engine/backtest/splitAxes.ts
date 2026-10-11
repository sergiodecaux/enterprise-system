/**
 * Regroup saved labeled events. Does not fetch history.
 *   npx tsx src/engine/backtest/splitAxes.ts body
 *   npx tsx src/engine/backtest/splitAxes.ts htfZone
 *   npx tsx src/engine/backtest/splitAxes.ts location
 *
 * The argument is the deepest axis. Earlier axes in AXIS_ORDER stay on.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGroups, familyStats, holdoutReport } from './calibrationStats'
import { FAMILY_ALPHA, MIN_SAMPLES, MIN_UNIQUE_WEEKS, WIDE_INTERVAL } from './config'
import { AXIS_ORDER } from './featureVector'
import type { CalibrationTable, GroupAxis, LabeledEvent } from './types'

const dir = dirname(fileURLToPath(import.meta.url))
const requested = (process.argv[2] ?? 'body') as GroupAxis
const depth = AXIS_ORDER.indexOf(requested)
if (depth < 0) {
  console.error(`axis must be one of ${AXIS_ORDER.join(', ')}`)
  process.exit(1)
}
const axes = AXIS_ORDER.slice(0, depth + 1)

interface SavedEvents {
  writtenAt: string
  events: LabeledEvent[]
}

const saved = JSON.parse(readFileSync(join(dir, 'labeledEvents.json'), 'utf8')) as SavedEvents
const train = saved.events.filter((e) => !e.holdout)
const hold = saved.events.filter((e) => e.holdout)
const groups = buildGroups(train, axes)
const family = familyStats(groups)
const holdout = holdoutReport(groups, hold, axes)
const count = (s: (typeof groups)[number]['status']) => groups.filter((g) => g.status === s).length
const base = JSON.parse(readFileSync(join(dir, 'calibrationTable.json'), 'utf8')) as CalibrationTable
const table: CalibrationTable = {
  ...base,
  calibratedAt: new Date().toISOString(),
  minSamples: MIN_SAMPLES,
  minUniqueWeeks: MIN_UNIQUE_WEEKS,
  wideInterval: WIDE_INTERVAL,
  axes,
  comparisons: family.comparisons,
  familyAlpha: FAMILY_ALPHA,
  adjustedZ: family.adjustedZ,
  totals: {
    ...base.totals,
    groups: groups.length,
    groupsOk: count('ok'),
    groupsInsufficient: count('insufficient'),
    groupsWide: count('wide'),
    groupsConcentrated: count('concentrated'),
    groupsSignificant: groups.filter((g) => g.significantVsRandom).length,
    groupsSurvive: holdout.filter((h) => h.survives).length,
  },
  checks: {
    ...base.checks,
    significantVsRandom:
      'Bonferroni lower bound (family = groups with n >= minSamples, family-wise alpha 0.05) is above 0.5. wilsonLo stays the unadjusted 95% bound.',
    survives:
      'train status ok, train significant after Bonferroni, holdout unadjusted Wilson lower bound above 0.5, avgRR > 1, holdout n >= 10, not overfit',
    rawEventsPersisted: true,
  },
  groups,
  holdout,
}
const slug = axes.join('-')
const out = join(dir, `calibrationTable.${slug}.json`)
writeFileSync(out, JSON.stringify(table, null, 2))

const pct = (v: number | null) => (v == null ? '   —' : `${(v * 100).toFixed(1)}%`)
console.log(
  `axes ${axes.join('+')}  events ${saved.events.length}  family ${family.comparisons}  z ${family.adjustedZ.toFixed(3)}`
)
console.log(
  `groups ${groups.length}  ok ${count('ok')}  insufficient ${count('insufficient')}  wide ${count('wide')}  concentrated ${count('concentrated')}`
)
console.log(
  `significant ${table.totals.groupsSignificant}  survive ${table.totals.groupsSurvive}`
)
const sig = groups.filter((g) => g.significantVsRandom)
console.log('train groups with adjusted lower bound above 50%')
if (!sig.length) console.log('  none')
for (const g of sig) {
  console.log(
    `  ${g.key}  win ${pct(g.winRate)}  n=${g.n}  status ${g.status}  adj ${pct(g.adjustedLo)}  wilson ${pct(g.wilsonLo)}  rr ${g.avgRR?.toFixed(2) ?? '—'}`
  )
}
console.log('holdout for ok groups')
for (const h of holdout) {
  const g = groups.find((x) => x.key === h.key)
  if (g?.status !== 'ok') continue
  console.log(
    `  ${h.key}  n=${h.n}  train ${pct(h.trainWinRate)}  hold ${pct(h.winRate)}  holdLo ${pct(h.wilsonLo)}  inv ${pct(h.invalidatedShare)}  rr ${g.avgRR?.toFixed(2) ?? '—'}  overfit ${h.overfit ? 'yes' : 'no'}  survives ${h.survives ? 'yes' : 'no'}`
  )
}
console.log(`wrote ${out}`)
