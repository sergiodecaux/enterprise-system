/**
 * Open-interest log. Field list locked on 2026-10-11, before the first sample.
 * Do not add or drop fields after accumulation has started.
 *
 * One JSON line is one poll of ticker.holdVol, not a structure event.
 * delta is holdVol now minus holdVol about OI_BARS_BEFORE one-hour bars earlier.
 * The first hours of a symbol have delta null until that prior sample exists.
 *
 * A later calibration may mark a 1h group ok while 4h and 1d stay insufficient.
 * A filled bucket does not authorize confidence for a bucket that has not cleared
 * the same n / uniqueWeeks / holdout rules.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const OI_LOG_VERSION = 1 as const
/** One-hour bar. The first group that can reach n=30 is the 1h reclaim. */
export const OI_BAR_MS = 3_600_000
/** How many of those bars back the stored delta looks. */
export const OI_BARS_BEFORE = 4

export interface OiLogRecord {
  v: typeof OI_LOG_VERSION
  symbol: string
  ts: number
  holdVol: number
  price: number
  holdVolBefore: number | null
  beforeTs: number | null
  delta: number | null
  deltaPct: number | null
}

export interface OiPoint {
  ts: number
  holdVol: number
}

/** Sample nearest to ts - N bars, and at least one bar away from ts. */
export function pickHoldVolBefore(
  samples: readonly OiPoint[],
  ts: number,
  barMs = OI_BAR_MS,
  barsBefore = OI_BARS_BEFORE
): OiPoint | null {
  const target = ts - barsBefore * barMs
  const lo = target - barMs
  const hi = target + barMs
  let best: OiPoint | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const s of samples) {
    if (s.ts < lo || s.ts > hi || s.ts >= ts - barMs) continue
    const dist = Math.abs(s.ts - target)
    if (dist < bestDist) {
      best = s
      bestDist = dist
    }
  }
  return best
}

export function buildOiRecord(
  symbol: string,
  ts: number,
  holdVol: number,
  price: number,
  prior: readonly OiPoint[]
): OiLogRecord {
  const before = pickHoldVolBefore(prior, ts)
  const delta = before ? holdVol - before.holdVol : null
  const deltaPct =
    before && before.holdVol > 0 ? delta! / before.holdVol : null
  return {
    v: OI_LOG_VERSION,
    symbol,
    ts,
    holdVol,
    price,
    holdVolBefore: before?.holdVol ?? null,
    beforeTs: before?.ts ?? null,
    delta,
    deltaPct,
  }
}

export function readOiPoints(path: string): Map<string, OiPoint[]> {
  const bySymbol = new Map<string, OiPoint[]>()
  if (!existsSync(path)) return bySymbol
  const text = readFileSync(path, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as OiLogRecord
    const list = bySymbol.get(row.symbol) ?? []
    list.push({ ts: row.ts, holdVol: row.holdVol })
    bySymbol.set(row.symbol, list)
  }
  return bySymbol
}

export function appendOiRecords(path: string, rows: OiLogRecord[]): void {
  if (!rows.length) return
  mkdirSync(dirname(path), { recursive: true })
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  appendFileSync(path, body, 'utf8')
}
