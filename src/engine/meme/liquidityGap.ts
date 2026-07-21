import type { OrderBookSnapshot } from '../types'

export interface LiquidityGapResult {
  detected: boolean
  upwardGapPct: number | null
  downwardGapPct: number | null
  direction: 'UP' | 'DOWN' | 'NEUTRAL'
  nearestAskWall: number | null
  nearestBidWall: number | null
  quality: 'EXTREME' | 'SIGNIFICANT' | 'WEAK'
  label: string
  emoji: string
}

export function analyzeLiquidityGap(
  orderBook: OrderBookSnapshot,
  currentPrice: number,
  wallThreshold = 3.0,
  gapThreshold = 3.0
): LiquidityGapResult {
  const empty: LiquidityGapResult = {
    detected: false,
    upwardGapPct: null,
    downwardGapPct: null,
    direction: 'NEUTRAL',
    nearestAskWall: null,
    nearestBidWall: null,
    quality: 'WEAK',
    label: 'Нет значимого гэпа',
    emoji: '',
  }

  if (
    !orderBook.asks.length ||
    !orderBook.bids.length ||
    currentPrice === 0
  ) {
    return empty
  }

  const avgAskVolume =
    orderBook.asks.reduce((sum, a) => sum + a.volume, 0) /
    orderBook.asks.length
  const avgBidVolume =
    orderBook.bids.reduce((sum, b) => sum + b.volume, 0) /
    orderBook.bids.length

  const significantAsks = orderBook.asks.filter(
    (ask) =>
      ask.price > currentPrice && ask.volume >= avgAskVolume * wallThreshold
  )
  const nearestAskWall = significantAsks.length
    ? significantAsks[0].price
    : null

  const significantBids = orderBook.bids.filter(
    (bid) =>
      bid.price < currentPrice && bid.volume >= avgBidVolume * wallThreshold
  )
  const nearestBidWall = significantBids.length
    ? significantBids[0].price
    : null

  const upwardGapPct = nearestAskWall
    ? ((nearestAskWall - currentPrice) / currentPrice) * 100
    : null

  const downwardGapPct = nearestBidWall
    ? ((currentPrice - nearestBidWall) / currentPrice) * 100
    : null

  let direction: LiquidityGapResult['direction'] = 'NEUTRAL'
  let maxGapPct = 0

  if (upwardGapPct !== null && upwardGapPct >= gapThreshold) {
    if (downwardGapPct === null || upwardGapPct > downwardGapPct) {
      direction = 'UP'
      maxGapPct = upwardGapPct
    }
  }

  if (downwardGapPct !== null && downwardGapPct >= gapThreshold) {
    if (upwardGapPct === null || downwardGapPct > upwardGapPct) {
      direction = 'DOWN'
      maxGapPct = downwardGapPct
    }
  }

  if (direction === 'NEUTRAL') {
    return {
      ...empty,
      upwardGapPct,
      downwardGapPct,
      nearestAskWall,
      nearestBidWall,
    }
  }

  let quality: LiquidityGapResult['quality'] = 'WEAK'
  let emoji = ''

  if (maxGapPct >= 5) {
    quality = 'EXTREME'
    emoji = '🚀'
  } else if (maxGapPct >= 3) {
    quality = 'SIGNIFICANT'
    emoji = '💨'
  }

  const label = `Гэп ${direction === 'UP' ? 'вверх' : 'вниз'}: ${maxGapPct.toFixed(2)}% пустоты до стенки`

  return {
    detected: true,
    upwardGapPct,
    downwardGapPct,
    direction,
    nearestAskWall,
    nearestBidWall,
    quality,
    label,
    emoji,
  }
}
