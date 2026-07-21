import type { OhlcvCandle } from '../../api/mexc'
import type {
  PriceScenario,
  PathPoint,
  MultiTFAlignment,
  LiquidityLevel,
} from './types'
import { calculateAtr } from '../smc'
import { findNearestLiquidity } from './liquidityMap'

const SCENARIO_COLORS = {
  LONG: '#22c55e',
  SHORT: '#ef4444',
  RANGE: '#f59e0b',
}

function candleSeconds(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
  }
  return map[tf] ?? 3600
}

function buildLongPath(
  entry: number,
  target: number,
  atr: number,
  candleSec: number
): PathPoint[] {
  const pullback = entry - atr * 0.25
  const midTarget = entry + (target - entry) * 0.5

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Вход' },
    { timeOffsetSeconds: candleSec * 1, price: pullback, label: 'Откат' },
    { timeOffsetSeconds: candleSec * 3, price: entry + atr * 0.3 },
    {
      timeOffsetSeconds: candleSec * 5,
      price: midTarget,
      label: 'TP1',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: candleSec * 8,
      price: target,
      label: 'Цель',
      isKeyLevel: true,
    },
  ]
}

function buildShortPath(
  entry: number,
  target: number,
  atr: number,
  candleSec: number
): PathPoint[] {
  const pullback = entry + atr * 0.25
  const midTarget = entry - (entry - target) * 0.5

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Вход' },
    { timeOffsetSeconds: candleSec * 1, price: pullback, label: 'Откат' },
    { timeOffsetSeconds: candleSec * 3, price: entry - atr * 0.3 },
    {
      timeOffsetSeconds: candleSec * 5,
      price: midTarget,
      label: 'TP1',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: candleSec * 8,
      price: target,
      label: 'Цель',
      isKeyLevel: true,
    },
  ]
}

function buildRangePath(
  entry: number,
  rangeTop: number,
  rangeBottom: number,
  candleSec: number
): PathPoint[] {
  return [
    { timeOffsetSeconds: 0, price: entry },
    { timeOffsetSeconds: candleSec * 2, price: rangeTop, label: 'Верх' },
    { timeOffsetSeconds: candleSec * 4, price: rangeBottom, label: 'Низ' },
    { timeOffsetSeconds: candleSec * 6, price: entry, label: 'Возврат' },
    {
      timeOffsetSeconds: candleSec * 8,
      price: rangeTop,
      label: 'Цель выхода',
      isKeyLevel: true,
    },
  ]
}

function calcProbabilities(alignment: MultiTFAlignment) {
  const { score } = alignment
  let longBase = 33
  let shortBase = 33
  let rangeBase = 34

  if (score >= 4) {
    longBase = 65
    shortBase = 15
    rangeBase = 20
  } else if (score >= 2) {
    longBase = 55
    shortBase = 20
    rangeBase = 25
  } else if (score <= -4) {
    longBase = 15
    shortBase = 65
    rangeBase = 20
  } else if (score <= -2) {
    longBase = 20
    shortBase = 55
    rangeBase = 25
  }

  if (alignment.agreement) {
    if (score > 0) {
      longBase += 5
      rangeBase -= 5
    } else {
      shortBase += 5
      rangeBase -= 5
    }
  }

  const total = longBase + shortBase + rangeBase
  return {
    longPct: Math.round((longBase / total) * 100),
    shortPct: Math.round((shortBase / total) * 100),
    rangePct: Math.round((rangeBase / total) * 100),
  }
}

function buildReasoning(alignment: MultiTFAlignment, isLong: boolean): string[] {
  const want = isLong ? 'LONG' : 'SHORT'
  const reasons: string[] = []

  if (alignment.daily.bias === want) reasons.push(`1D: ${alignment.daily.biasReason}`)
  if (alignment.h4.bias === want) reasons.push(`4H: ${alignment.h4.biasReason}`)
  if (alignment.h1.bias === want) reasons.push(`1H: ${alignment.h1.biasReason}`)
  if (alignment.agreement) reasons.push('Все TF согласованы')
  if (reasons.length === 0) {
    reasons.push(`Сценарий ${want} при MTF score: ${alignment.score}`)
  }

  return reasons
}

