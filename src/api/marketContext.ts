/**
 * Shared market context from worker: Fear&Greed, news, BTC.D, TOTAL3.
 */

import { getProxyBaseUrl } from './proxyBase'

export type AltRegime = 'ALT_ON' | 'ALT_OFF' | 'BTC_LEAD' | 'RISK_OFF' | 'NEUTRAL'
export type AltBias = 'LONG' | 'SHORT' | 'NEUTRAL'

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
  /** BTC.D change vs ~24h snapshot, percentage points */
  btcDomDelta24h: number | null
  ethDominance?: number | null
  /** Alt mcap excluding BTC + ETH */
  total3Usd?: number | null
  /** TOTAL3 24h %, from snapshot when available */
  total3Delta24h?: number | null
  totalMcapDelta24h?: number | null
  altRegime?: AltRegime | null
  altBias?: AltBias | null
  fetchedAt: number
  lines: string[]
}

export async function fetchWorkerMarketContext(): Promise<WorkerMarketContext | null> {
  const base = getProxyBaseUrl()
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
