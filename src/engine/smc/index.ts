import type { OhlcvCandle } from '../../api/mexc'
import type { AbsorptionCandle, LTFChoCHResult } from '../types'

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'RANGING'
export type TradeSide = 'LONG' | 'SHORT'
export type DailyBiasDirection = 'LONG_ONLY' | 'SHORT_ONLY' | 'BOTH' | 'NO_TRADE'

export interface MarketStructure {
  trend: TrendDirection
  lastBos: 'UP' | 'DOWN' | null
  swingHighs: Array<[number, number]>
  swingLows: Array<[number, number]>
  lastSwingHigh: number | null
  lastSwingLow: number | null
}

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  low?: number
  high?: number
  index: number
  strength: number
  volume: number
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH'
  top: number
  bottom: number
  index: number
}

export interface FibLevels {
  '0.236': number
  '0.382': number
  '0.5': number
  '0.618': number
  '0.705': number
  '0.786': number
  '1.0': number
  ote_top: number
  ote_bottom: number
}

export interface RejectionResult {
  rejected: boolean
  wickRatio: number
  bodyInZone: boolean
}

export interface ConfluenceResult {
  score: number
  zones: string[]
  bestZone: {
    top: number | null
    bottom: number | null
    sl: number | null
  }
}

export interface DailyAnalysis {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  pattern: string
  details: string
}

export interface DailyLevels {
  pdh: number
  pdl: number
  pdo: number
  pdc: number
  pwh: number
  pwl: number
  nearestResistance: number | null
  nearestSupport: number | null
  keyLevels: Array<{ price: number; touches: number }>
}

export interface DailyBiasResult {
  direction: DailyBiasDirection
  confidence: number
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  dailyAnalysis: DailyAnalysis | null
  dailyLevels: DailyLevels | null
}

export function calculateEma(data: number[], period: number): number | null {
  if (data.length < period) return null
  const k = 2 / (period + 1)
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k)
  }
  return ema
}

export function calculateRsi(data: number[], period = 14): number {
  if (data.length < period + 1) return 50

  const changes: number[] = []
  for (let i = 1; i < data.length; i++) {
    changes.push(data[i] - data[i - 1])
  }

  const gains = changes.map((c) => Math.max(0, c))
  const losses = changes.map((c) => Math.max(0, -c))

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function calculateAtr(candles: OhlcvCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i][2]
    const low = candles[i][3]
    const prevClose = candles[i - 1][4]
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  if (trs.length < period) return null
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period
}

export function detectMarketStructure(
  candles: OhlcvCandle[],
  lookback = 50
): MarketStructure {
  const empty: MarketStructure = {
    trend: 'RANGING',
    lastBos: null,
    swingHighs: [],
    swingLows: [],
    lastSwingHigh: null,
    lastSwingLow: null,
  }

  if (candles.length < lookback) return empty

  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const closes = candles.map((c) => c[4])

  const swingHighs: Array<[number, number]> = []
  const swingLows: Array<[number, number]> = []

  for (let i = 2; i < candles.length - 2; i++) {
    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) {
      swingHighs.push([i, highs[i]])
    }
    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) {
      swingLows.push([i, lows[i]])
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return {
      ...empty,
      swingHighs,
      swingLows,
      lastSwingHigh: swingHighs.length ? swingHighs[swingHighs.length - 1][1] : null,
      lastSwingLow: swingLows.length ? swingLows[swingLows.length - 1][1] : null,
    }
  }

  const lastHighs = swingHighs.slice(-4).map((sh) => sh[1])
  const lastLows = swingLows.slice(-4).map((sl) => sl[1])

  const higherHighs =
    lastHighs.length > 1 && lastHighs.every((v, i) => i === 0 || v >= lastHighs[i - 1])
  const higherLows =
    lastLows.length > 1 && lastLows.every((v, i) => i === 0 || v >= lastLows[i - 1])
  const lowerHighs =
    lastHighs.length > 1 && lastHighs.every((v, i) => i === 0 || v <= lastHighs[i - 1])
  const lowerLows =
    lastLows.length > 1 && lastLows.every((v, i) => i === 0 || v <= lastLows[i - 1])

  let trend: TrendDirection = 'RANGING'
  if (higherHighs && higherLows) trend = 'BULLISH'
  else if (lowerHighs && lowerLows) trend = 'BEARISH'

  let lastBos: 'UP' | 'DOWN' | null = null
  const currentPrice = closes[closes.length - 1]
  if (swingHighs.length && currentPrice > swingHighs[swingHighs.length - 1][1]) lastBos = 'UP'
  if (swingLows.length && currentPrice < swingLows[swingLows.length - 1][1]) lastBos = 'DOWN'

  return {
    trend,
    lastBos,
    swingHighs,
    swingLows,
    lastSwingHigh: swingHighs[swingHighs.length - 1][1],
    lastSwingLow: swingLows[swingLows.length - 1][1],
  }
}

export function findOrderBlocks(
  candles: OhlcvCandle[],
  _structure: MarketStructure,
  maxBlocks = 5
): OrderBlock[] {
  if (candles.length < 20) return []

  const opens = candles.map((c) => c[1])
  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const closes = candles.map((c) => c[4])
  const volumes = candles.map((c) => c[5])

  const orderBlocks: OrderBlock[] = []

  for (let i = 2; i < candles.length - 3; i++) {
    const isRed = closes[i] < opens[i]
    const isGreen = closes[i] > opens[i]
    const candleBody = Math.abs(closes[i] - opens[i])
    if (candleBody === 0) continue

    const avgCandleSize =
      i >= 10
        ? Array.from({ length: 10 }, (_, k) => Math.abs(closes[i - 10 + k] - opens[i - 10 + k])).reduce(
            (a, b) => a + b,
            0
          ) / 10
        : candleBody

    if (isRed && avgCandleSize > 0) {
      let impulseUp = 0
      for (let j = 1; j < Math.min(4, candles.length - i); j++) {
        impulseUp += Math.max(0, closes[i + j] - opens[i + j])
      }
      if (impulseUp > avgCandleSize * 2.5) {
        const strength = Math.min(10, Math.floor(impulseUp / avgCandleSize))
        const obBottom = Math.min(opens[i], closes[i])
        const obTop = Math.max(opens[i], closes[i])
        let zoneValid = true
        for (let k = i + 1; k < candles.length; k++) {
          if (closes[k] < obBottom) {
            zoneValid = false
            break
          }
        }
        if (zoneValid) {
          orderBlocks.push({
            type: 'BULLISH',
            top: obTop,
            bottom: obBottom,
            low: lows[i],
            index: i,
            strength,
            volume: volumes[i],
          })
        }
      }
    }

    if (isGreen && avgCandleSize > 0) {
      let impulseDown = 0
      for (let j = 1; j < Math.min(4, candles.length - i); j++) {
        impulseDown += Math.max(0, opens[i + j] - closes[i + j])
      }
      if (impulseDown > avgCandleSize * 2.5) {
        const strength = Math.min(10, Math.floor(impulseDown / avgCandleSize))
        const obBottom = Math.min(opens[i], closes[i])
        const obTop = Math.max(opens[i], closes[i])
        let zoneValid = true
        for (let k = i + 1; k < candles.length; k++) {
          if (closes[k] > obTop) {
            zoneValid = false
            break
          }
        }
        if (zoneValid) {
          orderBlocks.push({
            type: 'BEARISH',
            top: obTop,
            bottom: obBottom,
            high: highs[i],
            index: i,
            strength,
            volume: volumes[i],
          })
        }
      }
    }
  }

  return orderBlocks.sort((a, b) => b.strength - a.strength).slice(0, maxBlocks)
}

