import type { OhlcvCandle } from '../../api/mexc'
import { detectMarketStructure } from '../smc'

export interface DynamicInvalidation {
  /** Цена линии отмены (микро-лоу/хай) */
  price: number
  /** Свеча закрылась за линией → паттерн сломан */
  breached: boolean
  /** Вероятность отработки после breach */
  confidenceAfterBreach: number
  timeframe: '1m' | '5m' | '1h' | '4h'
  direction: 'LONG' | 'SHORT'
  message: string
  severity: 'WARNING' | 'CRITICAL'
}

interface BreakAcceptance {
  /** 2–3 closed bars beyond the level, latest close still beyond */
  accepted: boolean
  /** How many of the inspected closed bars closed beyond */
  closesBeyond: number
  /** Number of closed bars inspected */
  bars: number
  /** Wick beyond but close back inside — a sweep, not acceptance */
  reclaimed: boolean
}

/**
 * A break is accepted only after 2 of the last 3 closed bars settle beyond
 * the level. A single wick/close is a sweep, and a sweep that closes back
 * inside is explicitly not invalidation.
 */
function breakAcceptance(
  candles: OhlcvCandle[],
  level: number,
  direction: 'LONG' | 'SHORT',
  lookback = 3,
  minCloses = 2
): BreakAcceptance {
  const n = Math.min(lookback, candles.length)
  if (n === 0) {
    return { accepted: false, closesBeyond: 0, bars: 0, reclaimed: false }
  }

  let closesBeyond = 0
  let wickBeyond = false
  for (let i = candles.length - n; i < candles.length; i++) {
    const candle = candles[i]
    const closeBeyond =
      direction === 'LONG' ? candle[4] < level : candle[4] > level
    if (closeBeyond) closesBeyond++
    const wick =
      direction === 'LONG' ? candle[3] < level : candle[2] > level
    if (wick) wickBeyond = true
  }

  const lastClose = candles[candles.length - 1][4]
  const latestBeyond =
    direction === 'LONG' ? lastClose < level : lastClose > level

  return {
    accepted: closesBeyond >= minCloses && latestBeyond,
    closesBeyond,
    bars: n,
    reclaimed: wickBeyond && latestBeyond === false,
  }
}

/**
 * Динамическая линия инвалидации:
 * LONG — ближайший 5m/1m swing low; SHORT — swing high.
 * Нужны 2 закрытия из 3 за линией; sweep + reclaim не инвалидирует.
 */
export function calculateDynamicInvalidation(
  ohlcv: OhlcvCandle[],
  direction: 'LONG' | 'SHORT',
  timeframe: '1m' | '5m' = '5m'
): DynamicInvalidation | null {
  if (ohlcv.length < 12) return null

  const structure = detectMarketStructure(ohlcv, Math.min(20, ohlcv.length))
  // Exclude the forming candle from breach confirmation.
  const closed = ohlcv.length >= 2 ? ohlcv.slice(0, -1) : ohlcv
  const last = closed[closed.length - 1]
  const close = last[4]
  const tfLabel = timeframe === '1m' ? 'M1' : 'M5'

  if (direction === 'LONG') {
    const price = structure.lastSwingLow
    if (price == null) return null
    const confirm = breakAcceptance(closed, price, direction)
    const pending =
      !confirm.accepted &&
      close < price &&
      confirm.closesBeyond >= 1
    return {
      price,
      breached: confirm.accepted,
      confidenceAfterBreach: confirm.accepted ? 20 : pending ? 55 : 75,
      timeframe,
      direction,
      severity: confirm.accepted ? 'CRITICAL' : 'WARNING',
      message: confirm.accepted
        ? `Пробой принят: ${confirm.closesBeyond}/${confirm.bars} закрытий ${tfLabel} ниже ${price.toFixed(4)}. Вероятность отработки упала до 20%. Не жди SL.`
        : pending
          ? `1 закрытие ${tfLabel} ниже ${price.toFixed(4)} — ждём 2/3. Sweep + reclaim не считается.`
          : `Invalidation ${tfLabel}: ${price.toFixed(4)} — нужно 2 закрытия ниже (сейчас ${confirm.closesBeyond}/${confirm.bars}); sweep+reclaim не считается`,
    }
  }

  const price = structure.lastSwingHigh
  if (price == null) return null
  const confirm = breakAcceptance(closed, price, direction)
  const pending =
    !confirm.accepted &&
    close > price &&
    confirm.closesBeyond >= 1
  return {
    price,
    breached: confirm.accepted,
    confidenceAfterBreach: confirm.accepted ? 20 : pending ? 55 : 75,
    timeframe,
    direction,
    severity: confirm.accepted ? 'CRITICAL' : 'WARNING',
    message: confirm.accepted
      ? `Пробой принят: ${confirm.closesBeyond}/${confirm.bars} закрытий ${tfLabel} выше ${price.toFixed(4)}. Вероятность отработки упала до 20%. Не жди SL.`
      : pending
        ? `1 закрытие ${tfLabel} выше ${price.toFixed(4)} — ждём 2/3. Sweep + reclaim не считается.`
        : `Invalidation ${tfLabel}: ${price.toFixed(4)} — нужно 2 закрытия выше (сейчас ${confirm.closesBeyond}/${confirm.bars}); sweep+reclaim не считается`,
  }
}

/**
 * Инвалидация по закрытию 1H / 4H:
 * LONG — 2 из 3 закрытых свечей ниже last swing low
 * SHORT — 2 из 3 закрытых свечей выше last swing high
 * Одиночная свеча или sweep с возвратом не инвалидируют сетап.
 */
