import type { MexcTrade } from '../../api/mexc'
import type { OrderBookLevel } from '../types'

export interface IcebergResult {
  detected: boolean
  side: 'BID' | 'ASK' | null
  price: number
  tradedVolume: number
  bookDelta: number
  hiddenVolumeEstimate: number
  label: string
  emoji: string
  /** Bounce probability hint */
  bounceProbPct: number
}

/**
 * Айсберг: в ленте проторгован объём V по цене P, а в стакане уровень
 * уменьшился на ≪ V (или не изменился).
 */
export function detectIcebergOrder(params: {
  trades: MexcTrade[]
  /** Previous snapshot of the level volume at trade price */
  prevLevelVolume: number
  /** Current snapshot of the same level */
  currentLevelVolume: number
  side: 'BUY' | 'SELL'
  priceTolerancePct?: number
  windowMs?: number
  minTradeVolume?: number
}): IcebergResult {
  const empty: IcebergResult = {
    detected: false,
    side: null,
    price: 0,
    tradedVolume: 0,
    bookDelta: 0,
    hiddenVolumeEstimate: 0,
    label: '',
    emoji: '',
    bounceProbPct: 0,
  }

  const tol = params.priceTolerancePct ?? 0.05
  const windowMs = params.windowMs ?? 5_000
  const minVol = params.minTradeVolume ?? 0
  if (!params.trades.length) return empty

  const now = params.trades[0].timestamp
  const sideFilter = params.side
  const recent = params.trades.filter(
    (t) =>
      t.side === sideFilter &&
      now - t.timestamp <= windowMs &&
      t.volume >= minVol
  )
  if (!recent.length) return empty

  // Cluster around modal price
  const price = recent.reduce((s, t) => s + t.price * t.volume, 0) /
    recent.reduce((s, t) => s + t.volume, 0)
  const tradedVolume = recent
    .filter((t) => Math.abs(t.price - price) / price <= tol / 100)
    .reduce((s, t) => s + t.volume, 0)

  if (tradedVolume <= 0) return empty

  const bookDelta = Math.max(0, params.prevLevelVolume - params.currentLevelVolume)
  const hidden = tradedVolume - bookDelta

  // Iceberg: traded >> visible book decrease
  if (hidden < tradedVolume * 0.5 || bookDelta / tradedVolume > 0.5) {
    return empty
  }

  const bookSide: 'BID' | 'ASK' = sideFilter === 'BUY' ? 'ASK' : 'BID'
  // Hitting asks (BUY tape) against iceberg ask → distribution resistance
  // Hitting bids (SELL tape) against iceberg bid → support bounce

  return {
    detected: true,
    side: bookSide,
    price,
    tradedVolume,
    bookDelta,
    hiddenVolumeEstimate: hidden,
    emoji: '🧊',
    bounceProbPct: 90,
    label: `ICEBERG DETECTED ${bookSide} @ ${price.toFixed(6)} | hidden≈${hidden.toFixed(2)}`,
  }
}

/**
 * Find level volume nearest to price in book.
 */
export function levelVolumeNear(
  levels: OrderBookLevel[],
  price: number,
  tolPct = 0.05
): number {
  let best = 0
  for (const l of levels) {
    if ((Math.abs(l.price - price) / price) * 100 <= tolPct) {
      best = Math.max(best, l.volume)
    }
  }
  return best
}