export function findFvg(candles: OhlcvCandle[], maxGaps = 5): FairValueGap[] {
  if (candles.length < 5) return []

  const highs = candles.map((c) => c[2])
  const lows = candles.map((c) => c[3])
  const fvgList: FairValueGap[] = []

  for (let i = 2; i < candles.length; i++) {
    if (lows[i] > highs[i - 2]) {
      const gapTop = lows[i]
      const gapBottom = highs[i - 2]
      let filled = false
      for (let k = i + 1; k < candles.length; k++) {
        if (lows[k] <= gapBottom) {
          filled = true
          break
        }
      }
      if (!filled) {
        fvgList.push({ type: 'BULLISH', top: gapTop, bottom: gapBottom, index: i })
      }
    }

    if (highs[i] < lows[i - 2]) {
      const gapTop = lows[i - 2]
      const gapBottom = highs[i]
      let filled = false
      for (let k = i + 1; k < candles.length; k++) {
        if (highs[k] >= gapTop) {
          filled = true
          break
        }
      }
      if (!filled) {
        fvgList.push({ type: 'BEARISH', top: gapTop, bottom: gapBottom, index: i })
      }
    }
  }

  return fvgList.slice(-maxGaps)
}

export function calculateFibonacciLevels(
  swingHigh: number,
  swingLow: number,
  direction: 'UP' | 'DOWN'
): FibLevels {
  const diff = swingHigh - swingLow

  if (direction === 'UP') {
    const levels = {
      '0.236': swingHigh - diff * 0.236,
      '0.382': swingHigh - diff * 0.382,
      '0.5': swingHigh - diff * 0.5,
      '0.618': swingHigh - diff * 0.618,
      '0.705': swingHigh - diff * 0.705,
      '0.786': swingHigh - diff * 0.786,
      '1.0': swingLow,
    }
    return {
      ...levels,
      ote_top: levels['0.618'],
      ote_bottom: levels['0.786'],
    }
  }

  const levels = {
    '0.236': swingLow + diff * 0.236,
    '0.382': swingLow + diff * 0.382,
    '0.5': swingLow + diff * 0.5,
    '0.618': swingLow + diff * 0.618,
    '0.705': swingLow + diff * 0.705,
    '0.786': swingLow + diff * 0.786,
    '1.0': swingHigh,
  }
  return {
    ...levels,
    ote_top: levels['0.786'],
    ote_bottom: levels['0.618'],
  }
}

export function checkCandleRejection(
  candle: OhlcvCandle,
  zoneTop: number,
  zoneBottom: number,
  direction: TradeSide,
  minWickRatio = 0.4
): RejectionResult {
  const openPrice = candle[1]
  const high = candle[2]
  const low = candle[3]
  const close = candle[4]

  const bodyTop = Math.max(openPrice, close)
  const bodyBottom = Math.min(openPrice, close)
  const totalRange = high - low

  if (totalRange === 0) {
    return { rejected: false, wickRatio: 0, bodyInZone: false }
  }

  if (direction === 'LONG') {
    const lowerWick = bodyBottom - low
    const wickRatio = lowerWick / totalRange
    const wickEnteredZone = low <= zoneTop
    const bodyAboveZone = bodyBottom >= zoneBottom
    const isGreen = close > openPrice
    const strongRejection = wickRatio > minWickRatio

    return {
      rejected: wickEnteredZone && bodyAboveZone && isGreen && strongRejection,
      wickRatio,
      bodyInZone: zoneBottom <= bodyBottom && bodyBottom <= zoneTop,
    }
  }

  const upperWick = high - bodyTop
  const wickRatio = upperWick / totalRange
  const wickEnteredZone = high >= zoneBottom
  const bodyBelowZone = bodyTop <= zoneTop
  const isRed = close < openPrice
  const strongRejection = wickRatio > minWickRatio

  return {
    rejected: wickEnteredZone && bodyBelowZone && isRed && strongRejection,
    wickRatio,
    bodyInZone: zoneBottom <= bodyTop && bodyTop <= zoneTop,
  }
}

export function calculateConfluence(
  currentPrice: number,
  orderBlocks: OrderBlock[],
  fvgList: FairValueGap[],
  fibLevels: FibLevels | null,
  direction: TradeSide
): ConfluenceResult {
  let score = 0
  const matchingZones: string[] = []
  const priceTolerance = currentPrice * 0.003

  let bestZoneTop: number | null = null
  let bestZoneBottom: number | null = null
  let slLevel: number | null = null

  for (const ob of orderBlocks) {
    if (direction === 'LONG' && ob.type === 'BULLISH') {
      if (ob.bottom - priceTolerance <= currentPrice && currentPrice <= ob.top + priceTolerance) {
        score += 3
        matchingZones.push(`OB Bullish [${ob.bottom.toFixed(4)}-${ob.top.toFixed(4)}]`)
        bestZoneTop = ob.top
        bestZoneBottom = ob.bottom
        slLevel = ob.low ?? ob.bottom * 0.997
      }
    } else if (direction === 'SHORT' && ob.type === 'BEARISH') {
      if (ob.bottom - priceTolerance <= currentPrice && currentPrice <= ob.top + priceTolerance) {
        score += 3
        matchingZones.push(`OB Bearish [${ob.bottom.toFixed(4)}-${ob.top.toFixed(4)}]`)
        bestZoneTop = ob.top
        bestZoneBottom = ob.bottom
        slLevel = ob.high ?? ob.top * 1.003
      }
    }
  }

  for (const fvg of fvgList) {
    if (direction === 'LONG' && fvg.type === 'BULLISH') {
      if (fvg.bottom - priceTolerance <= currentPrice && currentPrice <= fvg.top + priceTolerance) {
        score += 2
        matchingZones.push(`FVG Bullish [${fvg.bottom.toFixed(4)}-${fvg.top.toFixed(4)}]`)
        if (bestZoneTop === null) {
          bestZoneTop = fvg.top
          bestZoneBottom = fvg.bottom
        }
      }
    } else if (direction === 'SHORT' && fvg.type === 'BEARISH') {
      if (fvg.bottom - priceTolerance <= currentPrice && currentPrice <= fvg.top + priceTolerance) {
        score += 2
        matchingZones.push(`FVG Bearish [${fvg.bottom.toFixed(4)}-${fvg.top.toFixed(4)}]`)
        if (bestZoneTop === null) {
          bestZoneTop = fvg.top
          bestZoneBottom = fvg.bottom
        }
      }
    }
  }

  if (fibLevels) {
    const oteTop = fibLevels.ote_top
    const oteBottom = fibLevels.ote_bottom
    if (
      Math.min(oteTop, oteBottom) - priceTolerance <= currentPrice &&
      currentPrice <= Math.max(oteTop, oteBottom) + priceTolerance
    ) {
      score += 3
      matchingZones.push(
        `Fibo OTE [${Math.min(oteTop, oteBottom).toFixed(4)}-${Math.max(oteTop, oteBottom).toFixed(4)}]`
      )
    }

    for (const levelName of ['0.618', '0.786'] as const) {
      const levelPrice = fibLevels[levelName]
      if (Math.abs(currentPrice - levelPrice) <= priceTolerance) {
        score += 1
        matchingZones.push(`Fibo ${levelName}`)
      }
    }
  }

  return {
    score: Math.min(score, 10),
    zones: matchingZones,
    bestZone: { top: bestZoneTop, bottom: bestZoneBottom, sl: slLevel },
  }
}

