import type { OrderBookSnapshot } from '../types'

export interface Heatmap3DPoint {
  x: number
  y: number
  z: number
  volume: number
  price: number
  side: 'BID' | 'ASK'
}

export interface Heatmap3DState {
  points: Heatmap3DPoint[]
  snapshots: OrderBookSnapshot[]
  maxVolume: number
  priceRange: { min: number; max: number }
  maxHistory: number
}

export function createHeatmap3D(maxHistory = 60): Heatmap3DState {
  return {
    points: [],
    snapshots: [],
    maxVolume: 0,
    priceRange: { min: Infinity, max: -Infinity },
    maxHistory,
  }
}

export function addSnapshot3D(
  state: Heatmap3DState,
  snapshot: OrderBookSnapshot
): Heatmap3DState {
  const newSnapshots = [...state.snapshots, snapshot]
  if (newSnapshots.length > state.maxHistory) {
    newSnapshots.shift()
  }

  const points: Heatmap3DPoint[] = []
  let maxVolume = 0
  let minPrice = Infinity
  let maxPrice = -Infinity

  newSnapshots.forEach((snap, timeIndex) => {
    const pushLevel = (price: number, volume: number, side: 'BID' | 'ASK') => {
      points.push({
        x: price,
        y: timeIndex,
        z: volume,
        volume,
        price,
        side,
      })
      maxVolume = Math.max(maxVolume, volume)
      minPrice = Math.min(minPrice, price)
      maxPrice = Math.max(maxPrice, price)
    }

    // Downsample levels for 3D perf (every 2nd)
    snap.bids.forEach((level, i) => {
      if (i % 2 === 0) pushLevel(level.price, level.volume, 'BID')
    })
    snap.asks.forEach((level, i) => {
      if (i % 2 === 0) pushLevel(level.price, level.volume, 'ASK')
    })
  })

  const priceSpan = maxPrice - minPrice
  for (const p of points) {
    p.x = priceSpan > 0 ? ((p.price - minPrice) / priceSpan) * 2 - 1 : 0
    p.y =
      state.maxHistory > 1
        ? (p.y / Math.max(1, newSnapshots.length - 1)) * 2 - 1
        : 0
    p.z = maxVolume > 0 ? (p.volume / maxVolume) * 1.5 : 0
  }

  // Cap points for WebGL
  const capped = points.length > 800 ? points.slice(-800) : points

  return {
    points: capped,
    snapshots: newSnapshots,
    maxVolume,
    priceRange: {
      min: Number.isFinite(minPrice) ? minPrice : 0,
      max: Number.isFinite(maxPrice) ? maxPrice : 0,
    },
    maxHistory: state.maxHistory,
  }
}
