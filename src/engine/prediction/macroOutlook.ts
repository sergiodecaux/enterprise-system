/**
 * Weekly / macro coin outlook — A/B/C paths on higher timeframe.
 * Hunted liquidity, bounce zones, news bias folded into probabilities.
 */

import type { OhlcvCandle } from '../../api/mexc'
import { calculateAtr } from '../smc'
import type {
  LiquidityLevel,
  LiquidityTarget,
  MultiTFAlignment,
  PathPoint,
  PriceScenario,
  TFBias,
} from './types'
import { findNearestLiquidity } from './liquidityMap'

const COLORS = {
  A: '#22c55e',
  B: '#38bdf8',
  C: '#f97316',
  A_SHORT: '#ef4444',
  B_SHORT: '#a78bfa',
}

export type ForecastHorizon = 'INTRA' | 'MACRO'

export interface MacroOutlookContext {
  horizon: 'MACRO'
  weeklyBias: TFBias
  huntedLiquidity: LiquidityTarget | null
  bounceZone: { price: number; label: string; side: 'SUPPORT' | 'RESISTANCE' } | null
  newsBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  newsScore: number
  weekRangePct: number
  summary: string
}

function daySec(): number {
  return 86_400
}

function weekHighLow(candles: OhlcvCandle[]): { high: number; low: number } {
  const w = candles.slice(-7)
  if (!w.length) return { high: 0, low: 0 }
  return {
    high: Math.max(...w.map((c) => c[2])),
    low: Math.min(...w.map((c) => c[3])),
  }
}

function buildMacroPrimary(
  entry: number,
  target: number,
  bounce: number,
  atr: number,
  isLong: boolean
): PathPoint[] {
  const sign = isLong ? 1 : -1
  const sec = daySec()
  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Сейчас', isKeyLevel: true },
    {
      timeOffsetSeconds: sec * 1,
      price: bounce,
      label: isLong ? 'Отскок / набор' : 'Отскок вниз',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: sec * 3,
      price: entry + sign * atr * 0.8,
      label: 'Импульс недели',
    },
    {
      timeOffsetSeconds: sec * 5,
      price: entry + sign * Math.abs(target - entry) * 0.55,
      label: 'TP mid',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: sec * 7,
      price: target,
      label: 'Цель ликвидности',
      isKeyLevel: true,
    },
  ]
}

function buildMacroSweep(
  entry: number,
  target: number,
  sweep: number,
  atr: number,
  isLong: boolean
): PathPoint[] {
  const sign = isLong ? 1 : -1
  const sec = daySec()
  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Сейчас', isKeyLevel: true },
    {
      timeOffsetSeconds: sec * 1.5,
      price: sweep,
      label: isLong ? 'Охота SSL (неделя)' : 'Охота BSL (неделя)',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: sec * 3,
      price: entry + sign * atr * 0.2,
      label: 'Reclaim',
    },
    {
      timeOffsetSeconds: sec * 6,
      price: target + sign * atr * 0.6,
      label: 'Расширение',
      isKeyLevel: true,
    },
  ]
}

function buildMacroBreak(
  entry: number,
  stop: number,
  atr: number,
  isLong: boolean
): PathPoint[] {
  const sign = isLong ? -1 : 1
  const sec = daySec()
  const target = stop + sign * atr * 1.5
  return [
    { timeOffsetSeconds: 0, price: entry, label: 'Сейчас', isKeyLevel: true },
    {
      timeOffsetSeconds: sec * 2,
      price: stop,
      label: 'Слом недельной структуры',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: sec * 5,
      price: target,
      label: 'Магнит противоположной ликвидности',
      isKeyLevel: true,
    },
  ]
}

function macroProbabilities(
  alignment: MultiTFAlignment,
  newsBias: MacroOutlookContext['newsBias'],
  isLong: boolean
): { a: number; b: number; c: number } {
  let a = 62
  let b = 23
  let c = 15

  if (alignment.agreement) {
    a += 8
    c -= 4
    b -= 4
  }
  if (alignment.strength === 'STRONG_LONG' || alignment.strength === 'STRONG_SHORT') {
    a += 5
    c -= 3
  }

  const newsWith =
    (isLong && newsBias === 'BULLISH') || (!isLong && newsBias === 'BEARISH')
  const newsAgainst =
    (isLong && newsBias === 'BEARISH') || (!isLong && newsBias === 'BULLISH')
  if (newsWith) {
    a += 5
    c -= 3
  } else if (newsAgainst) {
    a -= 8
    c += 6
    b += 2
  }

  // normalize
  const sum = a + b + c
  return {
    a: Math.round((a / sum) * 100),
    b: Math.round((b / sum) * 100),
    c: Math.max(5, 100 - Math.round((a / sum) * 100) - Math.round((b / sum) * 100)),
  }
}

