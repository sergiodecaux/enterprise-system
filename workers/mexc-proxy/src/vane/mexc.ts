import type { Candle } from './types'

const MEXC = 'https://contract.mexc.com'

export interface VaneTicker {
  symbol: string
  lastPrice: number
  riseFallRate: number
  volume24: number
  amount24?: number
  holdVol?: number
  fundingRate?: number
  bid1?: number
  ask1?: number
  high24Price?: number
  lower24Price?: number
}

export async function mexcJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'EnterpriseSystem/2.0' },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchTickers(): Promise<VaneTicker[]> {
  const json = await mexcJson<{ data: VaneTicker | VaneTicker[] }>(
    '/api/v1/contract/ticker'
  )
  if (!json?.data) return []
  return Array.isArray(json.data) ? json.data : [json.data]
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const json = await mexcJson<{
    data: {
      time: number[]
      open: number[]
      high: number[]
      low: number[]
      close: number[]
      vol: number[]
    }
  }>(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`)
  const d = json?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  for (let i = 0; i < d.time.length; i++) {
    out.push([
      d.time[i]! * 1000,
      Number(d.open[i]),
      Number(d.high[i]),
      Number(d.low[i]),
      Number(d.close[i]),
      Number(d.vol[i] ?? 0),
    ])
  }
  return out
}

export function quoteVol(t: VaneTicker): number {
  return Number(t.amount24 ?? 0) || Number(t.volume24 ?? 0) * Number(t.lastPrice ?? 0)
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!
    const prev = candles[i - 1]!
    sum += Math.max(
      c[2] - c[3],
      Math.abs(c[2] - prev[4]),
      Math.abs(c[3] - prev[4])
    )
  }
  return sum / period
}

export function tfBias(candles: Candle[]): 'BULL' | 'BEAR' | 'FLAT' {
  if (candles.length < 20) return 'FLAT'
  const closes = candles.map((c) => c[4])
  const sma =
    closes.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, closes.length)
  const last = closes[closes.length - 1]!
  const prev = closes[closes.length - 6] ?? last
  const mom = ((last - prev) / prev) * 100
  if (last > sma * 1.002 && mom > 0.15) return 'BULL'
  if (last < sma * 0.998 && mom < -0.15) return 'BEAR'
  return 'FLAT'
}
