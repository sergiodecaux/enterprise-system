import type { OhlcvCandle } from '../../api/mexc'
import type { TradeSide } from '../smc'

export type EffortTrapStatus =
  | 'ABSORPTION_TRAP'
  | 'MM_DISTRIBUTION'
  | 'MM_ACCUMULATION'
  | 'CLEAN'
  | 'NONE'

export interface EffortVsResultInput {
  direction: TradeSide | null
  /** Buyer share 0–100: buyVol / (buy+sell) * 100 */
  buyerAggressionPct: number
  /** Seller share 0–100 */
  sellerAggressionPct: number
  /** Absolute price change % over lookback (signed for direction) */
  priceChangePct: number
  /** Order book imbalance −100…+100 (bids − asks) */
  imbalance?: number | null
}

export interface EffortVsResultResult {
  status: EffortTrapStatus
  detected: boolean
  scoreOverride: number | null
  approved: boolean
  label: string
  emoji: string
  reason: string
}

const HIGH_AGGRESSION = 80
const FLAT_PRICE_PCT = 0.5

/**
 * Effort vs Result: высокая агрессия без движения цены = ловушка абсорбции ММ.
 */
export function detectEffortVsResult(
  input: EffortVsResultInput
): EffortVsResultResult {
  const clean: EffortVsResultResult = {
    status: 'CLEAN',
    detected: false,
    scoreOverride: null,
    approved: true,
    label: '',
    emoji: '',
    reason: '',
  }

  if (!input.direction) {
    return { ...clean, status: 'NONE' }
  }

  const priceAbs = Math.abs(input.priceChangePct)
  const imbalance = input.imbalance ?? 0

  // LONG trap: buyers hammer, price flat/down
  if (
    input.direction === 'LONG' &&
    input.buyerAggressionPct >= HIGH_AGGRESSION &&
    input.priceChangePct < FLAT_PRICE_PCT
  ) {
    const hasBidSupport = imbalance > 15
    if (hasBidSupport && priceAbs < FLAT_PRICE_PCT) {
      return {
        status: 'MM_DISTRIBUTION',
        detected: true,
        scoreOverride: 10,
        approved: false,
        emoji: '⚠️',
        label: 'MM DISTRIBUTION',
        reason:
          'Покупатели бьются об стену. Сил много, а результата нет. Сейчас будет разворот вниз (скрытые продажи ММ).',
      }
    }
    return {
      status: 'ABSORPTION_TRAP',
      detected: true,
      scoreOverride: 10,
      approved: false,
      emoji: '⚠️',
      label: 'ABSORPTION TRAP',
      reason:
        'Buyer Aggression >80%, цена почти не выросла. Кит абсорбирует покупки лимитными ордерами.',
    }
  }

  // SHORT trap: sellers hammer, price flat/up
  if (
    input.direction === 'SHORT' &&
    input.sellerAggressionPct >= HIGH_AGGRESSION &&
    input.priceChangePct > -FLAT_PRICE_PCT
  ) {
    return {
      status: 'ABSORPTION_TRAP',
      detected: true,
      scoreOverride: 10,
      approved: false,
      emoji: '⚠️',
      label: 'ABSORPTION TRAP',
      reason:
        'Seller Aggression >80%, цена почти не упала. Абсорбция продаж — ловушка для шортов.',
    }
  }

  return clean
}

/**
 * Цена change % за последние `candles` минут (1m OHLCV).
 * Signed: positive = up.
 */
export function priceChangePctOver(
  ohlcv1m: OhlcvCandle[],
  candles = 5
): number {
  if (ohlcv1m.length < candles + 1) return 0
  const end = ohlcv1m[ohlcv1m.length - 1][4]
  const start = ohlcv1m[ohlcv1m.length - 1 - candles][4]
  if (start <= 0) return 0
  return ((end - start) / start) * 100
}

/** Buy share from volumes → 0–100 */
export function aggressionPctFromVolumes(
  buyVolume: number,
  sellVolume: number
): { buyerPct: number; sellerPct: number } {
  const total = buyVolume + sellVolume
  if (total <= 0) return { buyerPct: 50, sellerPct: 50 }
  const buyerPct = (buyVolume / total) * 100
  return { buyerPct, sellerPct: 100 - buyerPct }
}

/**
 * Convenience: ratio → buy share.
 * buyToSellRatio 9 → ~90% buyers.
 */
export function aggressionPctFromRatio(buyToSellRatio: number): {
  buyerPct: number
  sellerPct: number
} {
  if (buyToSellRatio <= 0) return { buyerPct: 0, sellerPct: 100 }
  const buyerPct = (buyToSellRatio / (1 + buyToSellRatio)) * 100
  return { buyerPct, sellerPct: 100 - buyerPct }
}
