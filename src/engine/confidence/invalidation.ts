import type { OhlcvCandle } from '../../api/mexc'
import { detectMarketStructure } from '../smc'

export interface DynamicInvalidation {
  /** Цена линии отмены (микро-лоу/хай) */
  price: number
  /** Свеча закрылась за линией → паттерн сломан */
  breached: boolean
  /** Вероятность отработки после breach */
  confidenceAfterBreach: number
  timeframe: '1m' | '5m'
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

/** Расширенная проверка для Copilot (5m предпочтительнее 1m) */
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
