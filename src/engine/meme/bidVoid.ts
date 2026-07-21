import type { OrderBookSnapshot } from '../types'
import { getBidDensityHourAgo, recordBidDensity } from './fuelCache'

export interface BidVoidResult {
  detected: boolean
  densityNow: number
  densityHourAgo: number | null
  densityRatio: number
  longBlocked: boolean
  scorePenalty: number
  label: string
  emoji: string
  alert: string | null
}

/**
 * Плотность bids в зоне 5% ниже цены.
 * Если упала ≥3× vs час назад на хаях — Void → блок лонга.
 */
export function detectBidVoid(
  symbol: string,
  depth: OrderBookSnapshot,
  price: number,
  nearHighs: boolean
): BidVoidResult {
  const empty: BidVoidResult = {
    detected: false,
    densityNow: 0,
    densityHourAgo: null,
    densityRatio: 1,
    longBlocked: false,
    scorePenalty: 0,
    label: '',
    emoji: '',
    alert: null,
  }

  if (!depth.bids.length || price <= 0) return empty

  const floor = price * 0.95
  const densityNow = depth.bids
    .filter((b) => b.price >= floor && b.price <= price)
    .reduce((s, b) => s + b.volume * b.price, 0)

  recordBidDensity(symbol, densityNow)
  const hourAgo = getBidDensityHourAgo(symbol)

  if (hourAgo == null || hourAgo <= 0) {
    return { ...empty, densityNow, densityHourAgo: hourAgo }
  }

  const ratio = densityNow / hourAgo
  const voided = ratio <= 1 / 3

  if (voided && nearHighs) {
    return {
      detected: true,
      densityNow,
      densityHourAgo: hourAgo,
      densityRatio: ratio,
      longBlocked: true,
      scorePenalty: 40,
      emoji: '⚠️',
      label: `BID VOID ×${(1 / ratio).toFixed(1)} — стакан пуст снизу`,
      alert:
        '⚠️ Стакан пуст! Фиксируй прибыль, готовится дамп! LONG заблокирован.',
    }
  }

  if (voided) {
    return {
      detected: true,
      densityNow,
      densityHourAgo: hourAgo,
      densityRatio: ratio,
      longBlocked: false,
      scorePenalty: 15,
      emoji: '⚠️',
      label: `Bid density ↓ ×${(1 / ratio).toFixed(1)}`,
      alert: null,
    }
  }

  return {
    ...empty,
    densityNow,
    densityHourAgo: hourAgo,
    densityRatio: ratio,
  }
}