export function analyzeDailyCandle(candles1d: OhlcvCandle[]): DailyAnalysis {
  if (candles1d.length < 21) {
    return {
      bias: 'NEUTRAL',
      confidence: 0,
      pattern: 'Недостаточно данных',
      details: '',
    }
  }

  const prevCandle = candles1d[candles1d.length - 2]
  const prev2Candle = candles1d[candles1d.length - 3]
  const currentCandle = candles1d[candles1d.length - 1]

  const prevOpen = prevCandle[1]
  const prevHigh = prevCandle[2]
  const prevLow = prevCandle[3]
  const prevClose = prevCandle[4]
  const prevVolume = prevCandle[5]

  const prev2Open = prev2Candle[1]
  const prev2High = prev2Candle[2]
  const prev2Low = prev2Candle[3]
  const prev2Close = prev2Candle[4]

  const currentPrice = currentCandle[4]

  const prevBody = Math.abs(prevClose - prevOpen)
  let prevRange = prevHigh - prevLow
  if (prevRange === 0) prevRange = 0.0001

  const prevUpperWick = prevHigh - Math.max(prevOpen, prevClose)
  const prevLowerWick = Math.min(prevOpen, prevClose) - prevLow
  const prevIsGreen = prevClose > prevOpen
  const prevIsRed = prevClose < prevOpen

  const bodyRatio = prevBody / prevRange
  const upperWickRatio = prevUpperWick / prevRange
  const lowerWickRatio = prevLowerWick / prevRange

  const volumes = candles1d.slice(-21, -1).map((c) => c[5])
  const avgVolume = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 1
  const volumeRatio = avgVolume > 0 ? prevVolume / avgVolume : 1

  const bodies = candles1d.slice(-21, -1).map((c) => Math.abs(c[4] - c[1]))
  const avgBody = bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length : 1
  const bodyStrength = avgBody > 0 ? prevBody / avgBody : 1

  const closesDaily = candles1d.map((c) => c[4])
  const ema20d = calculateEma(closesDaily, 20)
  const ema50d = calculateEma(closesDaily, 50)

  let pattern = 'Нет паттерна'
  let details = ''

  const isHammer = lowerWickRatio > 0.6 && bodyRatio < 0.3 && prevIsGreen
  const isBullEngulfing =
    prevIsGreen &&
    prev2Close < prev2Open &&
    prevClose > prev2Open &&
    prevOpen < prev2Close &&
    prevBody > Math.abs(prev2Close - prev2Open)
  const isBullMarubozu = prevIsGreen && bodyRatio > 0.75 && bodyStrength > 1.5

  const prev3Candle = candles1d.length >= 4 ? candles1d[candles1d.length - 4] : null
  let isMorningStar = false
  if (prev3Candle) {
    const prev3IsRed = prev3Candle[4] < prev3Candle[1]
    const prev2Body = Math.abs(prev2Close - prev2Open)
    const prev3Body = Math.abs(prev3Candle[4] - prev3Candle[1])
    if (prev3IsRed && prev2Body < prev3Body * 0.3 && prevIsGreen && prevBody > prev2Body) {
      isMorningStar = true
    }
  }

  const isShootingStar = upperWickRatio > 0.6 && bodyRatio < 0.3 && prevIsRed
  const isBearEngulfing =
    prevIsRed &&
    prev2Close > prev2Open &&
    prevClose < prev2Open &&
    prevOpen > prev2Close &&
    prevBody > Math.abs(prev2Close - prev2Open)
  const isBearMarubozu = prevIsRed && bodyRatio > 0.75 && bodyStrength > 1.5

  let isEveningStar = false
  if (prev3Candle) {
    const prev3IsGreen = prev3Candle[4] > prev3Candle[1]
    const prev2Body = Math.abs(prev2Close - prev2Open)
    const prev3Body = Math.abs(prev3Candle[4] - prev3Candle[1])
    if (prev3IsGreen && prev2Body < prev3Body * 0.3 && prevIsRed && prevBody > prev2Body) {
      isEveningStar = true
    }
  }

  const isDoji = bodyRatio < 0.1

  let bullScore = 0
  let bearScore = 0

  if (isHammer) {
    bullScore += 25
    pattern = 'Hammer (Молот)'
  }
  if (isBullEngulfing) {
    bullScore += 30
    pattern = 'Bullish Engulfing (Бычье поглощение)'
  }
  if (isBullMarubozu) {
    bullScore += 20
    pattern = 'Bullish Marubozu'
  }
  if (isMorningStar) {
    bullScore += 25
    pattern = 'Morning Star (Утренняя звезда)'
  }

  if (isShootingStar) {
    bearScore += 25
    pattern = 'Shooting Star (Падающая звезда)'
  }
  if (isBearEngulfing) {
    bearScore += 30
    pattern = 'Bearish Engulfing (Медвежье поглощение)'
  }
  if (isBearMarubozu) {
    bearScore += 20
    pattern = 'Bearish Marubozu'
  }
  if (isEveningStar) {
    bearScore += 25
    pattern = 'Evening Star (Вечерняя звезда)'
  }

  if (prevClose > prev2High) {
    bullScore += 15
    details += 'Закрытие выше предыдущего high. '
  } else if (prevClose < prev2Low) {
    bearScore += 15
    details += 'Закрытие ниже предыдущего low. '
  }

  const closePosition = (prevClose - prevLow) / prevRange
  if (closePosition > 0.75) {
    bullScore += 10
    details += `Закрытие в верхних 25% диапазона (${(closePosition * 100).toFixed(0)}%). `
  } else if (closePosition < 0.25) {
    bearScore += 10
    details += `Закрытие в нижних 25% диапазона (${(closePosition * 100).toFixed(0)}%). `
  }

  if (ema20d && ema50d) {
    if (prevClose > ema20d && ema20d > ema50d) {
      bullScore += 15
      details += 'Выше EMA20 > EMA50. '
    } else if (prevClose < ema20d && ema20d < ema50d) {
      bearScore += 15
      details += 'Ниже EMA20 < EMA50. '
    }
  }

  if (volumeRatio > 1.3) {
    if (prevIsGreen) {
      bullScore += 10
      details += `Повышенный объём на росте (x${volumeRatio.toFixed(1)}). `
    } else {
      bearScore += 10
      details += `Повышенный объём на падении (x${volumeRatio.toFixed(1)}). `
    }
  }

  if (currentPrice > prevHigh) {
    bullScore += 5
    details += 'Текущая цена выше вчерашнего high. '
  } else if (currentPrice < prevLow) {
    bearScore += 5
    details += 'Текущая цена ниже вчерашнего low. '
  }

  let consecutiveGreen = 0
  let consecutiveRed = 0
  for (let i = candles1d.length - 2; i > Math.max(0, candles1d.length - 7); i--) {
    if (candles1d[i][4] > candles1d[i][1]) consecutiveGreen++
    else break
  }
  for (let i = candles1d.length - 2; i > Math.max(0, candles1d.length - 7); i--) {
    if (candles1d[i][4] < candles1d[i][1]) consecutiveRed++
    else break
  }

  if (consecutiveGreen >= 3) {
    bullScore += 10
    details += `${consecutiveGreen} зелёных дней подряд. `
  }
  if (consecutiveRed >= 3) {
    bearScore += 10
    details += `${consecutiveRed} красных дней подряд. `
  }

  if (isDoji) {
    bullScore = Math.floor(bullScore * 0.5)
    bearScore = Math.floor(bearScore * 0.5)
    pattern = 'Doji (неопределённость)'
    details += 'Doji — рынок в нерешительности. '
  }

  const total = bullScore + bearScore
  if (total === 0) {
    return { bias: 'NEUTRAL', confidence: 50, pattern, details: details.trim() }
  }

  if (bullScore > bearScore) {
    return {
      bias: 'BULLISH',
      confidence: Math.min(95, 50 + bullScore),
      pattern,
      details: details.trim(),
    }
  }
  if (bearScore > bullScore) {
    return {
      bias: 'BEARISH',
      confidence: Math.min(95, 50 + bearScore),
      pattern,
      details: details.trim(),
    }
  }
  return { bias: 'NEUTRAL', confidence: 50, pattern, details: details.trim() }
}

