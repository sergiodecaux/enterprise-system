import type { OrderBookSnapshot } from '../types'

export type ObVolumeShift = 'BUYING' | 'SELLING' | 'NEUTRAL'

export interface ObDeltaSnapshot {
  volumeShift: ObVolumeShift
  bidDelta: number
  askDelta: number
  imbalanceDelta: number
  updatedAt: number
}

function sumTop(
  levels: { price: number; volume: number }[],
  n: number
): number {
  return levels.slice(0, n).reduce((s, l) => s + l.volume, 0)
}

/**
 * Diff two depth snapshots → near-touch volume shift.
 */
export function calculateObDelta(
  prev: OrderBookSnapshot | null | undefined,
  next: OrderBookSnapshot,
  depth = 10
): ObDeltaSnapshot {
  const now = Date.now()
  if (!prev) {
    return {
      volumeShift: 'NEUTRAL',
      bidDelta: 0,
      askDelta: 0,
      imbalanceDelta: 0,
      updatedAt: now,
    }
  }

  const bidPrev = sumTop(prev.bids, depth)
  const askPrev = sumTop(prev.asks, depth)
  const bidNext = sumTop(next.bids, depth)
  const askNext = sumTop(next.asks, depth)

  const bidDelta = bidNext - bidPrev
  const askDelta = askNext - askPrev
  const imbPrev =
    bidPrev + askPrev > 0
      ? ((bidPrev - askPrev) / (bidPrev + askPrev)) * 100
      : 0
  const imbNext =
    bidNext + askNext > 0
      ? ((bidNext - askNext) / (bidNext + askNext)) * 100
      : 0
  const imbalanceDelta = imbNext - imbPrev

  let volumeShift: ObVolumeShift = 'NEUTRAL'
  // Bids growing / asks shrinking → buying pressure absorbed into book
  if (bidDelta > askDelta * 1.3 && imbalanceDelta > 2) volumeShift = 'BUYING'
  else if (askDelta > bidDelta * 1.3 && imbalanceDelta < -2)
    volumeShift = 'SELLING'

  return {
    volumeShift,
    bidDelta,
    askDelta,
    imbalanceDelta,
    updatedAt: now,
  }
}
