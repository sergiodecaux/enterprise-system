import type { OhlcvCandle, MexcTrade } from '../../api/mexc'
import type { OrderBookSnapshot } from '../types'
import type { MemeSignal } from '../types'
import { detectVolumeDeltaSpike } from './volumeSpike'
import { analyzeLiquidityGap } from './liquidityGap'
import { detectMeanReversion } from './meanReversion'
import { analyzeSpreadPressure } from './spreadPressure'
import { detectShortSqueeze } from './squeeze'
import { detectMemeLifecycle } from './lifecycle'
import { detectBidVoid } from './bidVoid'
import { detectFlatlineBreakout } from './flatline'
import { detectToxicChop } from './toxic'
import { detectBacksideShort } from './backside'
import { detectIcebergAbsorption } from './absorptionAlert'
import { detectCvdTrap } from './cvdTrap'
import { calculateVolatilityGauge } from './volatility'
import { recordOpenInterest } from './fuelCache'

export interface MemeFuelInput {
  fundingRate?: number | null
  openInterest?: number | null
  ohlcv5m?: OhlcvCandle[] | null
}

export function computeMemeHeatScore(parts: {
  volumeSpike: MemeSignal['volumeSpike']
  liquidityGap: MemeSignal['liquidityGap']
  meanReversion: MemeSignal['meanReversion']
  spreadPressure: MemeSignal['spreadPressure']
  squeezeBoost?: number
  flatlineBoost?: number
  backsideBoost?: number
  cvdTrapBoost?: number
  absorptionBoost?: number
  toxicPenalty?: number
  bidVoidPenalty?: number
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

  heatScore += parts.squeezeBoost ?? 0
  heatScore += parts.flatlineBoost ?? 0
  heatScore += parts.backsideBoost ?? 0
  heatScore += parts.cvdTrapBoost ?? 0
  heatScore += parts.absorptionBoost ?? 0
  heatScore -= parts.toxicPenalty ?? 0
  heatScore -= parts.bidVoidPenalty ?? 0

  return Math.max(0, Math.min(100, heatScore))
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
  trades: MexcTrade[],
  fuel?: MemeFuelInput
): MemeSignal {
  if (fuel?.openInterest != null) {
    recordOpenInterest(internalSymbol, fuel.openInterest)
  }

  const volumeSpike = detectVolumeDeltaSpike(ohlcv1m, 3.0, 1.5)
  const liquidityGap = analyzeLiquidityGap(depth, price, 3.0, 3.0)
  const meanReversion = detectMeanReversion(ohlcv1m, 85, 15)
  const spreadPressure = analyzeSpreadPressure(trades, 60)

  const squeeze = detectShortSqueeze(
    internalSymbol,
    fuel?.fundingRate,
    fuel?.openInterest,
    ohlcv1m,
    priceChange24h
  )

  const lifecycle = detectMemeLifecycle(ohlcv1m, fuel?.ohlcv5m ?? undefined)
  const nearHighs =
    priceChange24h >= 20 ||
    lifecycle.phase === 'FRENZY' ||
    lifecycle.phase === 'DISTRIBUTION'
  const bidVoid = detectBidVoid(internalSymbol, depth, price, nearHighs)
  const flatline = detectFlatlineBreakout(ohlcv1m)
  const toxic = detectToxicChop(ohlcv1m)

  const fundingNormalized =
    fuel?.fundingRate == null || Math.abs(fuel.fundingRate) < 0.0005
  const backside = detectBacksideShort(
    ohlcv1m,
    fuel?.ohlcv5m ?? null,
    fundingNormalized
  )
  const absorptionAlert = detectIcebergAbsorption(trades, ohlcv1m)
  const cvdTrap = detectCvdTrap(ohlcv1m)
  const volatility = calculateVolatilityGauge(ohlcv1m)

  const heatScore = computeMemeHeatScore({
    volumeSpike,
    liquidityGap,
    meanReversion,
    spreadPressure,
    squeezeBoost: squeeze.scoreBoost,
    flatlineBoost: flatline.scoreBoost,
    backsideBoost: backside.scoreBoost,
    cvdTrapBoost: cvdTrap.scoreBoost,
    absorptionBoost:
      absorptionAlert.type === 'ACCUMULATION'
        ? absorptionAlert.scoreBoost
        : 0,
    toxicPenalty: toxic.scorePenalty,
    bidVoidPenalty: bidVoid.scorePenalty,
  })

  let { quality, recommendation } = resolveMemeQuality(heatScore)

  const longBlocked =
    toxic.entryBlocked ||
    bidVoid.longBlocked ||
    absorptionAlert.longBlocked ||
    lifecycle.phase === 'DISTRIBUTION' ||
    lifecycle.phase === 'WATERFALL' ||
    !lifecycle.longAllowed

  const shortBlocked =
    toxic.entryBlocked ||
    squeeze.shortBlocked ||
    lifecycle.phase === 'IGNITION' ||
    lifecycle.phase === 'FRENZY' ||
    !lifecycle.shortAllowed

  // Force elite tags
  let setupTag: string | null = null
  let criticalAlert: string | null = null

  if (squeeze.inProgress) {
    setupTag = '🚀 SHORT SQUEEZE'
    criticalAlert = squeeze.alert
    quality = 'CRITICAL'
    recommendation = 'QUICK_ENTRY'
  } else if (squeeze.setup) {
    setupTag = '🚀 SQUEEZE SETUP'
    criticalAlert = squeeze.alert
  } else if (flatline.detected && flatline.scoreBoost >= 40) {
    setupTag = '🔥 IGNITION'
    criticalAlert = flatline.alert
    quality = 'CRITICAL'
    recommendation = 'QUICK_ENTRY'
  } else if (backside.detected) {
    setupTag = '🎯 BACKSIDE SHORT'
    criticalAlert = backside.alert
    quality = 'CRITICAL'
    recommendation = 'QUICK_ENTRY'
  } else if (cvdTrap.detected) {
    setupTag = '🎯 CVD TRAP LONG'
    criticalAlert = cvdTrap.alert
  } else if (absorptionAlert.detected && absorptionAlert.type === 'DISTRIBUTION') {
    setupTag = '🛑 ABSORPTION'
    criticalAlert = absorptionAlert.alert
    recommendation = 'WAIT'
  } else if (toxic.detected) {
    setupTag = '☠️ TOXIC'
    criticalAlert = toxic.label
    recommendation = 'WAIT'
  } else if (lifecycle.phase !== 'UNKNOWN') {
    setupTag = lifecycle.badge
  }

  if (bidVoid.alert) {
    criticalAlert = criticalAlert ?? bidVoid.alert
  }

  if (longBlocked && recommendation === 'QUICK_ENTRY' && !backside.detected && !squeeze.setup && !squeeze.inProgress) {
    // Don't quick-enter long into void/distribution unless squeeze
    if (!squeeze.detected) recommendation = 'MONITOR'
  }

  if (toxic.entryBlocked) {
    recommendation = 'WAIT'
  }

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
    squeeze,
    lifecycle,
    bidVoid,
    flatline,
    toxic,
    backside,
    absorptionAlert,
    cvdTrap,
    volatility,
    longBlocked,
    shortBlocked,
    criticalAlert,
    setupTag,
  }
}
