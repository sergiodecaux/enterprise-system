/**
 * Poll MEXC ticker.holdVol for the calibration universe and append oi-history.jsonl.
 *   npx tsx src/engine/oi/collectOi.ts
 *
 * One request per poll (all contracts), then keep the nine core symbols.
 * Interval is 15 minutes so a later 1h event can be matched to a nearby sample.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_WATCHLIST, toApiSymbol } from '../../api/mexc'
import { appendOiRecords, buildOiRecord, readOiPoints, type OiLogRecord } from './oiLog'

const POLL_MS = 15 * 60 * 1000
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../../data/oi-history.jsonl')

interface TickerRow {
  symbol?: string
  holdVol?: number
  lastPrice?: number
}

async function pollOnce(): Promise<number> {
  const res = await fetch('https://contract.mexc.com/api/v1/contract/ticker')
  if (!res.ok) throw new Error(`ticker ${res.status}`)
  const json = (await res.json()) as { data?: TickerRow[] | TickerRow }
  const rows = Array.isArray(json.data) ? json.data : json.data ? [json.data] : []
  const byApi = new Map<string, TickerRow>()
  for (const row of rows) {
    if (row.symbol) byApi.set(row.symbol.toUpperCase(), row)
  }
  const ts = Date.now()
  const prior = readOiPoints(OUT)
  const written: OiLogRecord[] = []
  for (const symbol of CORE_WATCHLIST) {
    const row = byApi.get(toApiSymbol(symbol))
    const holdVol = Number(row?.holdVol)
    const price = Number(row?.lastPrice)
    if (!(holdVol > 0) || !(price > 0)) {
      console.log(`skip ${symbol}: no holdVol`)
      continue
    }
    written.push(buildOiRecord(symbol, ts, holdVol, price, prior.get(symbol) ?? []))
  }
  appendOiRecords(OUT, written)
  const withDelta = written.filter((r) => r.delta != null).length
  console.log(
    `${new Date(ts).toISOString()} wrote ${written.length}  delta ${withDelta}  ${OUT}`
  )
  return written.length
}

async function main() {
  if (process.argv.includes('--once')) {
    await pollOnce()
    return
  }
  for (;;) {
    try {
      await pollOnce()
    } catch (err) {
      console.error(err)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main()
