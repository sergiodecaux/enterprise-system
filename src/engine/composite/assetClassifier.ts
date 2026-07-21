import type { TrendDirection } from '../smc'
import type { BuyerAggressionResult } from '../types'
import type { SpreadPressureResult } from '../meme'
import { isMemeTicker } from '../meme/memeFilter'
import type { MexcTicker } from '../../api/mexc'

export type AssetType = 'BLUE_CHIP' | 'ALT' | 'MEME'
export type MarketPhase =
  | 'ACCUMULATION'
  | 'DISTRIBUTION'
  | 'UPTREND'
  | 'DOWNTREND'
  | 'RANGING'
export type DominantForce =
  | 'STRONG_BUYERS'
  | 'BUYERS'
  | 'NEUTRAL'
  | 'SELLERS'
  | 'STRONG_SELLERS'
export type VolatilityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME'

const BLUE_CHIPS = new Set([
  'BTC',
  'ETH',
  'BNB',
  'SOL',
  'XRP',
  'ADA',
  'AVAX',
  'DOGE',
  'DOT',
  'MATIC',
  'POL',
  'LINK',
  'LTC',
])

export function getAssetBase(internalSymbol: string): string {
  return internalSymbol.split('/')[0]
}

/**
 * Классифицирует монету по типу актива
 */
export function classifyAsset(
  internalSymbol: string,
  priceChange24h: number,
  spreadPressure?: SpreadPressureResult,
  options?: {
    hasMemePulse?: boolean
    ticker?: Pick<MexcTicker, 'lastPrice' | 'volume24h'>
  }
): AssetType {
  const base = getAssetBase(internalSymbol)

  if (options?.hasMemePulse) {
    return 'MEME'
  }

  if (BLUE_CHIPS.has(base)) {
    return 'BLUE_CHIP'
  }

  if (options?.ticker && isMemeTicker(options.ticker as MexcTicker)) {
    return 'MEME'
  }

  const hasExtremeVolatility = Math.abs(priceChange24h) > 15
  const hasHighSpreadPressure =
    spreadPressure &&
    (spreadPressure.quality === 'EXTREME' || spreadPressure.quality === 'STRONG')

  if (hasExtremeVolatility && hasHighSpreadPressure) {
    return 'MEME'
  }

  return 'ALT'
}

/**
 * Определяет фазу рынка на основе структуры и цены
 */
export function detectMarketPhase(
  coinTrend: TrendDirection,
  priceVsEma200 = 1.0,
  volumeProfile: 'INCREASING' | 'DECREASING' | 'STABLE' = 'STABLE'
): MarketPhase {
  if (
    coinTrend === 'RANGING' &&
    volumeProfile !== 'DECREASING' &&
    priceVsEma200 > 0.98
  ) {
    return 'ACCUMULATION'
  }

  if (
    coinTrend === 'RANGING' &&
    volumeProfile === 'INCREASING' &&
    priceVsEma200 < 1.02
  ) {
    return 'DISTRIBUTION'
  }

  if (coinTrend === 'BULLISH') return 'UPTREND'
  if (coinTrend === 'BEARISH') return 'DOWNTREND'
  return 'RANGING'
}

/**
 * Определяет доминирующую силу (покупатели/продавцы)
 * orderBookImbalance: -100..+100 (%)
 */
export function detectDominantForce(
  spreadPressure?: SpreadPressureResult,
  buyerAggression?: BuyerAggressionResult | null,
  orderBookImbalance?: number
): DominantForce {
  let score = 0

  if (spreadPressure) {
    if (spreadPressure.pressure === 'BUYERS') {
      if (spreadPressure.quality === 'EXTREME') score += 0.4
      else if (spreadPressure.quality === 'STRONG') score += 0.3
      else score += 0.15
    } else if (spreadPressure.pressure === 'SELLERS') {
      if (spreadPressure.quality === 'EXTREME') score -= 0.4
      else if (spreadPressure.quality === 'STRONG') score -= 0.3
      else score -= 0.15
    }
  }

  if (buyerAggression?.detected) {
    score += 0.3
  }

  if (orderBookImbalance !== undefined) {
    const normalized = orderBookImbalance / 100
    score += normalized * 0.3
  }

  if (score >= 0.5) return 'STRONG_BUYERS'
  if (score >= 0.2) return 'BUYERS'
  if (score <= -0.5) return 'STRONG_SELLERS'
  if (score <= -0.2) return 'SELLERS'
  return 'NEUTRAL'
}

/**
 * Определяет уровень волатильности
 */
export function detectVolatilityLevel(
  priceChange24h: number,
  assetType?: AssetType
): VolatilityLevel {
  const change24hAbs = Math.abs(priceChange24h)
  const isMeme = assetType === 'MEME' || change24hAbs > 15

  if (isMeme) {
    if (change24hAbs > 50) return 'EXTREME'
    if (change24hAbs > 25) return 'HIGH'
    return 'MEDIUM'
  }

  if (change24hAbs > 20) return 'EXTREME'
  if (change24hAbs > 10) return 'HIGH'
  if (change24hAbs > 5) return 'MEDIUM'
  return 'LOW'
}
