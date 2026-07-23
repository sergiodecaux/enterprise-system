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

/**
 * Динамическая линия инвалидации:
 * LONG — ближайший 5m/1m swing low; SHORT — swing high.
 * Закрытие свечи за линией = Structure Shift → не ждать SL.
 */
export function calculateDynamicInvalidation(
  ohlcv: OhlcvCandle[],
  direction: 'LONG' | 'SHORT',
  timeframe: '1m' | '5m' = '5m'
): DynamicInvalidation | null {
  if (ohlcv.length < 12) return null

  const structure = detectMarketStructure(ohlcv, Math.min(20, ohlcv.length))
  const last = ohlcv[ohlcv.length - 1]
  const close = last[4]

  if (direction === 'LONG') {
    const price = structure.lastSwingLow
    if (price == null) return null
    const breached = close < price && structure.trend === 'BEARISH'
    return {
      price,
      breached,
      confidenceAfterBreach: breached ? 20 : 75,
      timeframe,
      direction,
      severity: breached ? 'CRITICAL' : 'WARNING',
      message: breached
        ? `Паттерн сломан (Structure Shift ${timeframe.toUpperCase()}). Вероятность отработки упала до 20%. Закрывай руками или переводи в BE, не жди удара в Stop Loss!`
        : `Invalidation M${timeframe === '1m' ? '1' : '5'}: ${price.toFixed(4)} — закрытие ниже = отмена лонга`,
    }
  }

  const price = structure.lastSwingHigh
  if (price == null) return null
  const breached = close > price && structure.trend === 'BULLISH'
  return {
    price,
    breached,
    confidenceAfterBreach: breached ? 20 : 75,
    timeframe,
    direction,
    severity: breached ? 'CRITICAL' : 'WARNING',
    message: breached
      ? `Паттерн сломан (Structure Shift ${timeframe.toUpperCase()}). Вероятность отработки упала до 20%. Закрывай руками или переводи в BE, не жди удара в Stop Loss!`
      : `Invalidation M${timeframe === '1m' ? '1' : '5'}: ${price.toFixed(4)} — закрытие выше = отмена шорта`,
  }
}

/**
 * Инвалидация по закрытию 1H / 4H (не wick):
 * LONG — close ниже last swing low + медвежья структура
 * SHORT — close выше last swing high + бычья структура
 */
export function calculateHtfInvalidation(
  ohlcv: OhlcvCandle[],
  direction: 'LONG' | 'SHORT',
  timeframe: '1h' | '4h'
): DynamicInvalidation | null {
  const minBars = timeframe === '4h' ? 24 : 30
  if (ohlcv.length < minBars) return null

  // Use last CLOSED candle when possible (exclude forming bar)
  const closed =
    ohlcv.length >= 2 ? ohlcv[ohlcv.length - 2] : ohlcv[ohlcv.length - 1]
  const structureCandles = ohlcv.slice(0, -1)
  const structure = detectMarketStructure(
    structureCandles.length >= minBars ? structureCandles : ohlcv,
    Math.min(timeframe === '4h' ? 40 : 50, structureCandles.length || ohlcv.length)
  )
  const close = closed[4]
  const tfLabel = timeframe.toUpperCase()

  if (direction === 'LONG') {
    const price = structure.lastSwingLow
    if (price == null) return null
    const breached = close < price
    const structureFlip = structure.trend === 'BEARISH'
    const hardBreach = breached && (structureFlip || close < price * 0.998)
    return {
      price,
      breached: hardBreach,
      confidenceAfterBreach: hardBreach ? 15 : 70,
      timeframe,
      direction,
      severity: timeframe === '4h' ? 'CRITICAL' : hardBreach ? 'CRITICAL' : 'WARNING',
      message: hardBreach
        ? `Сетап сломан: закрытие ${tfLabel} ниже структуры (${price.toFixed(4)}). Закрывай / BE — не жди SL.`
        : `Inv ${tfLabel}: ${price.toFixed(4)} — закрытие ниже = отмена лонга`,
    }
  }

  const price = structure.lastSwingHigh
  if (price == null) return null
  const breached = close > price
  const structureFlip = structure.trend === 'BULLISH'
  const hardBreach = breached && (structureFlip || close > price * 1.002)
  return {
    price,
    breached: hardBreach,
    confidenceAfterBreach: hardBreach ? 15 : 70,
    timeframe,
    direction,
    severity: timeframe === '4h' ? 'CRITICAL' : hardBreach ? 'CRITICAL' : 'WARNING',
    message: hardBreach
      ? `Сетап сломан: закрытие ${tfLabel} выше структуры (${price.toFixed(4)}). Закрывай / BE — не жди SL.`
      : `Inv ${tfLabel}: ${price.toFixed(4)} — закрытие выше = отмена шорта`,
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
