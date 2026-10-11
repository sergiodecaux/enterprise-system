/**
 * Standalone funding-extreme check. Not imported by the Vite app.
 * One locked combination: 10/90 on the prior 90 settles, outcomes at 8h and 24h.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_WATCHLIST, toApiSymbol } from '../../api/mexc'
import { fetchKlineRange } from './history'
import { bonferroniZ, wilsonInterval } from './calibrationStats'
import {
  FAMILY_ALPHA,
  FUNDING_CELLS,
  FUNDING_DEDUP_H,
  FUNDING_WINDOW,
  HOLDOUT_WEEKS,
  MIN_SAMPLES,
  MIN_UNIQUE_WEEKS,
  WIDE_INTERVAL,
} from './config'
import { fadeHit, fundingTail, type FundingCell, type FundingTail } from './fundingHypothesis'

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'fundingTable.json')

interface Settle {
  rate: number
  settleTime: number
}

interface Counted {
  symbol: string
  tail: FundingTail
  settleTime: number
  weekKey: number
  holdout: boolean
  ret: Partial<Record<8 | 24, number>>
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function mondayUtc(ms: number): number {
  const d = new Date(ms)
  const day = d.getUTCDay()
  const offset = day === 0 ? 6 : day - 1
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset)
}

async function fetchFunding(symbol: string): Promise<Settle[]> {
  const api = toApiSymbol(symbol)
  const rows: Settle[] = []
  let page = 1
  let total = 1
  while (page <= total) {
    const url =
      `https://contract.mexc.com/api/v1/contract/funding_rate/history` +
      `?symbol=${api}&page_num=${page}&page_size=100`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`funding ${api} ${res.status}`)
    const json = (await res.json()) as {
      data?: {
        totalPage?: number
        resultList?: Array<{ fundingRate: number; settleTime: number }>
      }
    }
    total = json.data?.totalPage ?? page
    for (const row of json.data?.resultList ?? []) {
      rows.push({ rate: Number(row.fundingRate), settleTime: Number(row.settleTime) })
    }
    page += 1
    await sleep(70)
  }
  rows.sort((a, b) => a.settleTime - b.settleTime)
  const uniq = new Map<number, Settle>()
  for (const row of rows) uniq.set(row.settleTime, row)
  return [...uniq.values()].sort((a, b) => a.settleTime - b.settleTime)
}

function closeAt(candles: Array<[number, number, number, number, number, number]>, openMs: number): number | null {
  let lo = 0
  let hi = candles.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = candles[mid]![0]
    if (t === openMs) return candles[mid]![4]
    if (t < openMs) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (found >= 0 && candles[found]![0] === openMs) return candles[found]![4]
  return null
}

function entryIndex(
  candles: Array<[number, number, number, number, number, number]>,
  settleTime: number
): number {
  let lo = 0
  let hi = candles.length - 1
  let ans = candles.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid]![0] >= settleTime) {
      ans = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  return ans
}

async function main(): Promise<void> {
  const counted: Counted[] = []
  let newest = 0
  const book = new Map<string, Settle[]>()
  const perSymbol: Array<{ symbol: string; settles: number; events: number }> = []

  for (const symbol of CORE_WATCHLIST) {
    const settles = await fetchFunding(symbol)
    book.set(symbol, settles)
    if (settles.length) newest = Math.max(newest, settles[settles.length - 1]!.settleTime)
    perSymbol.push({ symbol, settles: settles.length, events: 0 })
    console.log(`${symbol} funding ${settles.length}`)
  }

  const holdoutFrom = newest - HOLDOUT_WEEKS * WEEK
  const symStats = new Map(perSymbol.map((row) => [row.symbol, row]))

  for (const symbol of CORE_WATCHLIST) {
    const settles = book.get(symbol) ?? []
    if (settles.length < FUNDING_WINDOW + 1) continue
    const start = settles[0]!.settleTime
    const candles = await fetchKlineRange(symbol, '1h', start, newest + 30 * HOUR)
    console.log(`${symbol} 1h bars ${candles.length}`)
    let lastAt: Record<FundingTail, number> = { high_pos: 0, low_neg: 0 }
    for (let i = FUNDING_WINDOW; i < settles.length; i++) {
      const cur = settles[i]!
      const prior = settles.slice(i - FUNDING_WINDOW, i).map((s) => s.rate)
      const tail = fundingTail(cur.rate, prior)
      if (!tail) continue
      if (cur.settleTime < lastAt[tail] + FUNDING_DEDUP_H * HOUR) continue
      const idx = entryIndex(candles, cur.settleTime)
      if (idx >= candles.length) continue
      const entry = candles[idx]![4]
      if (!(entry > 0)) continue
      const ret: Counted['ret'] = {}
      let any = false
      for (const h of [8, 24] as const) {
        const px = closeAt(candles, candles[idx]![0] + h * HOUR)
        if (px == null || !(px > 0)) continue
        ret[h] = (px - entry) / entry
        any = true
      }
      if (!any) continue
      lastAt[tail] = cur.settleTime
      counted.push({
        symbol,
        tail,
        settleTime: cur.settleTime,
        weekKey: mondayUtc(cur.settleTime),
        holdout: cur.settleTime >= holdoutFrom,
        ret,
      })
      symStats.get(symbol)!.events += 1
    }
  }

  const cells = FUNDING_CELLS.map((key) => summarize(key, counted, false))
  const m = cells.filter((c) => c.n >= MIN_SAMPLES).length
  const adjustedZ = bonferroniZ(Math.max(m, 1), FAMILY_ALPHA)
  for (const cell of cells) {
    if (cell.n < MIN_SAMPLES || cell.wins == null) {
      cell.significantVsRandom = false
      cell.adjustedLo = null
      continue
    }
    const adj = wilsonInterval(cell.wins, cell.n, adjustedZ)
    cell.adjustedLo = adj.lo
    cell.significantVsRandom = adj.lo > 0.5
  }
  const holdout = FUNDING_CELLS.map((key) => holdoutOf(key, counted, cells))

  const table = {
    lockedAt: '2026-10-11',
    rerunPolicy:
      '10/90 and 8h/24h are the only combination on this sample. A null result is the result.',
    universe: 'blue-chip-pinned',
    symbols: CORE_WATCHLIST,
    window: FUNDING_WINDOW,
    percentiles: [10, 90],
    horizonsH: [8, 24],
    dedupH: FUNDING_DEDUP_H,
    familyAlpha: FAMILY_ALPHA,
    comparisons: m,
    adjustedZ,
    holdoutFrom,
    newestSettle: newest,
    perSymbol: [...symStats.values()],
    events: counted.length,
    cells,
    holdout,
    groupsSignificant: cells.filter((c) => c.significantVsRandom).length,
    groupsSurvive: holdout.filter((h) => h.survives).length,
  }
  writeFileSync(OUT, JSON.stringify(table, null, 2))
  console.log(`events ${counted.length}  family ${m}  z ${adjustedZ.toFixed(3)}`)
  for (const cell of cells) {
    console.log(
      `  ${cell.key}  n=${cell.n}  win ${pct(cell.winRate)}  status ${cell.status}  ` +
        `adj ${pct(cell.adjustedLo)}  weeks ${cell.uniqueWeeks}  sig ${cell.significantVsRandom ? 'yes' : 'no'}`
    )
  }
  for (const h of holdout) {
    console.log(
      `  hold ${h.key}  n=${h.n}  train ${pct(h.trainWinRate)}  hold ${pct(h.winRate)}  ` +
        `lo ${pct(h.wilsonLo)}  overfit ${h.overfit ? 'yes' : 'no'}  survives ${h.survives ? 'yes' : 'no'}`
    )
  }
  console.log(`wrote ${OUT}`)
}

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

function summarize(key: FundingCell, rows: Counted[], holdout: boolean) {
  const tail = key.startsWith('high_pos') ? 'high_pos' : 'low_neg'
  const horizon = key.endsWith('24h') ? 24 : 8
  const slice = rows.filter((r) => r.tail === tail && r.holdout === holdout && r.ret[horizon] != null)
  let wins = 0
  let undecided = 0
  const weeks = new Set<number>()
  const symbols = new Set<string>()
  for (const row of slice) {
    const kind = fadeHit(tail, row.ret[horizon]!)
    if (kind === 'hit') wins += 1
    if (kind === 'undecided') undecided += 1
    weeks.add(row.weekKey)
    symbols.add(row.symbol)
  }
  const n = slice.length
  const enough = n >= MIN_SAMPLES
  const winRate = enough ? wins / n : null
  const undecidedShare = enough ? undecided / n : null
  const wilson = enough ? wilsonInterval(wins, n) : null
  let status: 'insufficient' | 'concentrated' | 'wide' | 'ok' = 'insufficient'
  if (enough && weeks.size < MIN_UNIQUE_WEEKS) status = 'concentrated'
  else if (enough && wilson && wilson.width > WIDE_INTERVAL) status = 'wide'
  else if (enough) status = 'ok'
  return {
    key,
    n,
    wins,
    uniqueWeeks: weeks.size,
    uniqueSymbols: symbols.size,
    winRate,
    undecidedShare,
    wilsonLo: wilson?.lo ?? null,
    wilsonHi: wilson?.hi ?? null,
    status,
    significantVsRandom: false,
    adjustedLo: null as number | null,
  }
}

function holdoutOf(
  key: FundingCell,
  rows: Counted[],
  train: ReturnType<typeof summarize>[]
) {
  const cell = summarize(key, rows, true)
  const src = train.find((c) => c.key === key)
  const trainWin = src?.winRate ?? null
  const holdWin = cell.n > 0 ? cell.wins / cell.n : null
  const overfit =
    src?.status === 'ok' &&
    trainWin != null &&
    holdWin != null &&
    cell.n >= 10 &&
    trainWin - holdWin >= 0.08
  const survives =
    src?.status === 'ok' &&
    src.significantVsRandom &&
    cell.n >= 10 &&
    cell.wilsonLo != null &&
    cell.wilsonLo > 0.5 &&
    !overfit
  return {
    key,
    n: cell.n,
    winRate: holdWin,
    wilsonLo: cell.n > 0 ? wilsonInterval(cell.wins, cell.n).lo : null,
    trainWinRate: trainWin,
    overfit,
    survives,
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
