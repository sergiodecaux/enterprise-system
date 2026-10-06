import { getProxyBaseUrl } from '../proxyBase'
import { fetchFundingRate } from '../mexc'
import { toBinanceFuturesSymbol } from './symbols'
import type { CrowdContext, CrowdTrend } from '../../engine/context'

function fapiBase(): string {
  const proxy = getProxyBaseUrl()
  if (proxy) return `${proxy}/binance-fapi`
  return '/binance-fapi'
}

function trend(prev: number, cur: number, eps: number): CrowdTrend {
  if (!Number.isFinite(prev) || !Number.isFinite(cur)) return 'FLAT'
  const d = cur - prev
  if (Math.abs(d) <= eps) return 'FLAT'
  return d > 0 ? 'RISING' : 'FALLING'
}

async function getJson<T>(path: string): Promise<T | null> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(`${fapiBase()}${path}`, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Public crowd positioning. Binance USDT-M first, MEXC funding if that symbol
 * is missing there. Ratio stays 1 when unknown so it does not move weights.
 */
export async function fetchCrowdContext(symbol: string): Promise<CrowdContext | null> {
  const binance = toBinanceFuturesSymbol(symbol)
  if (binance) {
    const [ratioRows, fundRows, oiRows] = await Promise.all([
      getJson<Array<{ longShortRatio: string }>>(
        `/futures/data/globalLongShortAccountRatio?symbol=${binance}&period=1h&limit=2`
      ),
      getJson<Array<{ fundingRate: string }>>(
        `/fapi/v1/fundingRate?symbol=${binance}&limit=2`
      ),
      getJson<Array<{ sumOpenInterest: string }>>(
        `/futures/data/openInterestHist?symbol=${binance}&period=1h&limit=2`
      ),
    ])
    const ratio = ratioRows?.map((r) => Number(r.longShortRatio)).filter((n) => n > 0) ?? []
    const funds = fundRows?.map((r) => Number(r.fundingRate)).filter((n) => Number.isFinite(n)) ?? []
    const ois = oiRows?.map((r) => Number(r.sumOpenInterest)).filter((n) => n > 0) ?? []
    if (ratio.length || funds.length || ois.length) {
      const prevOi = ois.length >= 2 ? ois[ois.length - 2] : ois[0]
      const curOi = ois.length ? ois[ois.length - 1] : 0
      return {
        longShortRatio: ratio.length ? ratio[ratio.length - 1] : 1,
        longShortTrend:
          ratio.length >= 2 ? trend(ratio[ratio.length - 2], ratio[ratio.length - 1], 0.02) : 'FLAT',
        fundingRate: funds.length ? funds[funds.length - 1] : 0,
        fundingTrend:
          funds.length >= 2
            ? trend(funds[funds.length - 2], funds[funds.length - 1], 0.00001)
            : 'FLAT',
        openInterestChangePct:
          prevOi > 0 && curOi > 0 ? ((curOi - prevOi) / prevOi) * 100 : 0,
        known: true,
      }
    }
  }

  const mexc = await fetchFundingRate(symbol)
  if (!mexc) return null
  return {
    longShortRatio: 1,
    longShortTrend: 'FLAT',
    fundingRate: mexc.fundingRate,
    fundingTrend: 'FLAT',
    openInterestChangePct: 0,
    known: true,
  }
}
