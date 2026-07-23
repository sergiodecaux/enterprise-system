import { calculateAtr } from '../smc'
import type { OhlcvCandle } from '../../api/mexc'

export interface MemeBreakevenInput {
  direction: 'LONG' | 'SHORT'
  entryPrice: number
  currentPrice: number
  tp1: number
  entryTime: number
  ohlcv1m: OhlcvCandle[]
  /** Price must stay in profit this long before BE (ms) */
  minProfitDurationMs?: number
  /** Min move % in trade direction before BE (on top of TP1 gate) */
  minMovePct?: number
  now?: number
}

export interface MemeBreakevenResult {
  eligible: boolean
  tp1Hit: boolean
  timeOk: boolean
  moveOk: boolean
  /** Suggested SL for BE (with ATR breath room) */
  beStop: number
  atr: number | null
  reason: string
}

const DEFAULT_MIN_PROFIT_MS = 3 * 60 * 1000
const DEFAULT_MIN_MOVE_PCT = 2
const ATR_BUFFER_MULT = 0.5

/**
 * Мем-логика БУ:
 * 1) Запрет БУ до касания TP1
 * 2) Time-Delay: цена в плюсе ≥ 3 мин
 * 3) Min move X% (не «кольнул и вернулся»)
 * 4) BE не в ноль, а Entry ± ATR*0.5 (пространство для дыхания)
 */
export function evaluateMemeBreakeven(
  input: MemeBreakevenInput
): MemeBreakevenResult {
  const now = input.now ?? Date.now()
  const minMs = input.minProfitDurationMs ?? DEFAULT_MIN_PROFIT_MS
  const minMove = input.minMovePct ?? DEFAULT_MIN_MOVE_PCT

  const tp1Hit =
    input.direction === 'LONG'
      ? input.currentPrice >= input.tp1
      : input.currentPrice <= input.tp1

  const inProfit =
    input.direction === 'LONG'
      ? input.currentPrice > input.entryPrice
      : input.currentPrice < input.entryPrice

  const timeOk = inProfit && now - input.entryTime >= minMs

  const movePct =
    input.direction === 'LONG'
      ? ((input.currentPrice - input.entryPrice) / input.entryPrice) * 100
      : ((input.entryPrice - input.currentPrice) / input.entryPrice) * 100
  const moveOk = movePct >= minMove

  const atr = calculateAtr(input.ohlcv1m, 14)
  const buffer = atr != null && atr > 0 ? atr * ATR_BUFFER_MULT : input.entryPrice * 0.005

  const beStop =
    input.direction === 'LONG'
      ? input.entryPrice - buffer
      : input.entryPrice + buffer

  if (!tp1Hit) {
    return {
      eligible: false,
      tp1Hit: false,
      timeOk,
      moveOk,
      beStop,
      atr,
      reason: 'БУ запрещён до фиксации TP1 (мем-шум 2–4% — норма).',
    }
  }

  if (!timeOk) {
    return {
      eligible: false,
      tp1Hit: true,
      timeOk: false,
      moveOk,
      beStop,
      atr,
      reason: `Ждём удержания прибыли ≥ ${Math.round(minMs / 60000)} мин (Time-Delay BE).`,
    }
  }

  if (!moveOk) {
    return {
      eligible: false,
      tp1Hit: true,
      timeOk: true,
      moveOk: false,
      beStop,
      atr,
      reason: `Движение ${movePct.toFixed(1)}% < ${minMove}% — возможен ложный прокол.`,
    }
  }

  return {
    eligible: true,
    tp1Hit: true,
    timeOk: true,
    moveOk: true,
    beStop,
    atr,
    reason: `TP1 снят → BE с ATR-буфером (${ATR_BUFFER_MULT}×ATR).`,
  }
}

/**
 * Минимальный TP1 для мемов: +5…10% без плеча.
 */
export function enforceMemeTp1Floor(
  price: number,
  direction: 'LONG' | 'SHORT',
  tp1: number,
  minPct = 5
): number {
  if (direction === 'LONG') {
    const floor = price * (1 + minPct / 100)
    return Math.max(tp1, floor)
  }
  const floor = price * (1 - minPct / 100)
  return Math.min(tp1, floor)
}