export function getDailyLevels(candles1d: OhlcvCandle[]): DailyLevels | null {
  if (candles1d.length < 10) return null

  const prevDay = candles1d[candles1d.length - 2]
  const pdh = prevDay[2]
  const pdl = prevDay[3]
  const pdo = prevDay[1]
  const pdc = prevDay[4]

  const weekCandles = candles1d.slice(-7, -1)
  const pwh = Math.max(...weekCandles.map((c) => c[2]))
  const pwl = Math.min(...weekCandles.map((c) => c[3]))

  const allHighs = candles1d.slice(-30).map((c) => c[2])
  const allLows = candles1d.slice(-30).map((c) => c[3])
  const allLevels = [...allHighs, ...allLows]

  const currentPrice = candles1d[candles1d.length - 1][4]
  const tolerance = currentPrice * 0.005

  const clusters: Array<{ price: number; touches: number }> = []
  const used = new Set<number>()

  for (let i = 0; i < allLevels.length; i++) {
    if (used.has(i)) continue
    const cluster = [allLevels[i]]
    for (let j = 0; j < allLevels.length; j++) {
      if (j !== i && !used.has(j) && Math.abs(allLevels[i] - allLevels[j]) <= tolerance) {
        cluster.push(allLevels[j])
        used.add(j)
      }
    }
    if (cluster.length >= 3) {
      clusters.push({
        price: cluster.reduce((a, b) => a + b, 0) / cluster.length,
        touches: cluster.length,
      })
    }
    used.add(i)
  }

  clusters.sort((a, b) => b.touches - a.touches)

  const resistances = clusters.filter((c) => c.price > currentPrice).sort((a, b) => a.price - b.price)
  const supports = clusters
    .filter((c) => c.price < currentPrice)
    .sort((a, b) => b.price - a.price)

  return {
    pdh,
    pdl,
    pdo,
    pdc,
    pwh,
    pwl,
    nearestResistance: resistances[0]?.price ?? null,
    nearestSupport: supports[0]?.price ?? null,
    keyLevels: clusters.slice(0, 5),
  }
}

export function resolveDailyBias(candles1d: OhlcvCandle[]): DailyBiasResult {
  if (!candles1d.length || candles1d.length < 21) {
    return {
      direction: 'BOTH',
      confidence: 50,
      bias: 'NEUTRAL',
      dailyAnalysis: null,
      dailyLevels: null,
    }
  }

  const dailyAnalysis = analyzeDailyCandle(candles1d)
  const dailyLevels = getDailyLevels(candles1d)
  const { bias, confidence } = dailyAnalysis

  let direction: DailyBiasDirection
  if (confidence >= 70) {
    if (bias === 'BULLISH') direction = 'LONG_ONLY'
    else if (bias === 'BEARISH') direction = 'SHORT_ONLY'
    else direction = 'BOTH'
  } else if (confidence >= 55) {
    direction = 'BOTH'
  } else {
    direction = 'NO_TRADE'
  }

  return { direction, confidence, bias, dailyAnalysis, dailyLevels }
}

/** Map confluence score (0-10) to probability percent */
export function scoreToProbability(score: number): number {
  return Math.round(Math.min(10, Math.max(0, score)) / 10 * 100)
}

/**
 * detectEqualLevels — находит кластеры Equal Highs и Equal Lows (ликвидность).
 *
 * Алгоритм:
 * 1. Собираем все swing highs и swing lows через detectMarketStructure
 * 2. Кластеризуем точки, чья цена отличается не более чем на tolerancePct%
 * 3. Кластеры с 2+ касаниями = зона ликвидности
 * 4. Маркируем isActive = цена ещё не протестировала уровень
 */
export function detectEqualLevels(
  candles: OhlcvCandle[],
  currentPrice: number,
  tolerancePct = 0.003,
  maxLevels = 5
): {
  equalHighs: Array<import('../types').EqualLevel>
  equalLows: Array<import('../types').EqualLevel>
} {
  if (candles.length < 10 || currentPrice <= 0) {
    return { equalHighs: [], equalLows: [] }
  }

  const structure = detectMarketStructure(
    candles,
    Math.min(candles.length - 2, 100)
  )

  const rawHighs = structure.swingHighs
  const rawLows = structure.swingLows

  function clusterPoints(
    points: Array<[number, number]>,
    type: 'HIGH' | 'LOW'
  ): Array<import('../types').EqualLevel> {
    const used = new Set<number>()
    const clusters: Array<import('../types').EqualLevel> = []

    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue

      const [idxI, priceI] = points[i]
      const clusterIndices = [idxI]
      const clusterPrices = [priceI]
      used.add(i)

      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue
        const [idxJ, priceJ] = points[j]
        const diff = Math.abs(priceI - priceJ) / priceI
        if (diff <= tolerancePct) {
          clusterIndices.push(idxJ)
          clusterPrices.push(priceJ)
          used.add(j)
        }
      }

      if (clusterPrices.length < 2) continue

      const avgPrice =
        clusterPrices.reduce((a, b) => a + b, 0) / clusterPrices.length
      const touches = clusterPrices.length

      const isActive =
        type === 'HIGH' ? currentPrice < avgPrice : currentPrice > avgPrice

      const distancePct =
        (Math.abs(currentPrice - avgPrice) / currentPrice) * 100

      let strength: 'WEAK' | 'MEDIUM' | 'STRONG'
      if (touches >= 5) strength = 'STRONG'
      else if (touches >= 3) strength = 'MEDIUM'
      else strength = 'WEAK'

      clusters.push({
        price: avgPrice,
        type,
        touches,
        indices: clusterIndices,
        strength,
        isActive,
        distancePct,
      })
    }

    clusters.sort((a, b) => {
      const strengthOrder = { STRONG: 3, MEDIUM: 2, WEAK: 1 }
      const sd = strengthOrder[b.strength] - strengthOrder[a.strength]
      if (sd !== 0) return sd
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      return a.distancePct - b.distancePct
    })

    return clusters.slice(0, maxLevels)
  }

  return {
    equalHighs: clusterPoints(rawHighs, 'HIGH'),
    equalLows: clusterPoints(rawLows, 'LOW'),
  }
}

