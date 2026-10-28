import type { MexcTrade } from '../../api/mexc'
import type { OrderBookLevel } from '../types'

/** Whether hidden liquidity is defending, being consumed, or about to break. */
export type IcebergStatus = 'HOLDING' | 'EXHAUSTED' | 'BREAKTHROUGH_RISK'

export interface IcebergResult {
  detected: boolean
  side: 'BID' | 'ASK' | null
  price: number
  tradedVolume: number
  bookDelta: number
  hiddenVolumeEstimate: number
  label: string
  emoji: string
  /**
   * HOLDING = hidden liquidity absorbed the tape and the level still holds.
   * EXHAUSTED = the level is being consumed / replenished less.
   * BREAKTHROUGH_RISK = visible book is disappearing; the level may break.
   */
  status: IcebergStatus | null
  /**
   * Calibrated model confidence 0–100, not a promised bounce probability.
   * It reflects hidden/visible ratio, replenishment and tape size.
   */
  confidencePct: number
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
    status: null,
    confidencePct: 0,
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
  const hiddenRatio = Math.max(0, Math.min(1.2, hidden / tradedVolume))
  const bookDeltaRatio = Math.max(0, Math.min(1, bookDelta / tradedVolume))

  // Iceberg: traded >> visible book decrease. Near-total visible consumption
  // is not hidden absorption — that is breakthrough risk.
  if (hidden < tradedVolume * 0.5 || bookDeltaRatio > 0.5) {
    return empty
  }

  const status: IcebergStatus =
    hiddenRatio >= 0.7 && bookDeltaRatio <= 0.18
      ? 'HOLDING'
      : hiddenRatio >= 0.55 && bookDeltaRatio <= 0.4
        ? 'EXHAUSTED'
        : 'BREAKTHROUGH_RISK'

  // Tape size relative to the provided minimum; without a minimum use a
  // neutral 0.5 prior rather than pretending to know ADV.
  const sizeScore =
    minVol > 0 ? Math.max(0, Math.min(1, tradedVolume / (minVol * 10))) : 0.5

  const rawConfidence =
    45 +
    hiddenRatio * 30 +
    (1 - bookDeltaRatio) * 15 +
    sizeScore * 10
  const statusPenalty =
    status === 'HOLDING' ? 0 : status === 'EXHAUSTED' ? 12 : 25
  const confidencePct = Math.round(
    Math.max(10, Math.min(95, rawConfidence - statusPenalty))
  )

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
    status,
    confidencePct,
    label: `ICEBERG ${status} ${bookSide} @ ${price.toFixed(6)} | hidden≈${hidden.toFixed(2)} | conf ${confidencePct}%`,
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
