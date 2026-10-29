import type { OhlcvCandle } from '../../../api/mexc'

/**
 * Visual-only estimate of a large leveraged position trapped on the chart.
 *
 * IMPORTANT: this module is intentionally isolated from the signal engine.
 * Nothing here is imported by `src/engine/**`, scoring, signal cards, setup
 * generation or limit cases. It only feeds the chart overlay.
 */
export interface WhalePosition {
  id: string
  symbol: string
  side: 'LONG' | 'SHORT'
  sizeUsd: number
  leverage: number
  entryPrice: number
  liqPrice: number
  entryTime: number
  distancePct: number
  unrealizedPnlUsd: number
  isUnderwater: boolean
}

const MIN_CANDLES = 20
const LOOKBACK = 100
const MAINTENANCE_MARGIN_RATE = 0.005
const SIZE_STEP_USD = 100_000
const BTC_SIZE_FLOOR_USD = 24_000_000
const ALT_SIZE_FLOOR_USD = 3_500_000

/**
 * Institutional leverage is estimated, not fetched from an exchange.
 * Majors usually run tighter liquidation bands than altcoins.
 */
function estimateLeverage(symbol: string): number {
  const upper = symbol.toUpperCase()
  if (upper.includes('BTC')) return 40
  if (upper.includes('ETH')) return 30
  return 25
}

/**
 * Find the dominant volume spike in the recent history and derive the
 * liquidation band of the position that likely opened there.
 *
 * The result is a visual magnet, not an order-book fact: MEXC does not expose
 * per-whale leverage or entry prices through the public API.
 */
export function detectDominantWhaleTrap(
  candles: readonly OhlcvCandle[],
  currentPrice: number,
  symbol: string
): WhalePosition | null {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null

  const lookback = candles.slice(-LOOKBACK)
  let maxVolCandle: OhlcvCandle | null = null
  let maxVolUsd = 0

  for (const candle of lookback) {
    const [, , , , close, volume] = candle
    if (!Number.isFinite(close) || !Number.isFinite(volume)) continue
    if (close <= 0 || volume <= 0) continue

    const volUsd = volume * close
    if (!Number.isFinite(volUsd) || volUsd <= 0) continue
    if (volUsd > maxVolUsd) {
      maxVolUsd = volUsd
      maxVolCandle = candle
    }
  }

  if (!maxVolCandle || maxVolUsd <= 0) return null

  const [entryTime, open, , , close] = maxVolCandle
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= 0) {
    return null
  }

  const isLong = close >= open
  const entryPrice = close
  const leverage = estimateLeverage(symbol)

  // Standard isolated-margin approximation:
  // LONG  -> entry * (1 - 1/leverage + MMR)
  // SHORT -> entry * (1 + 1/leverage - MMR)
  const liqPrice = isLong
    ? entryPrice * (1 - 1 / leverage + MAINTENANCE_MARGIN_RATE)
    : entryPrice * (1 + 1 / leverage - MAINTENANCE_MARGIN_RATE)

  if (!Number.isFinite(liqPrice) || liqPrice <= 0) return null

  // Visual size estimate: the spike's notional, scaled by leverage.
  const estimatedSizeUsd =
    Math.round((maxVolUsd * leverage * 0.4) / SIZE_STEP_USD) * SIZE_STEP_USD
  if (!Number.isFinite(estimatedSizeUsd)) return null

  const sizeUsd = Math.max(
    estimatedSizeUsd,
    symbol.toUpperCase().includes('BTC') ? BTC_SIZE_FLOOR_USD : ALT_SIZE_FLOOR_USD
  )

  const distancePct =
    Math.abs((currentPrice - liqPrice) / currentPrice) * 100

  // The whale is in pain when price moved against the entry but has not yet
  // crossed the liquidation level.
  const isUnderwater = isLong
    ? currentPrice < entryPrice && currentPrice > liqPrice
    : currentPrice > entryPrice && currentPrice < liqPrice

  const priceDiffPct = (currentPrice - entryPrice) / entryPrice
  const unrealizedPnlUsd = sizeUsd * (isLong ? priceDiffPct : -priceDiffPct)

  return {
    id: `whale-${symbol}-${entryTime}`,
    symbol,
    side: isLong ? 'LONG' : 'SHORT',
    sizeUsd,
    leverage,
    entryPrice,
    liqPrice,
    entryTime,
    distancePct: Number(distancePct.toFixed(2)),
    unrealizedPnlUsd: Math.round(unrealizedPnlUsd),
    isUnderwater,
  }
}
