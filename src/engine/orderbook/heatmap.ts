import type { OrderBookSnapshot, HeatmapState, PriceLevel } from '../types'

export function createHeatmap(priceStep = 0.1): HeatmapState {
  return {
    levels: new Map(),
    maxVolume: 0,
    priceStep,
  }
}

/** Adaptive step by mid price for better heatmap on cheap coins */
export function suggestPriceStep(midPrice: number | null): number {
  if (midPrice == null || midPrice <= 0) return 0.1
  if (midPrice >= 1000) return 0.1
  if (midPrice >= 100) return 0.01
  if (midPrice >= 1) return 0.001
  if (midPrice >= 0.01) return 0.0001
  return 0.000001
}

function roundPrice(price: number, step: number): number {
  if (step <= 0) return price
  const decimals = Math.max(0, Math.min(8, Math.ceil(-Math.log10(step))))
  const rounded = Math.round(price / step) * step
  return Number(rounded.toFixed(decimals))
}

export function updateHeatmap(
  heatmap: HeatmapState,
  snapshot: OrderBookSnapshot
): HeatmapState {
  const now = Date.now()
  const levels = new Map(heatmap.levels)
  const { priceStep } = heatmap
  let maxVolume = heatmap.maxVolume

  const allLevels = [
    ...snapshot.bids.map((l) => ({ price: l.price, volume: l.volume })),
    ...snapshot.asks.map((l) => ({ price: l.price, volume: l.volume })),
  ]

  for (const { price, volume } of allLevels) {
    const roundedPrice = roundPrice(price, priceStep)
    const existing = levels.get(roundedPrice)

    if (existing) {
      const next: PriceLevel = {
        ...existing,
        totalVolume: existing.totalVolume + volume,
        appearances: existing.appearances + 1,
        lastSeen: now,
      }
      levels.set(roundedPrice, next)
      maxVolume = Math.max(maxVolume, next.totalVolume)
    } else {
      const newLevel: PriceLevel = {
        price: roundedPrice,
        totalVolume: volume,
        appearances: 1,
        firstSeen: now,
        lastSeen: now,
      }
      levels.set(roundedPrice, newLevel)
      maxVolume = Math.max(maxVolume, volume)
    }
  }

  const cleanupThreshold = now - 120_000
  levels.forEach((level, price) => {
    if (level.lastSeen < cleanupThreshold) {
      levels.delete(price)
    }
  })

  return {
    levels,
    maxVolume,
    priceStep,
  }
}

export function getHeatIntensity(heatmap: HeatmapState, price: number): number {
  const roundedPrice = roundPrice(price, heatmap.priceStep)
  const level = heatmap.levels.get(roundedPrice)
  if (!level || heatmap.maxVolume === 0) return 0
  return Math.min(level.totalVolume / heatmap.maxVolume, 1)
}

export function getTopLevels(heatmap: HeatmapState, count = 5): PriceLevel[] {
  return Array.from(heatmap.levels.values())
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, count)
}