export function buildMacroContext(
  candles1d: OhlcvCandle[],
  alignment: MultiTFAlignment,
  liquidityMap: LiquidityLevel[],
  _currentPrice: number,
  newsBias: MacroOutlookContext['newsBias'] = 'NEUTRAL',
  newsScore = 0
): MacroOutlookContext {
  const { high, low } = weekHighLow(candles1d)
  const weekRangePct =
    low > 0 ? ((high - low) / low) * 100 : 0

  const isLong = alignment.dominantBias !== 'SHORT'
  const hunted = isLong
    ? findNearestLiquidity(liquidityMap, 'UP', 0.2)
    : findNearestLiquidity(liquidityMap, 'DOWN', 0.2)

  const bounceLiq = isLong
    ? findNearestLiquidity(liquidityMap, 'DOWN', 0.15)
    : findNearestLiquidity(liquidityMap, 'UP', 0.15)

  const bounceZone = bounceLiq
    ? {
        price: bounceLiq.price,
        label: bounceLiq.label,
        side: (isLong ? 'SUPPORT' : 'RESISTANCE') as 'SUPPORT' | 'RESISTANCE',
      }
    : high && low
      ? {
          price: isLong ? low : high,
          label: isLong ? 'Недельный low' : 'Недельный high',
          side: (isLong ? 'SUPPORT' : 'RESISTANCE') as 'SUPPORT' | 'RESISTANCE',
        }
      : null

  const huntedLiquidity: LiquidityTarget | null = hunted
    ? {
        price: hunted.price,
        type: hunted.type,
        strength: hunted.strength,
        distancePercent: hunted.distancePercent,
        direction: isLong ? 'UP' : 'DOWN',
        label: hunted.label,
      }
    : alignment.primaryLiqTarget

  const summaryParts = [
    `Недельный bias: ${alignment.dominantBias}`,
    huntedLiquidity
      ? `Охота за ликвидностью: ${huntedLiquidity.label} @ ${huntedLiquidity.price}`
      : 'Ликвидность: ищем ближайший магнит',
    bounceZone
      ? `Глобальный отскок от: ${bounceZone.label} @ ${bounceZone.price}`
      : null,
    newsBias !== 'NEUTRAL'
      ? `Новости: ${newsBias} (${newsScore >= 0 ? '+' : ''}${newsScore.toFixed(1)})`
      : 'Новости нейтральны',
  ].filter(Boolean)

  return {
    horizon: 'MACRO',
    weeklyBias: alignment.dominantBias,
    huntedLiquidity,
    bounceZone,
    newsBias,
    newsScore,
    weekRangePct,
    summary: summaryParts.join(' · '),
  }
}

/**
 * A/B/C на горизонте ~недели: тренд к ликвидности / свип / слом.
 */