export function calculateHtfInvalidation(
  ohlcv: OhlcvCandle[],
  direction: 'LONG' | 'SHORT',
  timeframe: '1h' | '4h'
): DynamicInvalidation | null {
  const minBars = timeframe === '4h' ? 24 : 30
  if (ohlcv.length < minBars) return null

  // Use only closed candles (exclude forming bar).
  const closed = ohlcv.slice(0, -1)
  if (closed.length < minBars) return null
  const structure = detectMarketStructure(
    closed,
    Math.min(timeframe === '4h' ? 40 : 50, closed.length)
  )
  const lastClose = closed[closed.length - 1][4]
  const tfLabel = timeframe.toUpperCase()

  if (direction === 'LONG') {
    const price = structure.lastSwingLow
    if (price == null) return null
    const confirm = breakAcceptance(closed, price, direction)
    const pending =
      !confirm.accepted &&
      lastClose < price &&
      confirm.closesBeyond >= 1
    return {
      price,
      breached: confirm.accepted,
      confidenceAfterBreach: confirm.accepted ? 15 : pending ? 50 : 70,
      timeframe,
      direction,
      severity: confirm.accepted ? 'CRITICAL' : 'WARNING',
      message: confirm.accepted
        ? `Сетап сломан: ${confirm.closesBeyond}/${confirm.bars} закрытий ${tfLabel} ниже структуры (${price.toFixed(4)}). Закрывай / BE.`
        : pending
          ? `1 закрытие ${tfLabel} ниже ${price.toFixed(4)} — ждём 2/3, sweep+reclaim не считается.`
          : `Inv ${tfLabel}: ${price.toFixed(4)} — нужно 2 закрытия ниже (сейчас ${confirm.closesBeyond}/${confirm.bars})`,
    }
  }

  const price = structure.lastSwingHigh
  if (price == null) return null
  const confirm = breakAcceptance(closed, price, direction)
  const pending =
    !confirm.accepted &&
    lastClose > price &&
    confirm.closesBeyond >= 1
  return {
    price,
    breached: confirm.accepted,
    confidenceAfterBreach: confirm.accepted ? 15 : pending ? 50 : 70,
    timeframe,
    direction,
    severity: confirm.accepted ? 'CRITICAL' : 'WARNING',
    message: confirm.accepted
      ? `Сетап сломан: ${confirm.closesBeyond}/${confirm.bars} закрытий ${tfLabel} выше структуры (${price.toFixed(4)}). Закрывай / BE.`
      : pending
        ? `1 закрытие ${tfLabel} выше ${price.toFixed(4)} — ждём 2/3, sweep+reclaim не считается.`
        : `Inv ${tfLabel}: ${price.toFixed(4)} — нужно 2 закрытия выше (сейчас ${confirm.closesBeyond}/${confirm.bars})`,
  }
}

/** LTF first; used by copilot when HTF not fetched */
export function evaluateTradeInvalidation(
  ohlcv5m: OhlcvCandle[] | null,
  ohlcv1m: OhlcvCandle[],
  direction: 'LONG' | 'SHORT'
): DynamicInvalidation | null {
  if (ohlcv5m && ohlcv5m.length >= 12) {
    const inv5 = calculateDynamicInvalidation(ohlcv5m, direction, '5m')
    if (inv5?.breached) return inv5
  }
  return calculateDynamicInvalidation(ohlcv1m, direction, '1m')
}

/**
 * Полная проверка: 4H → 1H → 5m → 1m.
 * HTF close break = CRITICAL exit signal.
 */
export function evaluateFullInvalidation(params: {
  direction: 'LONG' | 'SHORT'
  ohlcv1m?: OhlcvCandle[] | null
  ohlcv5m?: OhlcvCandle[] | null
  ohlcv1h?: OhlcvCandle[] | null
  ohlcv4h?: OhlcvCandle[] | null
}): DynamicInvalidation | null {
  const { direction, ohlcv1m, ohlcv5m, ohlcv1h, ohlcv4h } = params

  if (ohlcv4h && ohlcv4h.length >= 24) {
    const inv4 = calculateHtfInvalidation(ohlcv4h, direction, '4h')
    if (inv4?.breached) return inv4
  }
  if (ohlcv1h && ohlcv1h.length >= 30) {
    const inv1 = calculateHtfInvalidation(ohlcv1h, direction, '1h')
    if (inv1?.breached) return inv1
  }
  return evaluateTradeInvalidation(ohlcv5m ?? null, ohlcv1m ?? [], direction)
}

/** Prefer HTF price line for chart when available */
export function pickInvalidationForDisplay(params: {
  direction: 'LONG' | 'SHORT'
  ohlcv1m?: OhlcvCandle[] | null
  ohlcv5m?: OhlcvCandle[] | null
  ohlcv1h?: OhlcvCandle[] | null
  ohlcv4h?: OhlcvCandle[] | null
}): DynamicInvalidation | null {
  const { direction, ohlcv1m, ohlcv5m, ohlcv1h, ohlcv4h } = params

  if (ohlcv4h && ohlcv4h.length >= 24) {
    const inv4 = calculateHtfInvalidation(ohlcv4h, direction, '4h')
    if (inv4) return inv4
  }
  if (ohlcv1h && ohlcv1h.length >= 30) {
    const inv1 = calculateHtfInvalidation(ohlcv1h, direction, '1h')
    if (inv1) return inv1
  }
  return evaluateTradeInvalidation(ohlcv5m ?? null, ohlcv1m ?? [], direction)
}