/**
 * buildLiquidityMap — собирает полный LiquidityMap для символа.
 * Вычисляет liquidityBoost: насколько близко цена к магниту ликвидности.
 */
export function buildLiquidityMap(
  candles: OhlcvCandle[],
  currentPrice: number,
  symbol: string,
  timeframe: string,
  tolerancePct = 0.003
): import('../types').LiquidityMap {
  const { equalHighs, equalLows } = detectEqualLevels(
    candles,
    currentPrice,
    tolerancePct
  )

  const bslCandidates = equalHighs
    .filter((l) => l.price > currentPrice)
    .sort((a, b) => a.price - b.price)
  const nearestBSL = bslCandidates[0] ?? null

  const sslCandidates = equalLows
    .filter((l) => l.price < currentPrice)
    .sort((a, b) => b.price - a.price)
  const nearestSSL = sslCandidates[0] ?? null

  let liquidityBoost = 0

  const computeBoost = (
    level: import('../types').EqualLevel | null
  ): number => {
    if (!level || !level.isActive) return 0
    const dist = level.distancePct
    const strengthMul =
      level.strength === 'STRONG'
        ? 1.0
        : level.strength === 'MEDIUM'
          ? 0.6
          : 0.3
    if (dist < 0.5) return 0.5 * strengthMul
    if (dist < 1.5) return 2.0 * strengthMul
    if (dist < 3.0) return 1.0 * strengthMul
    if (dist < 5.0) return 0.5 * strengthMul
    return 0
  }

  const bslBoost = computeBoost(nearestBSL)
  const sslBoost = computeBoost(nearestSSL)
  liquidityBoost = Math.min(2, Math.max(bslBoost, sslBoost))

  return {
    symbol,
    timeframe,
    equalHighs,
    equalLows,
    nearestBSL,
    nearestSSL,
    liquidityBoost,
    computedAt: Date.now(),
  }
}

/**
 * calculateBtcDivergence — вычисляет дивергенцию силы альткоина vs BTC.
 *
 * Алгоритм «Relative Strength»:
 * 1. Берём N последних 1H свечей для BTC и для альта
 * 2. Считаем изменение цены за период: (close_last - close_first) / close_first * 100
 * 3. relativeStrength = altChange - btcChange
 * 4. Применяем пороговую логику по |relStr|
 */
export function calculateBtcDivergence(
  btcCandles1h: OhlcvCandle[],
  altCandles1h: OhlcvCandle[],
  lookback = 24
): import('../types').BtcDivergenceResult {
  const NONE_RESULT: import('../types').BtcDivergenceResult = {
    type: 'NONE',
    btcChangePct: 0,
    altChangePct: 0,
    relativeStrength: 0,
    scoreBoost: 0,
    label: '',
    lookbackCandles: lookback,
  }

  if (
    btcCandles1h.length < lookback + 1 ||
    altCandles1h.length < lookback + 1
  ) {
    return NONE_RESULT
  }

  const btcSlice = btcCandles1h.slice(-(lookback + 1))
  const altSlice = altCandles1h.slice(-(lookback + 1))

  const btcOpen = btcSlice[0][4]
  const btcClose = btcSlice[btcSlice.length - 1][4]
  const altOpen = altSlice[0][4]
  const altClose = altSlice[altSlice.length - 1][4]

  if (btcOpen === 0 || altOpen === 0) return NONE_RESULT

  const btcChangePct = ((btcClose - btcOpen) / btcOpen) * 100
  const altChangePct = ((altClose - altOpen) / altOpen) * 100
  const relativeStrength = altChangePct - btcChangePct

  const NOISE_THRESHOLD = 1.5
  const BULL_THRESHOLD = 3.0
  const BEAR_THRESHOLD = 3.0
  const STRONG_THRESHOLD = 6.0

  if (Math.abs(relativeStrength) < NOISE_THRESHOLD) {
    return {
      type: 'CORRELATED',
      btcChangePct,
      altChangePct,
      relativeStrength,
      scoreBoost: 0,
      label: `Коррелирует с BTC (${relativeStrength > 0 ? '+' : ''}${relativeStrength.toFixed(1)}%)`,
      lookbackCandles: lookback,
    }
  }

  if (relativeStrength >= BULL_THRESHOLD) {
    const intensity = Math.min(relativeStrength / STRONG_THRESHOLD, 1)
    const scoreBoost = 0.5 + intensity * 1.0
    const strengthLabel =
      relativeStrength >= STRONG_THRESHOLD ? 'СИЛЬНАЯ' : 'умеренная'

    return {
      type: 'BULL_DIV',
      btcChangePct,
      altChangePct,
      relativeStrength,
      scoreBoost: parseFloat(scoreBoost.toFixed(2)),
      label: `⚡ Сила альта выше рынка (BTC correlation divergence) [${strengthLabel}: альт ${altChangePct > 0 ? '+' : ''}${altChangePct.toFixed(1)}% vs BTC ${btcChangePct > 0 ? '+' : ''}${btcChangePct.toFixed(1)}%]`,
      lookbackCandles: lookback,
    }
  }

  if (relativeStrength <= -BEAR_THRESHOLD) {
    const intensity = Math.min(Math.abs(relativeStrength) / STRONG_THRESHOLD, 1)
    const scoreBoost = 0.5 + intensity * 1.0
    const strengthLabel =
      Math.abs(relativeStrength) >= STRONG_THRESHOLD ? 'СИЛЬНАЯ' : 'умеренная'

    return {
      type: 'BEAR_DIV',
      btcChangePct,
      altChangePct,
      relativeStrength,
      scoreBoost: parseFloat(scoreBoost.toFixed(2)),
      label: `🔻 Слабость альта хуже рынка (BTC correlation divergence) [${strengthLabel}: альт ${altChangePct > 0 ? '+' : ''}${altChangePct.toFixed(1)}% vs BTC ${btcChangePct > 0 ? '+' : ''}${btcChangePct.toFixed(1)}%]`,
      lookbackCandles: lookback,
    }
  }

  return {
    type: 'CORRELATED',
    btcChangePct,
    altChangePct,
    relativeStrength,
    scoreBoost: 0,
    label: `Близко к BTC (${relativeStrength > 0 ? '+' : ''}${relativeStrength.toFixed(1)}%)`,
    lookbackCandles: lookback,
  }
}

// ============================================================================
// MSS — Market Structure Shift (LTF Alignment)
// ============================================================================

