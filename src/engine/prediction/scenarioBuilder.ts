import type { OhlcvCandle } from '../../api/mexc'
import type {
  PriceScenario,
  PathPoint,
  MultiTFAlignment,
  LiquidityLevel,
} from './types'
import { calculateAtr } from '../smc'
import { findNearestLiquidity } from './liquidityMap'
import {
  calcScenarioProbabilities,
  type NewsBias,
} from './scenarioProbabilities'

/** A основной · B свип · C слом */
const COLORS = {
  A: '#22c55e',
  B: '#38bdf8',
  C: '#f97316',
  A_SHORT: '#ef4444',
  B_SHORT: '#a78bfa',
  C_SHORT: '#f97316',
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

/**
 * A (70%): движение по тренду в OB / к цели — чистый импульс с лёгким ретестом.
 */
function buildPrimaryPath(
  entry: number,
  target: number,
  atr: number,
  candleSec: number,
  isLong: boolean
): PathPoint[] {
  const sign = isLong ? 1 : -1
  const obRetest = entry - sign * atr * 0.2
  const mid = entry + sign * Math.abs(target - entry) * 0.55

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Now', isKeyLevel: true },
    {
      timeOffsetSeconds: candleSec * 1,
      price: obRetest,
      label: 'Ретест OB',
    },
    {
      timeOffsetSeconds: candleSec * 3,
      price: entry + sign * atr * 0.35,
      label: 'Импульс',
    },
    {
      timeOffsetSeconds: candleSec * 5,
      price: mid,
      label: 'TP1',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: candleSec * 8,
      price: target,
      label: 'Цель (OB/Liq)',
      isKeyLevel: true,
    },
  ]
}

/**
 * B (20%): снятие ликвидности (пересвип) → возврат → поход выше/ниже цели.
 */
function buildSweepPath(
  entry: number,
  target: number,
  sweepLevel: number,
  atr: number,
  candleSec: number,
  isLong: boolean
): PathPoint[] {
  const sign = isLong ? 1 : -1
  const extended = target + sign * atr * 0.8

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Now', isKeyLevel: true },
    {
      timeOffsetSeconds: candleSec * 1.5,
      price: sweepLevel,
      label: 'Liquidity Sweep',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: candleSec * 3,
      price: entry + sign * atr * 0.15,
      label: 'Reclaim',
    },
    {
      timeOffsetSeconds: candleSec * 5,
      price: entry + sign * Math.abs(target - entry) * 0.4,
      label: 'Продолжение',
    },
    {
      timeOffsetSeconds: candleSec * 9,
      price: extended,
      label: 'Цель+',
      isKeyLevel: true,
    },
  ]
}

/**
 * C (10%): слом структуры — цена уходит за стоп / инвалидацию.
 */
function buildBreakPath(
  entry: number,
  stopLevel: number,
  atr: number,
  candleSec: number,
  isLong: boolean
): PathPoint[] {
  const sign = isLong ? 1 : -1
  // После стопа — продолжение против тренда
  const afterStop = stopLevel - sign * atr * 1.2

  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Now', isKeyLevel: true },
    {
      timeOffsetSeconds: candleSec * 1,
      price: entry - sign * atr * 0.35,
      label: 'Слабость',
    },
    {
      timeOffsetSeconds: candleSec * 3,
      price: stopLevel,
      label: 'Слом / SL',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: candleSec * 6,
      price: afterStop,
      label: 'Против тренда',
      isKeyLevel: true,
    },
  ]
}

function calcFixedProbabilities(
  alignment: MultiTFAlignment,
  isLong: boolean,
  extras?: {
    newsBias?: NewsBias
    fearGreed?: number | null
    bookImbalance?: number | null
    horizon?: 'SCALP' | 'INTRA' | 'SWING' | 'MACRO'
  }
): {
  a: number
  b: number
  c: number
} {
  return calcScenarioProbabilities({
    alignment,
    isLong,
    newsBias: extras?.newsBias,
    fearGreed: extras?.fearGreed,
    bookImbalance: extras?.bookImbalance,
    horizon: extras?.horizon ?? 'INTRA',
  })
}

