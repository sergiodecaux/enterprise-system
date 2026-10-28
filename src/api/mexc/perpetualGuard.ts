import {
  fetchDepth,
  fetchFundingRate,
  fetchTicker,
  isCommodityApiSymbol,
  toApiSymbol,
} from './index'

const MIN_QUOTE_VOL = 1_000_000
const MIN_COMMODITY_QUOTE_VOL = 500_000
/**
 * Open interest must be measured in USD, not raw contracts/coins:
 * 5,000 BTC is $300m+, while 5,000 PEPE is $0.05.
 */
const MIN_OI_USD = 750_000
/** Dead commodity CFDs on a crypto venue can have 0.3–0.5% spreads. */
const MAX_COMMODITY_SPREAD_PCT = 0.05
const MAX_CRYPTO_SPREAD_PCT = 0.35

export interface PerpetualCheckResult {
  ok: boolean
  apiSymbol: string
  reason?: string
}

async function spreadPct(apiSymbol: string): Promise<number | null> {
  try {
    const depth = await fetchDepth(apiSymbol, 5)
    const bid = depth.bids[0]?.price
    const ask = depth.asks[0]?.price
    if (!(bid > 0) || !(ask > 0) || ask < bid) return null
    const mid = (bid + ask) / 2
    return mid > 0 ? ((ask - bid) / mid) * 100 : null
  } catch {
    return null
  }
}

/**
 * Live check: symbol is a tradeable MEXC USDT-M perpetual
 * (ticker + funding rate endpoint — funding exists only for real perps).
 * Commodities (XAU/SILVER/USOIL) get an explicit liquidity + spread gate.
 */
export async function assertUsdtPerpetual(
  symbol: string
): Promise<PerpetualCheckResult> {
  const apiSymbol = toApiSymbol(symbol)

  if (!apiSymbol.endsWith('_USDT') || apiSymbol.includes('USDC')) {
    return { ok: false, apiSymbol, reason: 'not_usdt_perp' }
  }

  // Gold / silver / WTI oil are live USDT-M perps (funding may be 0).
  if (isCommodityApiSymbol(apiSymbol)) {
    try {
      const [ticker, spread] = await Promise.all([
        fetchTicker(apiSymbol),
        spreadPct(apiSymbol),
      ])
      if (!ticker || !(ticker.lastPrice > 0)) {
        return { ok: false, apiSymbol, reason: 'no_ticker' }
      }
      if (ticker.volume24h < MIN_COMMODITY_QUOTE_VOL) {
        return { ok: false, apiSymbol, reason: 'low_volume' }
      }
      if (spread == null || spread > MAX_COMMODITY_SPREAD_PCT) {
        return { ok: false, apiSymbol, reason: 'spread_too_wide' }
      }
      return { ok: true, apiSymbol }
    } catch {
      return { ok: false, apiSymbol, reason: 'verify_failed' }
    }
  }

  try {
    const [ticker, funding, spread] = await Promise.all([
      fetchTicker(apiSymbol),
      fetchFundingRate(apiSymbol),
      spreadPct(apiSymbol),
    ])

    if (!ticker || !(ticker.lastPrice > 0)) {
      return { ok: false, apiSymbol, reason: 'no_ticker' }
    }
    if (ticker.volume24h < MIN_QUOTE_VOL) {
      return { ok: false, apiSymbol, reason: 'low_volume' }
    }
    const openInterestUsd = (ticker.openInterest ?? 0) * ticker.lastPrice
    if (openInterestUsd < MIN_OI_USD) {
      return { ok: false, apiSymbol, reason: 'low_oi_usd' }
    }
    if (ticker.fundingRate == null || Number.isNaN(ticker.fundingRate)) {
      return { ok: false, apiSymbol, reason: 'no_funding_on_ticker' }
    }
    if (!funding || funding.symbol !== apiSymbol) {
      return { ok: false, apiSymbol, reason: 'no_funding_endpoint' }
    }
    if (spread != null && spread > MAX_CRYPTO_SPREAD_PCT) {
      return { ok: false, apiSymbol, reason: 'spread_too_wide' }
    }

    return { ok: true, apiSymbol }
  } catch {
    return { ok: false, apiSymbol, reason: 'verify_failed' }
  }
}
