import type { OhlcvCandle } from '../../api/mexc'
import type { CoinSignal, TradeStyle } from '../types'
import type { MultiTFAlignment, LiquidityLevel } from '../prediction/types'
import { calculateAtr } from '../smc'
import { findNearestLiquidity } from '../prediction/liquidityMap'

export type TfLook = 'UP' | 'DOWN' | 'FLAT'

export interface TfNarrative {
  timeframe: '1W' | '1D' | '4H' | '1H'
  look: TfLook
  bias: 'LONG' | 'SHORT' | 'NEUTRAL'
  strength: number
  headline: string
  detail: string
}

export interface StyleZonePlan {
  style: TradeStyle
  side: 'LONG' | 'SHORT' | 'WAIT'
  probability: number
  zoneFrom: number
  zoneTo: number
  target: number
  invalidation: number
  holdHint: string
  summary: string
}

export interface MarketBrief {
  symbol: string
  displayName: string
  price: number
  nowHeadline: string
  nowDetail: string
  chartStory: string
  week: TfNarrative
  day: TfNarrative
  h4: TfNarrative
  h1: TfNarrative
  styles: StyleZonePlan[]
  generatedAt: number
}

function lookFromBias(
  bias: 'LONG' | 'SHORT' | 'NEUTRAL',
  rsi: number
): TfLook {
  if (bias === 'LONG') return 'UP'
  if (bias === 'SHORT') return 'DOWN'
  if (rsi >= 58) return 'UP'
  if (rsi <= 42) return 'DOWN'
  return 'FLAT'
}

function weekFromDaily(candles1d: OhlcvCandle[]): {
  look: TfLook
  changePct: number
  high: number
  low: number
} {
  const closed = candles1d.slice(0, -1)
  const week = closed.slice(-7)
  if (week.length < 3) {
    return { look: 'FLAT', changePct: 0, high: 0, low: 0 }
  }
  const open = week[0][1]
  const close = week[week.length - 1][4]
  const high = Math.max(...week.map((c) => c[2]))
  const low = Math.min(...week.map((c) => c[3]))
  const changePct = open > 0 ? ((close - open) / open) * 100 : 0
  const look: TfLook =
    changePct > 1.5 ? 'UP' : changePct < -1.5 ? 'DOWN' : 'FLAT'
  return { look, changePct, high, low }
}

function biasLabel(bias: 'LONG' | 'SHORT' | 'NEUTRAL'): string {
  if (bias === 'LONG') return 'бычий'
  if (bias === 'SHORT') return 'медвежий'
  return 'нейтральный'
}

function lookWord(look: TfLook): string {
  if (look === 'UP') return 'смотрит вверх'
  if (look === 'DOWN') return 'смотрит вниз'
  return 'в боковике'
}

/**
 * Полный бриф по монете: неделя → день → 4H → 1H + зоны по стилям.
 */