function buildReasoning(
  alignment: MultiTFAlignment,
  isLong: boolean,
  kind: 'A' | 'B' | 'C'
): string[] {
  const want = isLong ? 'LONG' : 'SHORT'
  if (kind === 'A') {
    const reasons: string[] = [
      `Тренд ${want}: движение к ближайшему OB / ликвидности`,
    ]
    if (alignment.daily.bias === want) reasons.push(`1D: ${alignment.daily.biasReason}`)
    if (alignment.h4.bias === want) reasons.push(`4H: ${alignment.h4.biasReason}`)
    if (alignment.agreement) reasons.push('MTF согласованы')
    return reasons
  }
  if (kind === 'B') {
    return [
      'Сначала снятие стопов (liquidity sweep)',
      'Reclaim структуры → продолжение тренда',
      'Не путать свип со сломом',
    ]
  }
  return [
    'Цена закрывается за стопом / микро-структурой',
    'Сценарий инвалидации — не «обязана» отработать A',
    'Мысли вероятностями: 10% тоже бывает',
  ]
}

export interface BuildScenariosOptions {
  stopLoss?: number | null
  invalidationPrice?: number | null
  newsBias?: NewsBias
  fearGreed?: number | null
  bookImbalance?: number | null
  horizon?: 'SCALP' | 'INTRA' | 'SWING' | 'MACRO'
  /** Scale path time offsets (scalp < 1, swing > 1) */
  pathTimeScale?: number
}

/**
 * Три вероятностных сценария:
 * A — основной тренд в OB
 * B — пересвип ликвидности, затем продолжение
 * C — слом структуры ниже/выше стопа
 */