/**
 * detectMSS — обнаруживает Market Structure Shift на младшем ТФ.
 *
 * Алгоритм:
 * 1. Берём последние N свечей (lookback)
 * 2. Находим последний коррекционный экстремум:
 *    - Для LONG: последний swing low перед текущей ценой
 *    - Для SHORT: последний swing high перед текущей ценой
 * 3. Если текущая свеча закрылась ЗА этим экстремумом — MSS подтверждён
 *
 * @param candles   - свечи младшего ТФ (1m или 5m), минимум 20
 * @param direction - ожидаемое направление сигнала (из HTF анализа)
 * @param lookback  - сколько свечей смотреть назад
 */
export function detectMSS(
  candles: OhlcvCandle[],
  direction: TradeSide,
  lookback = 30
): import('../types').MSSResult {
  const NONE: import('../types').MSSResult = {
    detected: false,
    direction: null,
    breakPrice: null,
    timeframe: '5m',
    breakCandleIndex: null,
    scoreBoost: 0,
    label: '',
  }

  if (candles.length < 10) return NONE

  const slice = candles.slice(-Math.min(lookback, candles.length))
  const highs = slice.map((c) => c[2])
  const lows = slice.map((c) => c[3])
  const closes = slice.map((c) => c[4])

  const lastClose = closes[closes.length - 1]
  const lastIdx = slice.length - 1

  if (direction === 'LONG') {
    let swingLowPrice: number | null = null
    let swingLowIdx = -1

    for (let i = slice.length - 4; i >= 1; i--) {
      if (
        lows[i] < lows[i - 1] &&
        lows[i] < lows[i + 1] &&
        (i + 2 >= slice.length || lows[i] < lows[i + 2])
      ) {
        swingLowPrice = lows[i]
        swingLowIdx = i
        break
      }
    }

    if (swingLowPrice === null) return NONE

    const hadPullback = closes
      .slice(swingLowIdx, lastIdx)
      .some((c) => c <= swingLowPrice * 1.002)

    if (lastClose > swingLowPrice && hadPullback) {
      return {
        detected: true,
        direction: 'BULLISH',
        breakPrice: swingLowPrice,
        timeframe: '5m',
        breakCandleIndex: lastIdx,
        scoreBoost: 1.5,
        label: `✅ Ювелирный вход подтверждён (MSS 5m) — пробой ${swingLowPrice.toFixed(4)} вверх`,
      }
    }
  }

  if (direction === 'SHORT') {
    let swingHighPrice: number | null = null
    let swingHighIdx = -1

    for (let i = slice.length - 4; i >= 1; i--) {
      if (
        highs[i] > highs[i - 1] &&
        highs[i] > highs[i + 1] &&
        (i + 2 >= slice.length || highs[i] > highs[i + 2])
      ) {
        swingHighPrice = highs[i]
        swingHighIdx = i
        break
      }
    }

    if (swingHighPrice === null) return NONE

    const hadPullback = closes
      .slice(swingHighIdx, lastIdx)
      .some((c) => c >= swingHighPrice * 0.998)

    if (lastClose < swingHighPrice && hadPullback) {
      return {
        detected: true,
        direction: 'BEARISH',
        breakPrice: swingHighPrice,
        timeframe: '5m',
        breakCandleIndex: lastIdx,
        scoreBoost: 1.5,
        label: `✅ Ювелирный вход подтверждён (MSS 5m) — пробой ${swingHighPrice.toFixed(4)} вниз`,
      }
    }
  }

  return NONE
}

// ============================================================================
// Liquidity Raid Detector — Sweep Detection
// ============================================================================

/**
 * detectLiquidityRaid — ищет свежий sweep ликвидности.
 */
export function detectLiquidityRaid(
  candles: OhlcvCandle[],
  direction: TradeSide,
  lookback = 20,
  freshnessCandles = 5
): import('../types').LiquidityRaidResult {
  const NONE: import('../types').LiquidityRaidResult = {
    type: 'NONE',
    sweptLevel: null,
    sweepDepthPct: 0,
    candlesAgo: 0,
    isFresh: false,
    scoreBoost: 0,
    label: '',
  }

  if (candles.length < 10) return NONE

  const slice = candles.slice(-Math.min(lookback + 5, candles.length))
  const highs = slice.map((c) => c[2])
  const lows = slice.map((c) => c[3])
  const closes = slice.map((c) => c[4])
  const lastIdx = slice.length - 1

  if (direction === 'LONG') {
    for (let i = lastIdx; i >= Math.max(1, lastIdx - freshnessCandles); i--) {
      let localLow = Infinity
      for (let j = Math.max(0, i - lookback); j < i; j++) {
        if (lows[j] < localLow) localLow = lows[j]
      }

      if (localLow === Infinity) continue

      const candleLow = lows[i]
      const candleClose = closes[i]

      const sweptBelow = candleLow < localLow
      const closedAbove = candleClose > localLow

      if (sweptBelow && closedAbove) {
        const sweepDepthPct = ((localLow - candleLow) / localLow) * 100
        const candlesAgo = lastIdx - i
        const isFresh = candlesAgo <= freshnessCandles

        return {
          type: 'BULL_SWEEP',
          sweptLevel: localLow,
          sweepDepthPct,
          candlesAgo,
          isFresh,
          scoreBoost: isFresh ? 2.0 : 0.5,
          label: `🎯 Sweep SSL: вынос лоу ${localLow.toFixed(4)} (${candlesAgo} свечей назад)${isFresh ? ' — СВЕЖИЙ' : ''}`,
        }
      }
    }
  }

  if (direction === 'SHORT') {
    for (let i = lastIdx; i >= Math.max(1, lastIdx - freshnessCandles); i--) {
      let localHigh = -Infinity
      for (let j = Math.max(0, i - lookback); j < i; j++) {
        if (highs[j] > localHigh) localHigh = highs[j]
      }

      if (localHigh === -Infinity) continue

      const candleHigh = highs[i]
      const candleClose = closes[i]

      const sweptAbove = candleHigh > localHigh
      const closedBelow = candleClose < localHigh

      if (sweptAbove && closedBelow) {
        const sweepDepthPct = ((candleHigh - localHigh) / localHigh) * 100
        const candlesAgo = lastIdx - i
        const isFresh = candlesAgo <= freshnessCandles

        return {
          type: 'BEAR_SWEEP',
          sweptLevel: localHigh,
          sweepDepthPct,
          candlesAgo,
          isFresh,
          scoreBoost: isFresh ? 2.0 : 0.5,
          label: `🎯 Sweep BSL: вынос хая ${localHigh.toFixed(4)} (${candlesAgo} свечей назад)${isFresh ? ' — СВЕЖИЙ' : ''}`,
        }
      }
    }
  }

  return NONE
}

// ============================================================================
// OTE Sniper Zone
// ============================================================================

/**
 * calculateOTEZone — вычисляет зону оптимального входа (0.618-0.786 Фибо).
 */
