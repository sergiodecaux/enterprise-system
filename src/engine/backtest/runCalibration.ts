/**
 * Standalone calibration run. Not imported by the Vite app.
 *   npx tsx src/engine/backtest/runCalibration.ts
 *
 * Phase 2 must treat status other than "ok" as untrusted, and must warn
 * when calibratedAt is older than STALE_AFTER_DAYS (90).
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_WATCHLIST } from '../../api/mexc'
import { buildGroups, familyStats, holdoutReport } from './calibrationStats'
import {
  BTC_ETH_MONTHS,
  FAMILY_ALPHA,
  HOLDOUT_WEEKS,
  MIN_SAMPLES,
  MIN_UNIQUE_WEEKS,
  OTHER_MONTHS,
  STALE_AFTER_DAYS,
  WIDE_INTERVAL,
} from './config'
import { SAVED_FEATURES } from './featureVector'
import { fetchKlineRange } from './history'
import { labelSymbol } from './backtestRunner'
import type { CalibrationGroup, CalibrationTable, LabeledEvent } from './types'

const MONTH_MS = 30 * 24 * 3600 * 1000
const DAY_MS = 86_400_000

function monthsFor(symbol: string): number {
  const base = symbol.toUpperCase()
  if (base.startsWith('BTC') || base.startsWith('ETH')) return BTC_ETH_MONTHS
  return OTHER_MONTHS
}

function fmtDay(ms: number): string {
  if (!(ms > 0)) return '—'
  return new Date(ms).toISOString().slice(0, 10)
}

function pct(n: number | null): string {
  if (n == null) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function printGroup(g: CalibrationGroup): void {
  const symbols = Object.entries(g.window.bySymbol)
    .map(([s, row]) => `${s.split('/')[0]} n=${row.n} ${fmtDay(row.firstMs)}..${fmtDay(row.lastMs)}`)
    .join('; ')
  console.log(
    `${g.key}  win ${pct(g.winRate)}  n=${g.n}  symbols=${g.uniqueSymbols}  weeks=${g.uniqueWeeks}  ` +
      `undecided ${pct(g.undecidedShare)}  mfe ${g.avgMfeAtr?.toFixed(2) ?? '—'}  mae ${g.avgMaeAtr?.toFixed(2) ?? '—'}  ` +
      `wilson ${pct(g.wilsonLo)}..${pct(g.wilsonHi)}  ${fmtDay(g.window.firstMs)}..${fmtDay(g.window.lastMs)}`
  )
  console.log(`    ${symbols}`)
}

async function main() {
  const toMs = Date.now()
  const symbols = [...CORE_WATCHLIST]
  const all: LabeledEvent[] = []
  let fromMs = toMs
  for (const symbol of symbols) {
    const startMs = toMs - monthsFor(symbol) * MONTH_MS
    fromMs = Math.min(fromMs, startMs)
    const holdoutStart = toMs - HOLDOUT_WEEKS * 7 * DAY_MS
    console.log(`load ${symbol} from ${fmtDay(startMs)}`)
    const [m15, h1, h4, d1] = await Promise.all([
      fetchKlineRange(symbol, '15m', startMs, toMs),
      fetchKlineRange(symbol, '1h', startMs, toMs),
      fetchKlineRange(symbol, '4h', startMs, toMs),
      fetchKlineRange(symbol, '1d', startMs, toMs),
    ])
    console.log(
      `  bars 15m=${m15.length} 1h=${h1.length} 4h=${h4.length} 1d=${d1.length} — walking`
    )
    const t0 = Date.now()
    const labeled = labelSymbol(symbol, { m15, h1, h4, d1 }, holdoutStart)
    console.log(`  events ${labeled.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    all.push(...labeled)
  }

  const train = all.filter((e) => !e.holdout)
  const hold = all.filter((e) => e.holdout)
  const groups = buildGroups(train)
  const family = familyStats(groups)
  const holdout = holdoutReport(groups, hold)
  const count = (s: CalibrationGroup['status']) => groups.filter((g) => g.status === s).length
  const table: CalibrationTable = {
    calibratedAt: new Date().toISOString(),
    universe: 'blue-chip-pinned',
    minSamples: MIN_SAMPLES,
    minUniqueWeeks: MIN_UNIQUE_WEEKS,
    wideInterval: WIDE_INTERVAL,
    horizons: [5, 20, 50],
    holdoutWeeks: HOLDOUT_WEEKS,
    oiHistory: 'unavailable',
    staleAfterDays: STALE_AFTER_DAYS,
    weekSource:
      'aggregateWeekly(native Day1), Monday UTC, same function as useMultiTFAnalysis. No Week1 request exists in the app.',
    daySource: 'native Day1',
    axes: [],
    comparisons: family.comparisons,
    familyAlpha: FAMILY_ALPHA,
    adjustedZ: family.adjustedZ,
    symbols,
    fromMs,
    toMs,
    totals: {
      eventsLabeled: all.length,
      trainEvents: train.length,
      holdoutEvents: hold.length,
      groups: groups.length,
      groupsOk: count('ok'),
      groupsInsufficient: count('insufficient'),
      groupsWide: count('wide'),
      groupsConcentrated: count('concentrated'),
      groupsSignificant: groups.filter((g) => g.significantVsRandom).length,
      groupsSurvive: holdout.filter((h) => h.survives).length,
    },
    checks: {
      significantVsRandom:
        'Bonferroni lower bound (family = groups with n >= minSamples, family-wise alpha 0.05) is above 0.5. wilsonLo stays the unadjusted 95% bound.',
      avgRR: 'avgMfeAtr / avgMaeAtr on the 50-bar horizon',
      invalidatedShare: '1 - winRate - undecidedShare',
      survives:
        'train status ok, train significant after Bonferroni, holdout unadjusted Wilson lower bound above 0.5, avgRR > 1, holdout n >= 10, not overfit',
      rawEventsPersisted: true,
    },
    groups,
    holdout,
  }
  const dir = dirname(fileURLToPath(import.meta.url))
  const out = join(dir, 'calibrationTable.json')
  const eventsPath = join(dir, 'labeledEvents.json')
  writeFileSync(
    eventsPath,
    JSON.stringify({
      writtenAt: table.calibratedAt,
      features: SAVED_FEATURES,
      events: all,
    })
  )
  writeFileSync(out, JSON.stringify(table, null, 2))

  const ranked = groups.filter((g) => g.status === 'ok' && g.winRate != null)
  const byWin = [...ranked].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))
  console.log('')
  console.log(`events ${all.length}  train ${train.length}  holdout ${hold.length}`)
  console.log(
    `groups ${groups.length}  ok ${count('ok')}  wide ${count('wide')}  concentrated ${count('concentrated')}  insufficient ${count('insufficient')}`
  )
  console.log('top win-rate (ok only)')
  for (const g of byWin.slice(0, 10)) printGroup(g)
  console.log('worst win-rate (ok only)')
  for (const g of [...byWin].reverse().slice(0, 10)) printGroup(g)
  const over = holdout.filter((h) => h.overfit)
  console.log(`holdout overfit flags ${over.length}`)
  for (const h of over.slice(0, 10)) {
    console.log(`  ${h.key} train ${pct(h.trainWinRate)} holdout ${pct(h.winRate)} n=${h.n}`)
  }
  console.log(
    `family ${family.comparisons}  adjustedZ ${family.adjustedZ.toFixed(3)}  significant ${table.totals.groupsSignificant}  survive ${table.totals.groupsSurvive}`
  )
  console.log(`wrote ${eventsPath}`)
  console.log(`wrote ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