export function buildMacroScenarios(
  candles1d: OhlcvCandle[],
  alignment: MultiTFAlignment,
  liquidityMap: LiquidityLevel[],
  currentPrice: number,
  newsBias: MacroOutlookContext['newsBias'] = 'NEUTRAL'
): PriceScenario[] {
  const atr =
    calculateAtr(candles1d, 14) ?? currentPrice * 0.025
  const isLong = alignment.dominantBias !== 'SHORT'
  const { a: pctA, b: pctB, c: pctC } = macroProbabilities(
    alignment,
    newsBias,
    isLong
  )

  const nearestUp = findNearestLiquidity(liquidityMap, 'UP', 0.2)
  const nearestDown = findNearestLiquidity(liquidityMap, 'DOWN', 0.2)
  const { high: wh, low: wl } = weekHighLow(candles1d)

  const target = isLong
    ? nearestUp?.price ?? (wh > 0 ? wh : currentPrice + atr * 3)
    : nearestDown?.price ?? (wl > 0 ? wl : currentPrice - atr * 3)

  const bounce = isLong
    ? nearestDown?.price ?? (wl > 0 ? wl : currentPrice - atr * 1.2)
    : nearestUp?.price ?? (wh > 0 ? wh : currentPrice + atr * 1.2)

  const sweep = bounce
  const stop = isLong
    ? Math.min(bounce, currentPrice) - atr * 0.8
    : Math.max(bounce, currentPrice) + atr * 0.8

  const primaryColor = isLong ? COLORS.A : COLORS.A_SHORT
  const altColor = isLong ? COLORS.B : COLORS.B_SHORT

  const scenA: PriceScenario = {
    id: 'A',
    type: isLong ? 'LONG' : 'SHORT',
    label: 'Неделя: тренд → магнит ликвидности',
    probability: pctA,
    color: primaryColor,
    path: buildMacroPrimary(currentPrice, target, bounce, atr, isLong),
    entry: currentPrice,
    target,
    invalidation: stop,
    liquidityTarget: {
      price: target,
      type: (isLong ? nearestUp?.type : nearestDown?.type) ?? 'DAILY_HIGH',
      strength: 8,
      distancePercent: Math.abs(((target - currentPrice) / currentPrice) * 100),
      direction: isLong ? 'UP' : 'DOWN',
      label: isLong
        ? (nearestUp?.label ?? 'Buy-side liquidity / weekly high')
        : (nearestDown?.label ?? 'Sell-side liquidity / weekly low'),
    },
    reasoning: [
      `HTF bias ${alignment.dominantBias} (1D/4H/1H)`,
      `Цель — ликвидность, за которой охотится цена`,
      `Отскок вероятен от ${bounce.toFixed(6)}`,
      newsBias !== 'NEUTRAL' ? `Фон новостей: ${newsBias}` : 'Новостной фон спокойный',
    ],
    triggerCondition: isLong
      ? 'Удержание выше недельной поддержки + импульс к BSL'
      : 'Удержание ниже сопротивления + импульс к SSL',
    riskReward: Number(
      (
        Math.abs(target - currentPrice) /
        Math.max(Math.abs(currentPrice - stop), atr * 0.5)
      ).toFixed(2)
    ),
    atrMultiple: Math.abs(target - currentPrice) / atr,
  }

  const scenB: PriceScenario = {
    id: 'B',
    type: isLong ? 'LONG' : 'SHORT',
    label: 'Неделя: охота за ликвой → reclaim',
    probability: pctB,
    color: altColor,
    path: buildMacroSweep(currentPrice, target, sweep, atr, isLong),
    entry: currentPrice,
    target: isLong ? target + atr * 0.5 : target - atr * 0.5,
    invalidation: stop,
    liquidityTarget: {
      price: sweep,
      type: (isLong ? nearestDown?.type : nearestUp?.type) ?? 'SWING_LOW',
      strength: 7,
      distancePercent: Math.abs(((sweep - currentPrice) / currentPrice) * 100),
      direction: isLong ? 'DOWN' : 'UP',
      label: isLong ? 'SSL / weekly low hunt' : 'BSL / weekly high hunt',
    },
    reasoning: [
      'Сначала снимают стопы против тренда',
      'Затем reclaim и поход к основной ликвидности',
      'Типичный smart-money week scenario',
    ],
    triggerCondition: isLong
      ? 'Прокол SSL / недельного low → закрытие обратно выше'
      : 'Прокол BSL / недельного high → закрытие обратно ниже',
    riskReward: 2,
    atrMultiple: Math.abs(target - currentPrice) / atr + 0.5,
  }

  const breakTarget = isLong ? stop - atr * 1.8 : stop + atr * 1.8
  const scenC: PriceScenario = {
    id: 'C',
    type: isLong ? 'SHORT' : 'LONG',
    label: 'Неделя: слом структуры',
    probability: pctC,
    color: COLORS.C,
    path: buildMacroBreak(currentPrice, stop, atr, isLong),
    entry: currentPrice,
    target: breakTarget,
    invalidation: isLong ? currentPrice + atr : currentPrice - atr,
    liquidityTarget: {
      price: stop,
      type: 'SWING_LOW',
      strength: 9,
      distancePercent: Math.abs(((stop - currentPrice) / currentPrice) * 100),
      direction: isLong ? 'DOWN' : 'UP',
      label: 'Invalidation / weekly structure break',
    },
    reasoning: [
      'Если недельная структура ломается — сценарий разворота',
      'Цена идёт к противоположному пулу ликвидности',
      'Меньшая вероятность, но обязателен в плане',
    ],
    triggerCondition: isLong
      ? 'Дневное закрытие ниже ключевой поддержки'
      : 'Дневное закрытие выше ключевого сопротивления',
    riskReward: 1.2,
    atrMultiple: Math.abs(breakTarget - currentPrice) / atr,
  }

  return [scenA, scenB, scenC]
}
