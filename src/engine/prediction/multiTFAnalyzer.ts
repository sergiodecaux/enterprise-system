import type { OhlcvCandle } from '../../api/mexc'
import type {
  TFSnapshot,
  TFBias,
  MultiTFAlignment,
  AlignmentStrength,
  LiquidityTarget,
} from './types'
import { calculateEmaSeries } from '../indicators/trend'
import { calculateRsiSeries } from '../indicators/momentum'

function makeNeutralSnapshot(tf: '1d' | '4h' | '1h'): TFSnapshot {
  return {
    timeframe: tf,
    close: 0,
    open: 0,
    high: 0,
    low: 0,
    direction: 'DOJI',
    closePosition: 'MIDDLE',
    bodyPercent: 0,
    consecutiveSameSide: 1,
    ema20: null,
    ema200: null,
    aboveEma20: false,
    aboveEma200: false,
    rsi: 50,
    bias: 'NEUTRAL',
    biasReason: 'Недостаточно данных',
  }
}

/** Анализ последнего закрытого бара TF */
export function analyzeTFSnapshot(
  candles: OhlcvCandle[],
  timeframe: '1d' | '4h' | '1h'
): TFSnapshot {
  const closed = candles.slice(0, -1)
  const last = closed[closed.length - 1]
  const prev = closed[closed.length - 2]

  if (!last || !prev) {
    return makeNeutralSnapshot(timeframe)
  }

  const [, open, high, low, close] = last
  const range = high - low

  const bodySize = Math.abs(close - open)
  const bodyPercent = range > 0 ? (bodySize / range) * 100 : 0
  let direction: TFSnapshot['direction'] = 'DOJI'
  if (bodyPercent > 30) {
    direction = close > open ? 'BULLISH' : 'BEARISH'
  }

  const closeRatio = range > 0 ? (close - low) / range : 0.5
  const closePosition: TFSnapshot['closePosition'] =
    closeRatio > 0.66 ? 'UPPER' : closeRatio < 0.33 ? 'LOWER' : 'MIDDLE'

  let consecutiveSameSide = 1
  const currentDir = close > open ? 'bull' : 'bear'
  for (let i = closed.length - 2; i >= 0 && i >= closed.length - 10; i--) {
    const c = closed[i]
    const d = c[4] > c[1] ? 'bull' : 'bear'
    if (d === currentDir) consecutiveSameSide++
    else break
  }

  const ema20arr = calculateEmaSeries(closed, 20)
  const ema200arr = calculateEmaSeries(closed, 200)
  const ema20 = ema20arr.length ? ema20arr[ema20arr.length - 1].value : null
  const ema200 = ema200arr.length ? ema200arr[ema200arr.length - 1].value : null

  const rsiArr = calculateRsiSeries(closed, 14)
  const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1].value : 50

  let biasScore = 0
  const reasons: string[] = []

  if (direction === 'BULLISH') {
    biasScore += 1
    reasons.push(`${timeframe} свеча бычья`)
  } else if (direction === 'BEARISH') {
    biasScore -= 1
    reasons.push(`${timeframe} свеча медвежья`)
  }

  if (ema200 !== null) {
    if (close > ema200) {
      biasScore += 1
      reasons.push('Выше EMA200')
    } else {
      biasScore -= 1
      reasons.push('Ниже EMA200')
    }
  }

  if (closePosition === 'UPPER') {
    biasScore += 0.5
    reasons.push('Закрытие в верхней части диапазона')
  } else if (closePosition === 'LOWER') {
    biasScore -= 0.5
    reasons.push('Закрытие в нижней части диапазона')
  }

  if (rsi > 55) {
    biasScore += 0.5
    reasons.push(`RSI ${rsi.toFixed(0)} > 55`)
  } else if (rsi < 45) {
    biasScore -= 0.5
    reasons.push(`RSI ${rsi.toFixed(0)} < 45`)
  }

  const bias: TFBias =
    biasScore >= 1.5 ? 'LONG' : biasScore <= -1.5 ? 'SHORT' : 'NEUTRAL'

  return {
    timeframe,
    close,
    open,
    high,
    low,
    direction,
    closePosition,
    bodyPercent,
    consecutiveSameSide,
    ema20,
    ema200,
    aboveEma20: ema20 !== null && close > ema20,
    aboveEma200: ema200 !== null && close > ema200,
    rsi,
    bias,
    biasReason: reasons.slice(0, 3).join(' • '),
  }
}

