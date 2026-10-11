/**
 * Historical klines for the standalone calibration script.
 * Hits contract.mexc.com directly so the run does not go through Vite.
 * Live fetchOhlcv is unchanged.
 */
import { toApiSymbol, type OhlcvCandle } from '../../api/mexc'

export type HistoryTf = '15m' | '1h' | '4h' | '1d'

const INTERVAL: Record<HistoryTf, string> = {
  '15m': 'Min15',
  '1h': 'Min60',
  '4h': 'Hour4',
  '1d': 'Day1',
}

export const BAR_MS: Record<HistoryTf, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

const PAGE = 2000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface KlineBody {
  success?: boolean
  data?: {
    time?: number[]
    open?: number[]
    high?: number[]
    low?: number[]
    close?: number[]
    vol?: number[]
  }
}

export async function fetchKlineRange(
  symbol: string,
  tf: HistoryTf,
  startMs: number,
  endMs: number
): Promise<OhlcvCandle[]> {
  const api = toApiSymbol(symbol)
  const interval = INTERVAL[tf]
  const barMs = BAR_MS[tf]
  const byTime = new Map<number, OhlcvCandle>()
  let cursor = startMs
  while (cursor < endMs) {
    const pageEnd = Math.min(endMs, cursor + barMs * (PAGE - 1))
    const url =
      `https://contract.mexc.com/api/v1/contract/kline/${api}` +
      `?interval=${interval}&start=${Math.floor(cursor / 1000)}&end=${Math.floor(pageEnd / 1000)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`kline ${api} ${tf} ${res.status}`)
    const json = (await res.json()) as KlineBody
    const d = json.data
    const n = d?.time?.length ?? 0
    if (!n) {
      cursor = pageEnd + barMs
      await sleep(80)
      continue
    }
    let lastOpen = cursor
    for (let i = 0; i < n; i++) {
      const openMs = d!.time![i]! * 1000
      lastOpen = openMs
      if (openMs < startMs || openMs >= endMs) continue
      byTime.set(openMs, [
        openMs,
        Number(d!.open![i]),
        Number(d!.high![i]),
        Number(d!.low![i]),
        Number(d!.close![i]),
        Number(d!.vol?.[i] ?? 0),
      ])
    }
    const next = lastOpen + barMs
    if (next <= cursor) break
    cursor = next
    await sleep(120)
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0])
}
