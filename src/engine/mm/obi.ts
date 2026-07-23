import type { OrderBookLevel } from '../types'

export interface WeightedObiLevel {
  /** Depth band as % from mid (e.g. 0.1) */
  bandPct: number
  bidVolume: number
  askVolume: number
  /** (bid − ask) / (bid + ask), −1…+1 */
  imbalance: number
  /** bid / ask ratio (∞ capped) */
  bidAskRatio: number
}

export interface WeightedObiResult {
  midPrice: number
  levels: WeightedObiLevel[]
  /** Near-touch (0.1%) signal */
  nearTouchPressure: 'BUY' | 'SELL' | 'NEUTRAL'
  /** Impulse probability hint 0–100 when near ratio extreme */
  impulseProbPct: number
  label: string
}

const DEFAULT_BANDS = [0.1, 0.5, 1.0] as const
const NEAR_RATIO_TRIGGER = 3

function volumeInBand(
  levels: OrderBookLevel[],
  mid: number,
  bandPct: number,
  side: 'BID' | 'ASK'
): number {
  const maxDist = mid * (bandPct / 100)
  let vol = 0
  for (const l of levels) {
    const dist = side === 'BID' ? mid - l.price : l.price - mid
    if (dist >= 0 && dist <= maxDist) vol += l.volume
  }
  return vol
}

/**
 * Weighted Order Book Imbalance по близости к цене (0.1% / 0.5% / 1%).
 */
export function calculateWeightedObi(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  bands: readonly number[] = DEFAULT_BANDS
): WeightedObiResult | null {
  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  if (bestBid == null || bestAsk == null || bestBid <= 0) return null

  const midPrice = (bestBid + bestAsk) / 2
  const levels: WeightedObiLevel[] = []

  for (const bandPct of bands) {
    const bidVolume = volumeInBand(bids, midPrice, bandPct, 'BID')
    const askVolume = volumeInBand(asks, midPrice, bandPct, 'ASK')
    const total = bidVolume + askVolume
    const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0
    const bidAskRatio =
      askVolume > 0 ? bidVolume / askVolume : bidVolume > 0 ? 99 : 1
    levels.push({ bandPct, bidVolume, askVolume, imbalance, bidAskRatio })
  }

  const near = levels[0]
  let nearTouchPressure: WeightedObiResult['nearTouchPressure'] = 'NEUTRAL'
  let impulseProbPct = 50
  let label = 'OBI нейтрален'

  if (near) {
    if (near.bidAskRatio >= NEAR_RATIO_TRIGGER) {
      nearTouchPressure = 'BUY'
      impulseProbPct = 85
      label = `OBI 0.1%: Bids ×${near.bidAskRatio.toFixed(1)} vs Asks — давление вверх ~30с`
    } else if (near.bidAskRatio > 0 && near.bidAskRatio <= 1 / NEAR_RATIO_TRIGGER) {
      nearTouchPressure = 'SELL'
      impulseProbPct = 85
      label = `OBI 0.1%: Asks ×${(1 / near.bidAskRatio).toFixed(1)} vs Bids — давление вниз ~30с`
    }
  }

  return {
    midPrice,
    levels,
    nearTouchPressure,
    impulseProbPct,
    label,
  }
}

/** Aligns with trade direction? */
export function obiSupportsDirection(
  obi: WeightedObiResult | null,
  direction: 'LONG' | 'SHORT'
): boolean {
  if (!obi) return false
  if (direction === 'LONG') return obi.nearTouchPressure === 'BUY'
  return obi.nearTouchPressure === 'SELL'
}