export function calculateOTEZone(
  candles: OhlcvCandle[],
  currentPrice: number,
  direction: TradeSide
): import('../types').OTESniperZone {
  const NONE: import('../types').OTESniperZone = {
    isActive: false,
    zoneTop: 0,
    zoneBottom: 0,
    impulseOrigin: 0,
    impulseEnd: 0,
    priceInZone: false,
    direction: null,
    scoreBoost: 0,
    label: '',
  }

  if (candles.length < 20 || currentPrice <= 0) return NONE

  const slice = candles.slice(-50)
  const highs = slice.map((c) => c[2])
  const lows = slice.map((c) => c[3])

  if (direction === 'LONG') {
    let swingLow = Infinity
    let swingHigh = -Infinity

    for (let i = slice.length - 3; i >= 2; i--) {
      if (
        highs[i] > highs[i - 1] &&
        highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1]
      ) {
        swingHigh = highs[i]
        for (let j = i - 1; j >= 1; j--) {
          if (lows[j] < lows[j - 1] && lows[j] < lows[j + 1]) {
            swingLow = lows[j]
            break
          }
        }
        break
      }
    }

    if (swingLow === Infinity || swingHigh === -Infinity || swingLow >= swingHigh) {
      return NONE
    }

    const diff = swingHigh - swingLow
    const ote618 = swingHigh - diff * 0.618
    const ote786 = swingHigh - diff * 0.786
    const zoneTop = ote618
    const zoneBottom = ote786
    const priceInZone = currentPrice >= zoneBottom && currentPrice <= zoneTop

    return {
      isActive: currentPrice > swingLow,
      zoneTop,
      zoneBottom,
      impulseOrigin: swingLow,
      impulseEnd: swingHigh,
      priceInZone,
      direction: 'LONG',
      scoreBoost: priceInZone ? 1.0 : 0,
      label: priceInZone
        ? `🎯 Вход в OTE Zone [${zoneBottom.toFixed(4)}-${zoneTop.toFixed(4)}]. Риск-реворд максимальный`
        : `OTE Zone: ${zoneBottom.toFixed(4)}-${zoneTop.toFixed(4)} (цена вне зоны)`,
    }
  }

  if (direction === 'SHORT') {
    let swingHigh = -Infinity
    let swingLow = Infinity

    for (let i = slice.length - 3; i >= 2; i--) {
      if (
        lows[i] < lows[i - 1] &&
        lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1]
      ) {
        swingLow = lows[i]
        for (let j = i - 1; j >= 1; j--) {
          if (highs[j] > highs[j - 1] && highs[j] > highs[j + 1]) {
            swingHigh = highs[j]
            break
          }
        }
        break
      }
    }

    if (swingHigh === -Infinity || swingLow === Infinity || swingHigh <= swingLow) {
      return NONE
    }

    const diff = swingHigh - swingLow
    const ote618 = swingLow + diff * 0.618
    const ote786 = swingLow + diff * 0.786
    const zoneTop = ote786
    const zoneBottom = ote618
    const priceInZone = currentPrice >= zoneBottom && currentPrice <= zoneTop

    return {
      isActive: currentPrice < swingHigh,
      zoneTop,
      zoneBottom,
      impulseOrigin: swingHigh,
      impulseEnd: swingLow,
      priceInZone,
      direction: 'SHORT',
      scoreBoost: priceInZone ? 1.0 : 0,
      label: priceInZone
        ? `🎯 Вход в OTE Zone [${zoneBottom.toFixed(4)}-${zoneTop.toFixed(4)}]. Риск-реворд максимальный`
        : `OTE Zone: ${zoneBottom.toFixed(4)}-${zoneTop.toFixed(4)} (цена вне зоны)`,
    }
  }

  return NONE
}

// ============================================================================
// Power of Three (PO3) — Asia Box
// ============================================================================

/**
 * analyzePO3 — анализирует фазу дня по концепции ICT Power of Three.
 */
export function analyzePO3(
  candles1h: OhlcvCandle[],
  currentPrice: number
): import('../types').PO3Analysis {
  const NONE: import('../types').PO3Analysis = {
    asiaBox: null,
    currentPhase: 'UNKNOWN',
    manipulationDetected: false,
    manipulationDirection: null,
    returnIntoBox: false,
    phaseLabel: 'Нет данных',
    phaseIcon: '❓',
    tradingAdvice: 'Недостаточно данных для PO3 анализа',
    computedAt: Date.now(),
  }

  if (candles1h.length < 24) return NONE

  const now = new Date()
  const utcHour = now.getUTCHours()
  const utcDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  const todayStartMs = utcDate.getTime()

  let currentPhase: import('../types').PO3Phase
  if (utcHour >= 0 && utcHour < 7) {
    currentPhase = 'ACCUMULATION'
  } else if (utcHour >= 7 && utcHour < 13) {
    currentPhase = 'MANIPULATION'
  } else if (utcHour >= 13 && utcHour < 22) {
    currentPhase = 'DISTRIBUTION'
  } else {
    currentPhase = 'UNKNOWN'
  }

  const asiaCandles = candles1h.filter((c) => {
    const ts = c[0]
    const h = new Date(ts).getUTCHours()
    const d = new Date(ts).getTime()
    return h >= 0 && h < 7 && d >= todayStartMs - 86400_000
  })

  const todayAsia = asiaCandles.filter((c) => c[0] >= todayStartMs)
  const asiaSource = todayAsia.length >= 2 ? todayAsia : asiaCandles.slice(-7)

  if (asiaSource.length < 2) return NONE

  const asiaHigh = Math.max(...asiaSource.map((c) => c[2]))
  const asiaLow = Math.min(...asiaSource.map((c) => c[3]))
  const asiaMid = (asiaHigh + asiaLow) / 2
  const asiaRange = asiaMid > 0 ? ((asiaHigh - asiaLow) / asiaMid) * 100 : 0

  const asiaBox: import('../types').AsiaBox = {
    high: asiaHigh,
    low: asiaLow,
    mid: asiaMid,
    rangePct: asiaRange,
    date: utcDate.toISOString().split('T')[0],
    startTs: todayStartMs,
    endTs: todayStartMs + 7 * 3600_000,
  }

  const londonCandles = candles1h.filter((c) => {
    const h = new Date(c[0]).getUTCHours()
    return h >= 7 && h < 13 && c[0] >= todayStartMs
  })

  let manipulationDetected = false
  let manipulationDirection: import('../types').PO3Analysis['manipulationDirection'] =
    null

  if (londonCandles.length > 0) {
    const londonHigh = Math.max(...londonCandles.map((c) => c[2]))
    const londonLow = Math.min(...londonCandles.map((c) => c[3]))
    const londonClose = londonCandles[londonCandles.length - 1][4]

    const sweptHigh = londonHigh > asiaHigh && londonClose < asiaHigh
    const sweptLow = londonLow < asiaLow && londonClose > asiaLow

    if (sweptHigh && sweptLow) {
      manipulationDetected = true
      manipulationDirection = 'BOTH'
    } else if (sweptHigh) {
      manipulationDetected = true
      manipulationDirection = 'HIGH_SWEPT'
    } else if (sweptLow) {
      manipulationDetected = true
      manipulationDirection = 'LOW_SWEPT'
    }
  }

  const returnIntoBox =
    manipulationDetected && currentPrice >= asiaLow && currentPrice <= asiaHigh

  const phaseMap: Record<
    import('../types').PO3Phase,
    { label: string; icon: string; advice: string }
  > = {
    ACCUMULATION: {
      label: 'Фаза 1: Накопление (Азия)',
      icon: '🌙',
      advice:
        'Азия формирует диапазон. Ждать открытия Лондона для сигнала направления.',
    },
    MANIPULATION: {
      label: manipulationDetected
        ? `Фаза 2: Манипуляция обнаружена (${manipulationDirection === 'HIGH_SWEPT' ? 'вынос хая' : manipulationDirection === 'LOW_SWEPT' ? 'вынос лоя' : 'двойной вынос'})`
        : 'Фаза 2: Лондон (манипуляция)',
      icon: '🎭',
      advice: manipulationDetected
        ? returnIntoBox
          ? '⚡ Цена вернулась в коробку Азии после выноса — ищи вход в направлении NY!'
          : 'Манипуляция произошла. Ждать возврата цены в коробку Азии для входа.'
        : 'Лондон ещё не сделал манипуляцию. Не торговать пробои хая/лоя Азии.',
    },
    DISTRIBUTION: {
      label: 'Фаза 3: Распределение (NY)',
      icon: '🚀',
      advice: manipulationDetected
        ? 'NY даёт истинное движение. Торговать в направлении возврата после манипуляции.'
        : 'NY открылся без манипуляции Лондона — осторожно, возможен трендовый день.',
    },
    UNKNOWN: {
      label: 'Вне торговых часов',
      icon: '💤',
      advice: 'Рынок закрыт или данные недостаточны.',
    },
  }

  const phaseInfo = phaseMap[currentPhase]

  return {
    asiaBox,
    currentPhase,
    manipulationDetected,
    manipulationDirection,
    returnIntoBox,
    phaseLabel: phaseInfo.label,
    phaseIcon: phaseInfo.icon,
    tradingAdvice: phaseInfo.advice,
    computedAt: Date.now(),
  }
}

