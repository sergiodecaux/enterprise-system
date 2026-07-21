import type { OhlcvCandle, MexcTrade } from '../../api/mexc'
import type { OrderBookSnapshot } from '../types'
import type { MemeSignal } from '../types'
import { detectVolumeDeltaSpike } from './volumeSpike'
import { analyzeLiquidityGap } from './liquidityGap'
import { detectMeanReversion } from './meanReversion'
import { analyzeSpreadPressure } from './spreadPressure'

export function computeMemeHeatScore(parts: {
  volumeSpike: MemeSignal['volumeSpike']
  liquidityGap: MemeSignal['liquidityGap']
  meanReversion: MemeSignal['meanReversion']
  spreadPressure: MemeSignal['spreadPressure']
}): number {
  let heatScore = 0

  if (parts.volumeSpike.detected) {
    if (parts.volumeSpike.quality === 'CRITICAL') heatScore += 30
    else if (parts.volumeSpike.quality === 'STRONG') heatScore += 20
  }

  if (parts.liquidityGap.detected) {
    if (parts.liquidityGap.quality === 'EXTREME') heatScore += 25
    else if (parts.liquidityGap.quality === 'SIGNIFICANT') heatScore += 15
  }

  if (parts.meanReversion.detected) {
    if (parts.meanReversion.quality === 'STRONG') heatScore += 20
    else if (parts.meanReversion.quality === 'MODERATE') heatScore += 10
  }

  if (parts.spreadPressure.pressure !== 'NEUTRAL') {
    if (parts.spreadPressure.quality === 'EXTREME') heatScore += 25
    else if (parts.spreadPressure.quality === 'STRONG') heatScore += 15
    else if (parts.spreadPressure.quality === 'MODERATE') heatScore += 8
  }

  return heatScore
}

export function resolveMemeQuality(
  heatScore: number
): Pick<MemeSignal, 'quality' | 'recommendation'> {
  if (heatScore >= 70) {
    return { quality: 'CRITICAL', recommendation: 'QUICK_ENTRY' }
  }
  if (heatScore >= 50) {
    return { quality: 'STRONG', recommendation: 'QUICK_ENTRY' }
  }
  if (heatScore >= 30) {
    return { quality: 'MODERATE', recommendation: 'MONITOR' }
  }
  return { quality: 'WEAK', recommendation: 'WAIT' }
}

export function analyzeMemeMarketData(
  internalSymbol: string,
  displayName: string,
  flatSymbol: string,
  price: number,
  priceChange24h: number,
  ohlcv1m: OhlcvCandle[],
  depth: OrderBookSnapshot,
  trades: MexcTrade[]
): MemeSignal {
  const volumeSpike = detectVolumeDeltaSpike(ohlcv1m, 3.0, 1.5)
  const liquidityGap = analyzeLiquidityGap(depth, price, 3.0, 3.0)
  const meanReversion = detectMeanReversion(ohlcv1m, 85, 15)
  const spreadPressure = analyzeSpreadPressure(trades, 60)

  const heatScore = computeMemeHeatScore({
    volumeSpike,
    liquidityGap,
    meanReversion,
    spreadPressure,
  })

  const { quality, recommendation } = resolveMemeQuality(heatScore)

  return {
    symbol: flatSymbol,
    internalSymbol,
    displayName,
    price,
    priceChange24h,
    volumeSpike,
    liquidityGap,
    meanReversion,
    spreadPressure,
    heatScore,
    quality,
    recommendation,
    updatedAt: Date.now(),
  }
}