export function buildScenarios(
  candles: OhlcvCandle[],
  alignment: MultiTFAlignment,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  activeTimeframe = '1h',
  _lastCandleTs?: number,
  options?: BuildScenariosOptions
): PriceScenario[] {
  const atr = calculateAtr(candles, 14) ?? currentPrice * 0.005
  const candleSec = candleSeconds(activeTimeframe)
  const timeScale = options?.pathTimeScale ?? 1
  const scaledSec = candleSec * timeScale

  const nearestUp = findNearestLiquidity(liquidityMap, 'UP', 0.3)
  const nearestDown = findNearestLiquidity(liquidityMap, 'DOWN', 0.3)

  const isLong = alignment.dominantBias !== 'SHORT'
  const { a: pctA, b: pctB, c: pctC } = calcFixedProbabilities(alignment, isLong, {
    newsBias: options?.newsBias,
    fearGreed: options?.fearGreed,
    bookImbalance: options?.bookImbalance,
    horizon: options?.horizon,
  })

  // Scalp aims closer magnets; swing aims farther
  const atrMult =
    options?.horizon === 'SCALP' ? 1.4 : options?.horizon === 'SWING' ? 3.2 : 2.5

  const target = isLong
    ? nearestUp?.price ?? currentPrice + atr * atrMult
    : nearestDown?.price ?? currentPrice - atr * atrMult

  // Sweep: SSL ниже для лонга / BSL выше для шорта
  const sweepLevel = isLong
    ? (nearestDown?.price ?? currentPrice - atr * 1.1)
    : (nearestUp?.price ?? currentPrice + atr * 1.1)

  const stopLevel =
    options?.stopLoss ??
    options?.invalidationPrice ??
    (isLong ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5)

  const primaryColor = isLong ? COLORS.A : COLORS.A_SHORT
  const altColor = isLong ? COLORS.B : COLORS.B_SHORT
  const breakColor = COLORS.C

  const riskA = Math.abs(target - currentPrice) / Math.max(Math.abs(currentPrice - stopLevel), atr * 0.5)

  const horizonTag =
    options?.horizon === 'SCALP'
      ? 'скальп'
      : options?.horizon === 'SWING'
        ? 'свинг'
        : 'интра'

  const scenA: PriceScenario = {
    id: 'A',
    type: isLong ? 'LONG' : 'SHORT',
    label: `Основной (${horizonTag} → OB)`,
    probability: pctA,
    color: primaryColor,
    path: buildPrimaryPath(currentPrice, target, atr, scaledSec, isLong),
    entry: currentPrice,
    target,
    invalidation: stopLevel,
    liquidityTarget: {
      price: target,
      type: (isLong ? nearestUp?.type : nearestDown?.type) ?? 'ORDER_BLOCK',
      strength: (isLong ? nearestUp?.strength : nearestDown?.strength) ?? 7,
      distancePercent: Math.abs(((target - currentPrice) / currentPrice) * 100),
      direction: isLong ? 'UP' : 'DOWN',
      label: isLong
        ? (nearestUp?.label ?? 'OB / Swing High')
        : (nearestDown?.label ?? 'OB / Swing Low'),
    },
    reasoning: buildReasoning(alignment, isLong, 'A'),
    triggerCondition: isLong
      ? 'Удержание структуры + ретест бычьего OB'
      : 'Удержание структуры + ретест медвежьего OB',
    riskReward: Number(riskA.toFixed(2)),
    atrMultiple: Math.abs(target - currentPrice) / atr,
  }

  const scenB: PriceScenario = {
    id: 'B',
    type: isLong ? 'LONG' : 'SHORT',
    label: 'Альтернатива (свип → продолжение)',
    probability: pctB,
    color: altColor,
    path: buildSweepPath(
      currentPrice,
      target,
      sweepLevel,
      atr,
      scaledSec,
      isLong
    ),
    entry: currentPrice,
    target: isLong ? target + atr * 0.8 : target - atr * 0.8,
    invalidation: stopLevel,
    liquidityTarget: {
      price: sweepLevel,
      type: (isLong ? nearestDown?.type : nearestUp?.type) ?? 'SWING_LOW',
      strength: 6,
      distancePercent: Math.abs(((sweepLevel - currentPrice) / currentPrice) * 100),
      direction: isLong ? 'DOWN' : 'UP',
      label: isLong ? 'SSL Sweep' : 'BSL Sweep',
    },
    reasoning: buildReasoning(alignment, isLong, 'B'),
    triggerCondition: isLong
      ? 'Прокол SSL → быстрый reclaim → лонг'
      : 'Прокол BSL → reclaim → шорт',
    riskReward: Number(
      (
        Math.abs((isLong ? target + atr * 0.8 : target - atr * 0.8) - currentPrice) /
        Math.max(Math.abs(currentPrice - sweepLevel), atr * 0.3)
      ).toFixed(2)
    ),
    atrMultiple: Math.abs(target - currentPrice) / atr + 0.8,
  }

  const breakTarget = isLong
    ? stopLevel - atr * 1.2
    : stopLevel + atr * 1.2

  const scenC: PriceScenario = {
    id: 'C',
    type: isLong ? 'SHORT' : 'LONG',
    label: 'Слом структуры (за стоп)',
    probability: pctC,
    color: breakColor,
    path: buildBreakPath(currentPrice, stopLevel, atr, scaledSec, isLong),
    entry: currentPrice,
    target: breakTarget,
    invalidation: isLong ? currentPrice + atr : currentPrice - atr,
    liquidityTarget: {
      price: stopLevel,
      type: 'SWING_LOW',
      strength: 8,
      distancePercent: Math.abs(((stopLevel - currentPrice) / currentPrice) * 100),
      direction: isLong ? 'DOWN' : 'UP',
      label: 'Invalidation / SL',
    },
    reasoning: buildReasoning(alignment, isLong, 'C'),
    triggerCondition: isLong
      ? 'Закрытие ниже стопа / микро-лоу → выход или BE'
      : 'Закрытие выше стопа / микро-хая → выход или BE',
    riskReward: 1,
    atrMultiple: Math.abs(breakTarget - currentPrice) / atr,
  }

  // Не сортируем — порядок A→B→C важен для UI и «мышления вероятностями»
  return [scenA, scenB, scenC]
}