// ============================================================================
// Stopping Volume / Absorption (VSA)
// ============================================================================

/**
 * VSA — Volume Spread Analysis.
 * Ищет свечу с огромным объёмом, маленьким телом и длинным нижним фитилём.
 */
export function detectAbsorptionCandle(
  candles: OhlcvCandle[],
  lookback = 10,
  volumeMultiplierThreshold = 2.5,
  bodyRatioMax = 0.35,
  lowerWickRatioMin = 0.45
): AbsorptionCandle {
  const empty: AbsorptionCandle = {
    detected: false,
    candleIndex: null,
    price: null,
    volume: 0,
    bodyRatio: 0,
    lowerWickRatio: 0,
    volumeMultiplier: 0,
    scoreBoost: 0,
    label: '',
  }

  if (candles.length < lookback + 20) return empty

  const baseStart = candles.length - lookback - 20
  const baseEnd = candles.length - lookback
  let avgVolume = 0
  for (let i = baseStart; i < baseEnd; i++) {
    avgVolume += candles[i][5]
  }
  avgVolume /= 20

  if (avgVolume === 0) return empty

  const searchStart = candles.length - lookback
  let best: AbsorptionCandle = empty

  for (let i = searchStart; i < candles.length; i++) {
    const [, open, high, low, close, volume] = candles[i]

    const totalRange = high - low
    if (totalRange === 0) continue

    const bodySize = Math.abs(close - open)
    const bodyBottom = Math.min(open, close)
    const lowerWick = bodyBottom - low

    const bodyRatio = bodySize / totalRange
    const lowerWickRatio = lowerWick / totalRange
    const volumeMultiplier = volume / avgVolume

    if (
      volumeMultiplier >= volumeMultiplierThreshold &&
      bodyRatio <= bodyRatioMax &&
      lowerWickRatio >= lowerWickRatioMin
    ) {
      if (volumeMultiplier > best.volumeMultiplier) {
        best = {
          detected: true,
          candleIndex: i,
          price: low,
          volume,
          bodyRatio,
          lowerWickRatio,
          volumeMultiplier,
          scoreBoost: 2,
          label: `Поглощение ×${volumeMultiplier.toFixed(1)} объём | фитиль ${(lowerWickRatio * 100).toFixed(0)}%`,
        }
      }
    }
  }

  return best
}

// ============================================================================
// LTF CHoCH — Change of Character (1m)
// ============================================================================

/**
 * LTF CHoCH — Change of Character на 1-минутном графике.
 */
export function detectLTFChoCH(
  candles1m: OhlcvCandle[],
  minSwings = 2
): LTFChoCHResult {
  const empty: LTFChoCHResult = {
    detected: false,
    breakLevel: null,
    breakPrice: null,
    breakCandleIndex: null,
    surgicalEntryDetected: false,
    surgicalEntryPrice: null,
    candlesAgo: 0,
    scoreBoost: 0,
    label: '',
  }

  if (candles1m.length < 20) return empty

  const highs = candles1m.map((c) => c[2])
  const lows = candles1m.map((c) => c[3])
  const closes = candles1m.map((c) => c[4])

  const swingHighs: Array<{ index: number; price: number }> = []
  const swingLows: Array<{ index: number; price: number }> = []

  for (let i = 1; i < candles1m.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) {
      swingHighs.push({ index: i, price: highs[i] })
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) {
      swingLows.push({ index: i, price: lows[i] })
    }
  }

  if (swingHighs.length < minSwings || swingLows.length < minSwings) return empty

  const lastHighs = swingHighs.slice(-minSwings - 1)
  const lastLows = swingLows.slice(-minSwings - 1)

  const isLowerHighs = lastHighs.every(
    (sh, i) => i === 0 || sh.price < lastHighs[i - 1].price
  )
  const isLowerLows = lastLows.every(
    (sl, i) => i === 0 || sl.price < lastLows[i - 1].price
  )

  if (!isLowerHighs || !isLowerLows) return empty

  const lastLow = lastLows[lastLows.length - 1]
  const chochHighCandidate = swingHighs
    .filter((sh) => sh.index < lastLow.index)
    .slice(-1)[0]

  if (!chochHighCandidate) return empty

  const chochLevel = chochHighCandidate.price
  const chochIndex = chochHighCandidate.index

  let breakCandleIndex: number | null = null
  let breakPrice: number | null = null

  for (let i = chochIndex + 1; i < candles1m.length; i++) {
    if (closes[i] > chochLevel) {
      breakCandleIndex = i
      breakPrice = closes[i]
      break
    }
  }

  if (breakCandleIndex === null || breakPrice === null) return empty

  const candlesAgo = candles1m.length - 1 - breakCandleIndex
  if (candlesAgo > 30) return empty

  let surgicalEntryDetected = false
  let surgicalEntryPrice: number | null = null

  for (let i = breakCandleIndex + 1; i < candles1m.length; i++) {
    const isRetracement = lows[i] < closes[breakCandleIndex]
    const holdingAboveLevel = lows[i] > chochLevel * 0.998

    if (isRetracement && holdingAboveLevel) {
      surgicalEntryDetected = true
      surgicalEntryPrice = lows[i]
      break
    }
  }

  const scoreBoost = surgicalEntryDetected ? 4 : 3

  const label = surgicalEntryDetected
    ? `CHoCH 1m @ ${chochLevel.toFixed(4)} → Surgical Entry @ ${surgicalEntryPrice?.toFixed(4)}`
    : `CHoCH 1m @ ${chochLevel.toFixed(4)} | пробой ${candlesAgo} свечей назад`

  return {
    detected: true,
    breakLevel: chochLevel,
    breakPrice,
    breakCandleIndex,
    surgicalEntryDetected,
    surgicalEntryPrice,
    candlesAgo,
    scoreBoost,
    label,
  }
}
