import type { MexcTrade } from '../../api/mexc'

const qualityRu = (q: SpreadPressureResult['quality']): string => {
  switch (q) {
    case 'EXTREME':
      return 'экстрем'
    case 'STRONG':
      return 'сильно'
    case 'MODERATE':
      return 'умеренно'
    default:
      return 'слабо'
  }
}

const pressureRu = (p: SpreadPressureResult['pressure']): string => {
  switch (p) {
    case 'BUYERS':
      return 'покупатели'
    case 'SELLERS':
      return 'продавцы'
    default:
      return '—'
  }
}

export interface SpreadPressureResult {
  pressure: 'BUYERS' | 'SELLERS' | 'NEUTRAL'
  cumulativeDelta: number
  totalBuyVolume: number
  totalSellVolume: number
  buyToSellRatio: number
  deltaVelocity: number
  quality: 'EXTREME' | 'STRONG' | 'MODERATE' | 'WEAK'
  pressureBarPct: number
  label: string
  color: string
  windowSec: number
}

export function analyzeSpreadPressure(
  trades: MexcTrade[],
  windowSec = 60
): SpreadPressureResult {
  const empty: SpreadPressureResult = {
    pressure: 'NEUTRAL',
    cumulativeDelta: 0,
    totalBuyVolume: 0,
    totalSellVolume: 0,
    buyToSellRatio: 1,
    deltaVelocity: 0,
    quality: 'WEAK',
    pressureBarPct: 50,
    label: 'Нейтрально',
    color: '#555555',
    windowSec,
  }

  if (!trades || trades.length < 5) return empty

  const now = Date.now()
  const cutoff = now - windowSec * 1000

  const recentTrades = trades.filter((t) => t.timestamp >= cutoff)

  if (recentTrades.length < 3) return empty

  let totalBuyVolume = 0
  let totalSellVolume = 0

  for (const trade of recentTrades) {
    if (trade.side === 'BUY') {
      totalBuyVolume += trade.volume
    } else {
      totalSellVolume += trade.volume
    }
  }

  if (totalSellVolume === 0) totalSellVolume = 0.0001

  const cumulativeDelta = totalBuyVolume - totalSellVolume
  const buyToSellRatio = totalBuyVolume / totalSellVolume
  const deltaVelocity = cumulativeDelta / windowSec

  let pressure: SpreadPressureResult['pressure'] = 'NEUTRAL'
  let quality: SpreadPressureResult['quality'] = 'WEAK'
  let color = '#6b7280'
  let label = 'Нейтрально'

  const EXTREME_THRESHOLD = 5.0
  const STRONG_THRESHOLD = 3.0
  const MODERATE_THRESHOLD = 1.5

  if (buyToSellRatio >= EXTREME_THRESHOLD) {
    pressure = 'BUYERS'
    quality = 'EXTREME'
    color = '#00ff41'
    label = `ЭКСТРЕМ давление покупателей ×${buyToSellRatio.toFixed(1)}`
  } else if (buyToSellRatio >= STRONG_THRESHOLD) {
    pressure = 'BUYERS'
    quality = 'STRONG'
    color = '#22c55e'
    label = `Сильное давление покупателей ×${buyToSellRatio.toFixed(1)}`
  } else if (buyToSellRatio >= MODERATE_THRESHOLD) {
    pressure = 'BUYERS'
    quality = 'MODERATE'
    color = '#84cc16'
    label = `Умеренное давление покупателей ×${buyToSellRatio.toFixed(1)}`
  } else if (buyToSellRatio <= 1 / EXTREME_THRESHOLD) {
    pressure = 'SELLERS'
    quality = 'EXTREME'
    color = '#ff003c'
    label = `ЭКСТРЕМ давление продавцов ×${(1 / buyToSellRatio).toFixed(1)}`
  } else if (buyToSellRatio <= 1 / STRONG_THRESHOLD) {
    pressure = 'SELLERS'
    quality = 'STRONG'
    color = '#ef4444'
    label = `Сильное давление продавцов ×${(1 / buyToSellRatio).toFixed(1)}`
  } else if (buyToSellRatio <= 1 / MODERATE_THRESHOLD) {
    pressure = 'SELLERS'
    quality = 'MODERATE'
    color = '#f87171'
    label = `Умеренное давление продавцов ×${(1 / buyToSellRatio).toFixed(1)}`
  }

  let pressureBarPct = 50
  if (pressure === 'BUYERS') {
    pressureBarPct = Math.min(50 + (buyToSellRatio / 10) * 50, 100)
  } else if (pressure === 'SELLERS') {
    pressureBarPct = Math.max((buyToSellRatio / 1) * 50, 0)
  }

  return {
    pressure,
    cumulativeDelta,
    totalBuyVolume,
    totalSellVolume,
    buyToSellRatio,
    deltaVelocity,
    quality,
    pressureBarPct,
    label,
    color,
    windowSec,
  }
}

export function isAggressionFading(
  currentPressure: SpreadPressureResult,
  previousPressure: SpreadPressureResult | null
): { fading: boolean; reason: string } {
  if (!previousPressure) return { fading: false, reason: '' }

  if (
    previousPressure.pressure === 'BUYERS' &&
    (previousPressure.quality === 'EXTREME' ||
      previousPressure.quality === 'STRONG') &&
    currentPressure.pressure === 'BUYERS' &&
    (currentPressure.quality === 'MODERATE' ||
      currentPressure.quality === 'WEAK')
  ) {
    return {
      fading: true,
      reason: `Давление покупателей ослабло: ${qualityRu(previousPressure.quality)} → ${qualityRu(currentPressure.quality)}`,
    }
  }

  if (
    previousPressure.pressure === 'SELLERS' &&
    (previousPressure.quality === 'EXTREME' ||
      previousPressure.quality === 'STRONG') &&
    currentPressure.pressure === 'SELLERS' &&
    (currentPressure.quality === 'MODERATE' ||
      currentPressure.quality === 'WEAK')
  ) {
    return {
      fading: true,
      reason: `Давление продавцов ослабло: ${qualityRu(previousPressure.quality)} → ${qualityRu(currentPressure.quality)}`,
    }
  }

  if (
    previousPressure.pressure !== 'NEUTRAL' &&
    currentPressure.pressure !== 'NEUTRAL' &&
    previousPressure.pressure !== currentPressure.pressure
  ) {
    return {
      fading: true,
      reason: `Смена давления: ${pressureRu(previousPressure.pressure)} → ${pressureRu(currentPressure.pressure)}`,
    }
  }

  return { fading: false, reason: '' }
}