export function buildScenarios(
  candles: OhlcvCandle[],
  alignment: MultiTFAlignment,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  activeTimeframe = '1h',
  _lastCandleTs?: number
): PriceScenario[] {
  const atr = calculateAtr(candles, 14) ?? currentPrice * 0.005
  const candleSec = candleSeconds(activeTimeframe)
  const { longPct, shortPct, rangePct } = calcProbabilities(alignment)

  const nearestUp = findNearestLiquidity(liquidityMap, 'UP', 0.3)
  const nearestDown = findNearestLiquidity(liquidityMap, 'DOWN', 0.3)

  const upTarget = nearestUp?.price ?? currentPrice + atr * 2.5
  const downTarget = nearestDown?.price ?? currentPrice - atr * 2.5

  const isLong = alignment.dominantBias !== 'SHORT'

  const scenA: PriceScenario = {
    id: 'A',
    type: isLong ? 'LONG' : 'SHORT',
    label: 'Основной сценарий',
    probability: isLong ? longPct : shortPct,
    color: isLong ? SCENARIO_COLORS.LONG : SCENARIO_COLORS.SHORT,
    path: isLong
      ? buildLongPath(currentPrice, upTarget, atr, candleSec)
      : buildShortPath(currentPrice, downTarget, atr, candleSec),
    entry: currentPrice,
    target: isLong ? upTarget : downTarget,
    invalidation: isLong ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    liquidityTarget: {
      price: isLong ? upTarget : downTarget,
      type: (isLong ? nearestUp?.type : nearestDown?.type) ?? 'SWING_HIGH',
      strength: (isLong ? nearestUp?.strength : nearestDown?.strength) ?? 5,
      distancePercent: isLong
        ? ((upTarget - currentPrice) / currentPrice) * 100
        : ((currentPrice - downTarget) / currentPrice) * 100,
      direction: isLong ? 'UP' : 'DOWN',
      label: isLong
        ? (nearestUp?.label ?? 'Swing High')
        : (nearestDown?.label ?? 'Swing Low'),
    },
    reasoning: buildReasoning(alignment, isLong),
    triggerCondition: isLong
      ? 'Удержание выше EMA20 + ретест OB'
      : 'Пробой поддержки + ретест снизу',
    riskReward: Math.abs((isLong ? upTarget - currentPrice : currentPrice - downTarget) / atr),
    atrMultiple: Math.abs((isLong ? upTarget - currentPrice : currentPrice - downTarget) / atr),
  }

  const scenB: PriceScenario = {
    id: 'B',
    type: isLong ? 'SHORT' : 'LONG',
    label: 'Альтернативный сценарий',
    probability: isLong ? shortPct : longPct,
    color: isLong ? SCENARIO_COLORS.SHORT : SCENARIO_COLORS.LONG,
    path: isLong
      ? buildShortPath(currentPrice, downTarget, atr, candleSec)
      : buildLongPath(currentPrice, upTarget, atr, candleSec),
    entry: currentPrice,
    target: isLong ? downTarget : upTarget,
    invalidation: isLong ? currentPrice + atr * 2 : currentPrice - atr * 2,
    liquidityTarget: {
      price: isLong ? downTarget : upTarget,
      type: (isLong ? nearestDown?.type : nearestUp?.type) ?? 'SWING_LOW',
      strength: (isLong ? nearestDown?.strength : nearestUp?.strength) ?? 5,
      distancePercent: Math.abs(
        isLong
          ? ((currentPrice - downTarget) / currentPrice) * 100
          : ((upTarget - currentPrice) / currentPrice) * 100
      ),
      direction: isLong ? 'DOWN' : 'UP',
      label: isLong
        ? (nearestDown?.label ?? 'Swing Low')
        : (nearestUp?.label ?? 'Swing High'),
    },
    reasoning: buildReasoning(alignment, !isLong),
    triggerCondition: isLong
      ? 'Пробой поддержки + закрытие ниже'
      : 'Пробой сопротивления + объём',
    riskReward: 2,
    atrMultiple: 2,
  }

  const scenC: PriceScenario = {
    id: 'C',
    type: 'RANGE',
    label: 'Консолидация',
    probability: rangePct,
    color: SCENARIO_COLORS.RANGE,
    path: buildRangePath(
      currentPrice,
      currentPrice + atr * 1.5,
      currentPrice - atr * 1.5,
      candleSec
    ),
    entry: currentPrice,
    target: currentPrice + (isLong ? atr : -atr),
    invalidation: currentPrice + (isLong ? -atr * 2 : atr * 2),
    liquidityTarget: {
      price: currentPrice,
      type: 'POC',
      strength: 5,
      distancePercent: 0,
      direction: 'UP',
      label: 'Диапазон',
    },
    reasoning: [
      `MTF score: ${alignment.score}`,
      '1D/4H/1H без чёткого согласования',
      'Ожидание накопления перед движением',
    ],
    triggerCondition: 'Флэт с сжатием волатильности',
    riskReward: 1,
    atrMultiple: 1.5,
  }

  return [scenA, scenB, scenC].sort((a, b) => b.probability - a.probability)
}
