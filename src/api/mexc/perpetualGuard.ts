import {
  fetchFundingRate,
  fetchTicker,
  toApiSymbol,
} from './index'

const MIN_QUOTE_VOL = 1_000_000
const MIN_OI = 5_000

export interface PerpetualCheckResult {
  ok: boolean
  apiSymbol: string
  reason?: string
}

/**
 * Live check: symbol is a tradeable MEXC USDT-M perpetual
 * (ticker + funding rate endpoint — funding exists only for real perps).
 */
export async function assertUsdtPerpetual(
  symbol: string
): Promise<PerpetualCheckResult> {
  const apiSymbol = toApiSymbol(symbol)

  if (!apiSymbol.endsWith('_USDT') || apiSymbol.includes('USDC')) {
    return { ok: false, apiSymbol, reason: 'not_usdt_perp' }
  }

  try {
    const [ticker, funding] = await Promise.all([
      fetchTicker(apiSymbol),
      fetchFundingRate(apiSymbol),
    ])

    if (!ticker || !(ticker.lastPrice > 0)) {
      return { ok: false, apiSymbol, reason: 'no_ticker' }
    }
    if (ticker.volume24h < MIN_QUOTE_VOL) {
      return { ok: false, apiSymbol, reason: 'low_volume' }
    }
    if ((ticker.openInterest ?? 0) < MIN_OI) {
      return { ok: false, apiSymbol, reason: 'low_oi' }
    }
    if (ticker.fundingRate == null || Number.isNaN(ticker.fundingRate)) {
      return { ok: false, apiSymbol, reason: 'no_funding_on_ticker' }
    }
    if (!funding || funding.symbol !== apiSymbol) {
      return { ok: false, apiSymbol, reason: 'no_funding_endpoint' }
    }

    return { ok: true, apiSymbol }
  } catch {
    return { ok: false, apiSymbol, reason: 'verify_failed' }
  }
}
