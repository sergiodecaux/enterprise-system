import type { OhlcvCandle } from '../../api/mexc'

export interface VolumeSpikeResult {
  detected: boolean
  currentVolume: number
  avgVolume: number
  volumeMultiplier: number
  priceChangePct: number
  threshold: number
  quality: 'CRITICAL' | 'STRONG' | 'WEAK'
  label: string
  emoji: string
}

export function detectVolumeDeltaSpike(
  candles: OhlcvCandle[],
  volumeThreshold = 3.0,
  priceChangeThreshold = 1.5
): VolumeSpikeResult {
  const empty: VolumeSpikeResult = {
    detected: false,
    currentVolume: 0,
    avgVolume: 0,
    volumeMultiplier: 0,
    priceChangePct: 0,
    threshold: volumeThreshold,
    quality: 'WEAK',
    label: '',
    emoji: '',
  }

  if (candles.length < 30) return empty

  const lookback = 24
  const baseCandles = candles.slice(-(lookback + 1), -1)
  const avgVolume =
    baseCandles.reduce((sum, c) => sum + c[5], 0) / baseCandles.length

  if (avgVolume === 0) return empty

  const currentCandle = candles[candles.length - 1]
  const currentVolume = currentCandle[5]
  const currentClose = currentCandle[4]
  const currentOpen = currentCandle[1]

  const priceChangePct = ((currentClose - currentOpen) / currentOpen) * 100
  const volumeMultiplier = currentVolume / avgVolume

  const volumeSpikeDetected = volumeMultiplier >= volumeThreshold
  const priceMovementSignificant =
    Math.abs(priceChangePct) >= priceChangeThreshold

  if (!volumeSpikeDetected || !priceMovementSignificant) {
    return {
      ...empty,
      currentVolume,
      avgVolume,
      volumeMultiplier,
      priceChangePct,
    }
  }

  let quality: VolumeSpikeResult['quality'] = 'WEAK'
  let emoji = ''

  if (volumeMultiplier >= 5) {
    quality = 'CRITICAL'
    emoji = '🔥'
  } else if (volumeMultiplier >= 3) {
    quality = 'STRONG'
    emoji = '⚡'
  }

  const direction = priceChangePct > 0 ? 'вверх' : 'вниз'
  const label = `Всплеск объёма ${volumeMultiplier.toFixed(1)}x | Цена ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}% ${direction}`

  return {
    detected: true,
    currentVolume,
    avgVolume,
    volumeMultiplier,
    priceChangePct,
    threshold: volumeThreshold,
    quality,
    label,
    emoji,
  }
}