function buildPrimaryTarget(
  daily: TFSnapshot,
  _h4: TFSnapshot,
  _h1: TFSnapshot,
  price: number,
  bias: TFBias
): LiquidityTarget {
  if (bias === 'LONG') {
    const target = daily.high > 0 ? daily.high * 1.002 : price * 1.01
    return {
      price: target,
      type: 'DAILY_HIGH',
      strength: 8,
      distancePercent: ((target - price) / price) * 100,
      direction: 'UP',
      label: `Daily High ${target.toFixed(2)}`,
    }
  }
  if (bias === 'SHORT') {
    const target = daily.low > 0 ? daily.low * 0.998 : price * 0.99
    return {
      price: target,
      type: 'DAILY_LOW',
      strength: 8,
      distancePercent: ((price - target) / price) * 100,
      direction: 'DOWN',
      label: `Daily Low ${target.toFixed(2)}`,
    }
  }
  return {
    price,
    type: 'POC',
    strength: 5,
    distancePercent: 0,
    direction: 'UP',
    label: 'Нейтральная зона',
  }
}

function buildSecondaryTarget(
  _daily: TFSnapshot,
  h4: TFSnapshot,
  _h1: TFSnapshot,
  price: number,
  bias: TFBias
): LiquidityTarget | null {
  if (bias === 'LONG') {
    const target = h4.high > 0 ? h4.high * 1.001 : price * 1.005
    return {
      price: target,
      type: 'SWING_HIGH',
      strength: 6,
      distancePercent: ((target - price) / price) * 100,
      direction: 'UP',
      label: `4H High ${target.toFixed(2)}`,
    }
  }
  if (bias === 'SHORT') {
    const target = h4.low > 0 ? h4.low * 0.999 : price * 0.995
    return {
      price: target,
      type: 'SWING_LOW',
      strength: 6,
      distancePercent: ((price - target) / price) * 100,
      direction: 'DOWN',
      label: `4H Low ${target.toFixed(2)}`,
    }
  }
  return null
}

export function calculateMTFAlignment(
  daily: TFSnapshot,
  h4: TFSnapshot,
  h1: TFSnapshot,
  currentPrice: number
): MultiTFAlignment {
  const tfScore = (snap: TFSnapshot): number => {
    if (snap.bias === 'LONG') return 2
    if (snap.bias === 'SHORT') return -2
    return 0
  }

  const score = tfScore(daily) + tfScore(h4) + tfScore(h1)
  const agreement = daily.bias === h4.bias && h4.bias === h1.bias && daily.bias !== 'NEUTRAL'

  const dominantBias: TFBias =
    score >= 2 ? 'LONG' : score <= -2 ? 'SHORT' : 'NEUTRAL'

  const strength: AlignmentStrength =
    score >= 5
      ? 'STRONG_LONG'
      : score >= 2
        ? 'LONG'
        : score <= -5
          ? 'STRONG_SHORT'
          : score <= -2
            ? 'SHORT'
            : 'NEUTRAL'

  return {
    daily,
    h4,
    h1,
    strength,
    score,
    agreement,
    dominantBias,
    primaryLiqTarget: buildPrimaryTarget(daily, h4, h1, currentPrice, dominantBias),
    secondaryLiqTarget: buildSecondaryTarget(daily, h4, h1, currentPrice, dominantBias),
    generatedAt: Date.now(),
  }
}
