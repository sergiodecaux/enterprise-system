/**
 * Shared market context from worker: Fear&Greed, news, BTC.D.
 */

export interface CoinNewsHit {
  score: number
  label: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  headlines: string[]
}

export interface WorkerMarketContext {
  fearGreed: number | null
  fearGreedLabel: string
  newsScore: number
  newsLabel: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  newsHeadlines: string[]
  coinNews: Record<string, CoinNewsHit>
  btcDominance: number | null
  btcDomDelta24h: number | null
  fetchedAt: number
  lines: string[]
}

function getProxyBase(): string {
  const envUrl = import.meta.env.VITE_MEXC_PROXY_URL as string | undefined
  if (envUrl && envUrl.trim()) {
    return envUrl.replace(/\/$/, '')
  }
  return ''
}

export async function fetchWorkerMarketContext(): Promise<WorkerMarketContext | null> {
  const base = getProxyBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/market-context`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as WorkerMarketContext
  } catch {
    return null
  }
}