export function buildMarketBrief(params: {
  signal: CoinSignal
  alignment: MultiTFAlignment | null
  liquidityMap: LiquidityLevel[]
  candles1d: OhlcvCandle[]
  candles4h: OhlcvCandle[]
  candles1h: OhlcvCandle[]
}): MarketBrief {
  const { signal, alignment, liquidityMap, candles1d, candles4h, candles1h } =
    params
  const price = signal.price
  const atr1h = calculateAtr(candles1h, 14) ?? price * 0.008
  const atr4h = calculateAtr(candles4h, 14) ?? price * 0.015
  const atr1d = calculateAtr(candles1d, 14) ?? price * 0.03

  const weekStats = weekFromDaily(candles1d)
  const daily = alignment?.daily
  const h4 = alignment?.h4
  const h1 = alignment?.h1

  const week: TfNarrative = {
    timeframe: '1W',
    look: weekStats.look,
    bias:
      weekStats.look === 'UP'
        ? 'LONG'
        : weekStats.look === 'DOWN'
          ? 'SHORT'
          : 'NEUTRAL',
    strength: Math.min(95, Math.abs(weekStats.changePct) * 12),
    headline: `Неделя ${lookWord(weekStats.look)}`,
    detail:
      weekStats.changePct !== 0
        ? `За 7 дней ${weekStats.changePct >= 0 ? '+' : ''}${weekStats.changePct.toFixed(1)}%. Диапазон ${weekStats.low.toPrecision(6)}–${weekStats.high.toPrecision(6)}.`
        : 'Недостаточно дневных свечей для недельного контекста.',
  }

  const day: TfNarrative = {
    timeframe: '1D',
    look: daily
      ? lookFromBias(daily.bias, daily.rsi)
      : 'FLAT',
    bias: daily?.bias ?? 'NEUTRAL',
    strength: daily ? Math.min(90, Math.abs(daily.rsi - 50) * 2) : 30,
    headline: daily
      ? `День ${biasLabel(daily.bias)}`
      : 'День: нет данных',
    detail: daily
      ? `${daily.biasReason}. RSI ${daily.rsi.toFixed(0)}, закрытие в ${daily.closePosition === 'UPPER' ? 'верхней' : daily.closePosition === 'LOWER' ? 'нижней' : 'средней'} трети.`
      : 'Ждём загрузку 1D.',
  }

  const h4N: TfNarrative = {
    timeframe: '4H',
    look: h4 ? lookFromBias(h4.bias, h4.rsi) : 'FLAT',
    bias: h4?.bias ?? 'NEUTRAL',
    strength: h4 ? Math.min(90, Math.abs(h4.rsi - 50) * 2) : 30,
    headline: h4 ? `4H ${biasLabel(h4.bias)}` : '4H: нет данных',
    detail: h4
      ? `${h4.biasReason}. EMA20 ${h4.aboveEma20 ? 'сверху' : 'снизу'}, RSI ${h4.rsi.toFixed(0)}.`
      : 'Ждём загрузку 4H.',
  }

  const h1N: TfNarrative = {
    timeframe: '1H',
    look: h1 ? lookFromBias(h1.bias, h1.rsi) : 'FLAT',
    bias: h1?.bias ?? 'NEUTRAL',
    strength: h1 ? Math.min(90, Math.abs(h1.rsi - 50) * 2) : 30,
    headline: h1 ? `1H ${biasLabel(h1.bias)}` : '1H: нет данных',
    detail: h1
      ? `${h1.biasReason}. Это оперативный горизонт для интрадея.`
      : 'Ждём загрузку 1H.',
  }

  const mm = signal.mmIntent
  const raid = signal.raid
  const score = signal.scoreCard
  const nowBits: string[] = []
  if (mm && mm.drive !== 'NEUTRAL') {
    nowBits.push(`${mm.emoji} ММ: ${mm.label}`)
  }
  if (raid && raid.type !== 'NONE' && raid.isFresh) {
    nowBits.push(`Свежий ${raid.type}`)
  }
  if (signal.sessionFlipReason) {
    nowBits.push(signal.sessionFlipReason)
  }
  if (score) {
    nowBits.push(`ScoreCard ${score.grade} ${score.totalScore}/${score.maxScore}`)
  }

  const dominant =
    alignment?.dominantBias ??
    (signal.direction === 'LONG'
      ? 'LONG'
      : signal.direction === 'SHORT'
        ? 'SHORT'
        : 'NEUTRAL')

  const nowHeadline =
    dominant === 'LONG'
      ? 'Сейчас преобладает спрос — ищем лонг от зон'
      : dominant === 'SHORT'
        ? 'Сейчас преобладает предложение — ищем шорт от зон'
        : 'Рынок смешанный — ждём ясности от структуры'

  const nowDetail =
    nowBits.length > 0
      ? nowBits.join(' · ')
      : 'Нет острых триггеров: смотрим зоны и MTF-согласованность.'

  const agree = alignment?.agreement
  const chartStory = agree
    ? `График согласован (${alignment!.strength}): дневка, 4H и час смотрят в одну сторону — контртрендовые входы слабее.`
    : `Таймфреймы расходятся: неделя/день могут тянуть одно, час — другое. Скальп слушает 1H, свинг — неделю и день.`

  const nearestUp = findNearestLiquidity(liquidityMap, 'UP', 0.2)
  const nearestDown = findNearestLiquidity(liquidityMap, 'DOWN', 0.2)

  const baseSide = (style: TradeStyle): 'LONG' | 'SHORT' | 'WAIT' => {
    if (style === 'SWING') {
      if (week.bias === 'LONG' && day.bias !== 'SHORT') return 'LONG'
      if (week.bias === 'SHORT' && day.bias !== 'LONG') return 'SHORT'
      if (day.bias === 'LONG') return 'LONG'
      if (day.bias === 'SHORT') return 'SHORT'
      return 'WAIT'
    }
    if (style === 'SCALP') {
      if (h1?.bias === 'LONG') return 'LONG'
      if (h1?.bias === 'SHORT') return 'SHORT'
      if (signal.direction) return signal.direction
      return 'WAIT'
    }
    // INTRADAY
    if (h4?.bias && h4.bias === h1?.bias && h4.bias !== 'NEUTRAL') return h4.bias
    if (dominant === 'LONG' || dominant === 'SHORT') return dominant
    return signal.direction ?? 'WAIT'
  }

  const styleProb = (
    style: TradeStyle,
    side: 'LONG' | 'SHORT' | 'WAIT'
  ): number => {
    if (side === 'WAIT') return 35
    let p = 48
    if (style === 'SWING') {
      if (week.bias === side) p += 18
      if (day.bias === side) p += 14
      if (h4?.bias === side) p += 6
    } else if (style === 'INTRADAY') {
      if (h4?.bias === side) p += 16
      if (h1?.bias === side) p += 12
      if (day.bias === side) p += 8
    } else {
      if (h1?.bias === side) p += 18
      if (signal.direction === side) p += 10
      if (raid?.isFresh) p += 8
    }
    if (score?.ready && signal.direction === side) p += 8
    if (mm?.preferredSide === side) p += 6
    return Math.min(92, Math.max(28, Math.round(p)))
  }

  const planFor = (style: TradeStyle): StyleZonePlan => {
    const side = baseSide(style)
    const atr =
      style === 'SCALP' ? atr1h * 0.6 : style === 'SWING' ? atr1d : atr4h * 0.7
    const holdHint =
      style === 'SCALP'
        ? 'Держать минуты–час, не переносить через сильный импульс против'
        : style === 'INTRADAY'
          ? 'Держать часы внутри сессии, TP у 4H-магнита'
          : 'Держать дни–неделю, стоп за дневной структурой'

    if (side === 'WAIT') {
      return {
        style,
        side: 'WAIT',
        probability: styleProb(style, 'WAIT'),
        zoneFrom: price - atr * 0.4,
        zoneTo: price + atr * 0.4,
        target: price,
        invalidation: price - atr,
        holdHint,
        summary: 'Нет ясного направления на этом горизонте — ждём reclaim / sweep.',
      }
    }

    const isLong = side === 'LONG'
    const zoneFrom = isLong
      ? nearestDown?.price ?? price - atr * 0.85
      : price - atr * 0.25
    const zoneTo = isLong
      ? price + atr * 0.15
      : nearestUp?.price ?? price + atr * 0.85
    const target = isLong
      ? nearestUp?.price ?? price + atr * (style === 'SCALP' ? 1.2 : style === 'SWING' ? 3.5 : 2.2)
      : nearestDown?.price ?? price - atr * (style === 'SCALP' ? 1.2 : style === 'SWING' ? 3.5 : 2.2)
    const invalidation = isLong
      ? Math.min(zoneFrom, price) - atr * (style === 'SCALP' ? 0.35 : 0.8)
      : Math.max(zoneTo, price) + atr * (style === 'SCALP' ? 0.35 : 0.8)

    const lo = Math.min(zoneFrom, zoneTo)
    const hi = Math.max(zoneFrom, zoneTo)

    return {
      style,
      side,
      probability: styleProb(style, side),
      zoneFrom: lo,
      zoneTo: hi,
      target,
      invalidation,
      holdHint,
      summary: isLong
        ? `Ищем LONG от ${lo.toPrecision(6)}–${hi.toPrecision(6)} → цель ~${target.toPrecision(6)}`
        : `Ищем SHORT от ${lo.toPrecision(6)}–${hi.toPrecision(6)} → цель ~${target.toPrecision(6)}`,
    }
  }

  return {
    symbol: signal.symbol,
    displayName: signal.displayName,
    price,
    nowHeadline,
    nowDetail,
    chartStory,
    week,
    day,
    h4: h4N,
    h1: h1N,
    styles: [planFor('SCALP'), planFor('INTRADAY'), planFor('SWING')],
    generatedAt: Date.now(),
  }
}
