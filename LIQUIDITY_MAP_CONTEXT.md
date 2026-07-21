# Liquidity Map — полный снимок контекстных файлов

Дата: 2026-07-21

Ниже — полное содержимое запрошенных файлов без сокращений. Без правок и предложений.

---

## 1. src/engine/smc/index.ts

```typescript
import type { OhlcvCandle } from '../../api/mexc'

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
  direction: TradeSide
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
    const strongRejection = wickRatio > 0.4

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
  const strongRejection = wickRatio > 0.4

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
```

---

## 2. src/engine/types.ts

```typescript
import type {
  DailyBiasDirection,
  DailyAnalysis,
  DailyLevels,
  TrendDirection,
  TradeSide,
} from './smc'
import type { ChartPreferences } from './indicators/types'
import type { SessionSettings } from './sessions/types'
import type { NewsSettings, NewsIntelState } from './sentiment/types'

/** @deprecated Kept for backward-compat imports; unused in SMC path */
export interface IndicatorBucket {
  win_rate: number
  samples: number
  direction: 'LONG' | 'SHORT'
  avg_return: number
}

/** @deprecated */
export interface PairData {
  indicators: Record<string, IndicatorBucket>
  best_signal: {
    key: string
    win_rate: number
    direction: 'LONG' | 'SHORT'
  }
}

/** @deprecated */
export interface SystemCore {
  generated_at: string
  version: string
  pairs: Record<string, PairData>
  meta: {
    total_pairs: number
    timeframe: string
    lookback_days: number
    win_threshold_pct: number
    win_window_candles: number
  }
}

export interface LiveTicker {
  symbol: string // flat BTCUSDT
  price: number
  priceChange24h: number
  volume24h: number
  high24h: number
  low24h: number
  timestamp: number
}

export interface CoinSignal {
  symbol: string // flat BTCUSDT
  internalSymbol: string // BTC/USDT:USDT
  displayName: string // BTC/USDT
  price: number
  priceChange24h: number
  currentRSI: number | null
  /** Probability 0-100 from confluence weights */
  probabilityPct: number
  score: number
  direction: TradeSide | null
  zones: string[]
  sl: number | null
  tp1: number | null
  tp2: number | null
  tpDaily: number | null
  coinTrend: TrendDirection | null
  btcTrend: TrendDirection | null
  dailyBias: string | null
  dailyConfidence: number | null
  dailyPattern: string | null
  isLocked: boolean
  hasActiveSetup: boolean
  /** Legacy shim for old UI that read activeSignal.win_rate */
  activeSignal: IndicatorBucket | null
  activeSignalKey: string | null
}

export interface MarketContext {
  dailyDirection: DailyBiasDirection
  dailyBias: string
  dailyConfidence: number
  dailyPattern: string
  dailyDetails: string
  dailyAnalysis: DailyAnalysis | null
  dailyLevels: DailyLevels | null
  btcTrend: TrendDirection
  emaConfirms: boolean
  lastScanAt: number | null
  watchlistSize: number
  scanProgress: string
}

export interface AppState {
  liveTickets: Record<string, LiveTicker>
  signals: CoinSignal[]
  marketContext: MarketContext | null
  isScanning: boolean
  /** Extra symbols added via search (internal format) */
  extraWatchlist: string[]
  chartPreferences: ChartPreferences
  sessionSettings: SessionSettings
  newsSettings: NewsSettings
  newsIntel: NewsIntelState

  selectedCoin: string | null
  isDrawerOpen: boolean
  isProUser: boolean
  isConnected: boolean
  connectionStatus: 'ONLINE' | 'POLLING' | 'OFFLINE'
  lastUpdate: number

  updateTicker: (ticker: LiveTicker) => void
  updateSignals: (signals: CoinSignal[]) => void
  upsertSignal: (signal: CoinSignal) => void
  setMarketContext: (ctx: MarketContext | null) => void
  setScanning: (scanning: boolean) => void
  addToWatchlist: (internalSymbol: string) => boolean
  removeFromWatchlist: (internalSymbol: string) => void
  selectCoin: (symbol: string | null) => void
  setDrawerOpen: (open: boolean) => void
  setProUser: (isPro: boolean) => void
  setConnected: (connected: boolean) => void
  setConnectionStatus: (status: 'ONLINE' | 'POLLING' | 'OFFLINE') => void
  setChartPreferences: (prefs: Partial<ChartPreferences>) => void
  setSessionSettings: (settings: Partial<SessionSettings>) => void
  setNewsSettings: (settings: Partial<NewsSettings>) => void
  setNewsIntel: (partial: Partial<NewsIntelState>) => void
}

// ============================================================================
// OrderBook Types
// ============================================================================

export interface OrderBookLevel {
  price: number
  volume: number
  orderCount: number
  total?: number
}

export interface OrderBookSnapshot {
  symbol: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  version: number
  timestamp: number
}

export interface OrderBookWall {
  side: 'BID' | 'ASK'
  price: number
  volume: number
  ratio: number
}

export interface OrderBookMetrics {
  imbalance: number
  bidVolume: number
  askVolume: number
  bidOrders: number
  askOrders: number
  walls: OrderBookWall[]
  midPrice: number | null
  spread: number | null
  spreadPercent: number | null
  pressure: 'BUYERS' | 'SELLERS' | 'NEUTRAL'
}

export interface OrderBookState {
  snapshot: OrderBookSnapshot | null
  metrics: OrderBookMetrics | null
  isLoading: boolean
  error: string | null
  lastUpdate: number
}

// ============================================================================
// OrderBook History Types
// ============================================================================

export interface ImbalanceSnapshot {
  timestamp: number
  imbalance: number
  bidVolume: number
  askVolume: number
  pressure: 'BUYERS' | 'SELLERS' | 'NEUTRAL'
  spread: number | null
}

export interface OrderBookHistory {
  imbalanceHistory: ImbalanceSnapshot[]
  maxHistorySize: number
  startTime: number
}

export interface ImbalanceStats {
  current: number
  avg5min: number
  trend: 'RISING' | 'FALLING' | 'STABLE'
  volatility: number
  peakBuyers: number
  peakSellers: number
}

// ============================================================================
// Wall Tracking Types
// ============================================================================

export interface TrackedWall {
  id: string
  side: 'BID' | 'ASK'
  price: number
  initialVolume: number
  currentVolume: number
  firstSeen: number
  lastSeen: number
  isActive: boolean
}

export type WallEventType = 'APPEARED' | 'EATEN' | 'REDUCED' | 'INCREASED'

export interface WallEvent {
  type: WallEventType
  wall: TrackedWall
  timestamp: number
  reduction?: number
}

export interface WallTrackerState {
  walls: Map<string, TrackedWall>
  events: WallEvent[]
  maxEventsHistory: number
}

// ============================================================================
// Heatmap Types
// ============================================================================

export interface PriceLevel {
  price: number
  totalVolume: number
  appearances: number
  firstSeen: number
  lastSeen: number
}

export interface HeatmapState {
  levels: Map<number, PriceLevel>
  maxVolume: number
  priceStep: number
}
```

---

## 3. src/engine/ProbabilityEngine.ts

```typescript
/**
 * ProbabilityEngine — maps SniperBot SMC confluence weights to probability %.
 * Replaces historical system_core.json RSI-bucket lookups.
 */
import type { OhlcvCandle } from '../api/mexc'
import type { CoinSignal, WallTrackerState } from './types'
import {
  calculateConfluence,
  calculateFibonacciLevels,
  calculateRsi,
  checkCandleRejection,
  detectMarketStructure,
  findFvg,
  findOrderBlocks,
  scoreToProbability,
  type DailyBiasResult,
  type DailyLevels,
  type TradeSide,
  type TrendDirection,
} from './smc'
import { toDisplayName, toFlatSymbol } from '../api/mexc'
import { calculateWallBoost } from './orderbook/scoreBooster'
import { logger } from '../utils/logger'

export const CONFLUENCE_THRESHOLD = 5
export const COOLDOWN_MS = 180 * 60 * 1000

export interface AnalyzeSymbolInput {
  internalSymbol: string
  ohlcv4h: OhlcvCandle[]
  ohlcv1h: OhlcvCandle[]
  ohlcv15m: OhlcvCandle[]
  priceChange24h: number
  dailyBias: DailyBiasResult
  btcTrend: TrendDirection
  /** Optional live wall tracker (open coin) for score boost */
  wallTracker?: WallTrackerState
  /** News sentiment boost from News Intelligence (−1.5…+1.5) */
  newsSentimentBoost?: number
}

export interface AnalyzeSymbolResult {
  signal: CoinSignal
  triggered: boolean
}

function buildLevels(
  side: TradeSide,
  currentPrice: number,
  confluence: ReturnType<typeof calculateConfluence>,
  dailyLevels: DailyLevels | null
): { sl: number; tp1: number; tp2: number; tpDaily: number | null } {
  const zoneTop = confluence.bestZone.top!
  const zoneBottom = confluence.bestZone.bottom!

  let sl: number
  let tpDaily: number | null = null

  if (side === 'LONG') {
    const slZone = confluence.bestZone.sl
    sl = slZone ? slZone * 0.998 : zoneBottom * 0.997

    let slPercent = Math.abs(currentPrice - sl) / currentPrice
    if (slPercent > 0.015) sl = currentPrice * 0.985
    slPercent = Math.abs(currentPrice - sl) / currentPrice
    if (slPercent < 0.002) sl = currentPrice * 0.998

    const slDistance = Math.abs(currentPrice - sl)
    const tp1 = currentPrice + slDistance * 2
    const tp2 = currentPrice + slDistance * 3

    if (dailyLevels) {
      if (dailyLevels.pdh && dailyLevels.pdh > currentPrice) tpDaily = dailyLevels.pdh
      else if (dailyLevels.nearestResistance && dailyLevels.nearestResistance > currentPrice) {
        tpDaily = dailyLevels.nearestResistance
      }
    }

    return { sl, tp1, tp2, tpDaily }
  }

  const slZone = confluence.bestZone.sl
  sl = slZone ? slZone * 1.002 : zoneTop * 1.003

  let slPercent = Math.abs(currentPrice - sl) / currentPrice
  if (slPercent > 0.015) sl = currentPrice * 1.015
  slPercent = Math.abs(currentPrice - sl) / currentPrice
  if (slPercent < 0.002) sl = currentPrice * 1.002

  const slDistance = Math.abs(currentPrice - sl)
  const tp1 = currentPrice - slDistance * 2
  const tp2 = currentPrice - slDistance * 3

  if (dailyLevels) {
    if (dailyLevels.pdl && dailyLevels.pdl < currentPrice) tpDaily = dailyLevels.pdl
    else if (dailyLevels.nearestSupport && dailyLevels.nearestSupport < currentPrice) {
      tpDaily = dailyLevels.nearestSupport
    }
  }

  return { sl, tp1, tp2, tpDaily }
}

function emptySignal(
  internalSymbol: string,
  price: number,
  priceChange24h: number,
  rsi: number | null,
  coinTrend: TrendDirection | null,
  btcTrend: TrendDirection,
  dailyBias: DailyBiasResult
): CoinSignal {
  const flat = toFlatSymbol(internalSymbol)
  return {
    symbol: flat,
    internalSymbol,
    displayName: toDisplayName(internalSymbol),
    price,
    priceChange24h,
    currentRSI: rsi,
    probabilityPct: 0,
    score: 0,
    direction: null,
    zones: [],
    sl: null,
    tp1: null,
    tp2: null,
    tpDaily: null,
    coinTrend,
    btcTrend,
    dailyBias: dailyBias.bias,
    dailyConfidence: dailyBias.confidence,
    dailyPattern: dailyBias.dailyAnalysis?.pattern ?? null,
    isLocked: false,
    hasActiveSetup: false,
    activeSignal: null,
    activeSignalKey: null,
  }
}

/**
 * Analyze one symbol with SniperBot SMC rules.
 * Returns a radar row always; `triggered` when a full entry setup fires.
 */
export function analyzeSymbol(input: AnalyzeSymbolInput): AnalyzeSymbolResult {
  const {
    internalSymbol,
    ohlcv4h,
    ohlcv1h,
    ohlcv15m,
    priceChange24h,
    dailyBias,
    btcTrend,
    wallTracker,
    newsSentimentBoost,
  } = input

  const applyWallBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (!wallTracker || !direction) return { score, zones }
    const wallBoost = calculateWallBoost(wallTracker, direction)
    if (wallBoost.boost === 0) return { score, zones }
    const boosted = Math.min(Math.max(score + wallBoost.boost, 0), 10)
    console.log(
      `[PE] ${internalSymbol} Wall boost: ${wallBoost.boost >= 0 ? '+' : ''}${wallBoost.boost.toFixed(2)} (${wallBoost.reason})`
    )
    return {
      score: boosted,
      zones: [...zones, `WALL_BOOST: ${wallBoost.reason}`],
    }
  }

  const applyNewsBoost = (
    score: number,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (newsSentimentBoost === undefined || newsSentimentBoost === 0) {
      return { score, zones }
    }
    const clampedBoost = Math.max(-1.5, Math.min(1.5, newsSentimentBoost))
    const finalScore = Math.min(Math.max(score + clampedBoost, 0), 10)
    if (Math.abs(clampedBoost) > 0.1) {
      logger.info(
        `[PE] ${internalSymbol} news boost: ${clampedBoost.toFixed(2)}`
      )
    }
    return {
      score: finalScore,
      zones: [...zones, `NEWS_BOOST: ${clampedBoost.toFixed(2)}`],
    }
  }

  const closes1h = ohlcv1h.map((c) => c[4])
  const currentPrice = closes1h[closes1h.length - 1] ?? 0
  const rsi = closes1h.length ? calculateRsi(closes1h) : null

  if (
    ohlcv4h.length < 50 ||
    ohlcv1h.length < 50 ||
    ohlcv15m.length < 20 ||
    !currentPrice
  ) {
    return {
      signal: emptySignal(
        internalSymbol,
        currentPrice,
        priceChange24h,
        rsi,
        null,
        btcTrend,
        dailyBias
      ),
      triggered: false,
    }
  }

  const coinStructure = detectMarketStructure(ohlcv4h, 50)
  const coinTrend = coinStructure.trend

  if (coinTrend === 'RANGING' && btcTrend === 'RANGING') {
    return {
      signal: emptySignal(
        internalSymbol,
        currentPrice,
        priceChange24h,
        rsi,
        coinTrend,
        btcTrend,
        dailyBias
      ),
      triggered: false,
    }
  }

  const orderBlocks = findOrderBlocks(ohlcv1h, coinStructure)
  const fvgList = findFvg(ohlcv1h)

  let fibLevels = null
  if (coinStructure.lastSwingHigh && coinStructure.lastSwingLow) {
    const fibDirection = coinTrend === 'BULLISH' ? 'UP' : 'DOWN'
    fibLevels = calculateFibonacciLevels(
      coinStructure.lastSwingHigh,
      coinStructure.lastSwingLow,
      fibDirection
    )
  }

  const dailyDirection = dailyBias.direction
  const longPermitted = dailyDirection === 'LONG_ONLY' || dailyDirection === 'BOTH'
  const shortPermitted = dailyDirection === 'SHORT_ONLY' || dailyDirection === 'BOTH'

  const longAllowed =
    longPermitted &&
    (coinTrend === 'BULLISH' || (coinTrend === 'RANGING' && btcTrend === 'BULLISH'))
  const shortAllowed =
    shortPermitted &&
    (coinTrend === 'BEARISH' || (coinTrend === 'RANGING' && btcTrend === 'BEARISH'))

  const trySide = (side: TradeSide): AnalyzeSymbolResult | null => {
    const confluence = calculateConfluence(
      currentPrice,
      orderBlocks,
      fvgList,
      fibLevels,
      side
    )
    if (confluence.score < CONFLUENCE_THRESHOLD) return null
    if (!confluence.bestZone.top || !confluence.bestZone.bottom) return null

    const rejection = checkCandleRejection(
      ohlcv1h[ohlcv1h.length - 1],
      confluence.bestZone.top,
      confluence.bestZone.bottom,
      side
    )
    if (!rejection.rejected) return null

    if (side === 'LONG' && (rsi === null || rsi >= 45)) return null
    if (side === 'SHORT' && (rsi === null || rsi <= 55)) return null

    const levels = buildLevels(side, currentPrice, confluence, dailyBias.dailyLevels)
    const wallBoosted = applyWallBoost(confluence.score, side, confluence.zones)
    const boosted = applyNewsBoost(wallBoosted.score, wallBoosted.zones)
    const probabilityPct = scoreToProbability(boosted.score)
    const flat = toFlatSymbol(internalSymbol)

    const signal: CoinSignal = {
      symbol: flat,
      internalSymbol,
      displayName: toDisplayName(internalSymbol),
      price: currentPrice,
      priceChange24h,
      currentRSI: rsi,
      probabilityPct,
      score: boosted.score,
      direction: side,
      zones: boosted.zones,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tpDaily: levels.tpDaily,
      coinTrend,
      btcTrend,
      dailyBias: dailyBias.bias,
      dailyConfidence: dailyBias.confidence,
      dailyPattern: dailyBias.dailyAnalysis?.pattern ?? null,
      isLocked: false,
      hasActiveSetup: true,
      activeSignal: {
        win_rate: probabilityPct,
        samples: boosted.score,
        direction: side,
        avg_return: 0,
      },
      activeSignalKey: `SMC_${boosted.score}`,
    }

    return { signal, triggered: true }
  }

  if (longAllowed) {
    const longResult = trySide('LONG')
    if (longResult) return longResult
  }
  if (shortAllowed) {
    const shortResult = trySide('SHORT')
    if (shortResult) return shortResult
  }

  // No full trigger — still show best confluence as soft probability for radar
  let softScore = 0
  let softDirection: TradeSide | null = null
  let softZones: string[] = []

  if (longAllowed) {
    const c = calculateConfluence(currentPrice, orderBlocks, fvgList, fibLevels, 'LONG')
    if (c.score > softScore) {
      softScore = c.score
      softDirection = 'LONG'
      softZones = c.zones
    }
  }
  if (shortAllowed) {
    const c = calculateConfluence(currentPrice, orderBlocks, fvgList, fibLevels, 'SHORT')
    if (c.score > softScore) {
      softScore = c.score
      softDirection = 'SHORT'
      softZones = c.zones
    }
  }

  const softWall = applyWallBoost(softScore, softDirection, softZones)
  const softBoosted = applyNewsBoost(softWall.score, softWall.zones)
  const flat = toFlatSymbol(internalSymbol)
  const probabilityPct = scoreToProbability(softBoosted.score)

  return {
    signal: {
      symbol: flat,
      internalSymbol,
      displayName: toDisplayName(internalSymbol),
      price: currentPrice,
      priceChange24h,
      currentRSI: rsi,
      probabilityPct,
      score: softBoosted.score,
      direction: softBoosted.score > 0 ? softDirection : null,
      zones: softBoosted.zones,
      sl: null,
      tp1: null,
      tp2: null,
      tpDaily: null,
      coinTrend,
      btcTrend,
      dailyBias: dailyBias.bias,
      dailyConfidence: dailyBias.confidence,
      dailyPattern: dailyBias.dailyAnalysis?.pattern ?? null,
      isLocked: false,
      hasActiveSetup: false,
      activeSignal:
        softBoosted.score > 0 && softDirection
          ? {
              win_rate: probabilityPct,
              samples: softBoosted.score,
              direction: softDirection,
              avg_return: 0,
            }
          : null,
      activeSignalKey: softBoosted.score > 0 ? `SOFT_${softBoosted.score}` : null,
    },
    triggered: false,
  }
}
```

---

## 4. src/components/tactical/LiveChart.tsx

```tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type LineData,
  type Time,
} from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { Settings, Eye } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import {
  CHART_TIMEFRAMES,
  fetchOhlcv,
  type MexcTimeframe,
  type OhlcvCandle,
} from '../../api/mexc'
import type { CoinSignal } from '../../engine/types'
import { logger } from '../../utils/logger'
import { useChartIndicators } from '../../hooks/useChartIndicators'
import { useChartZones } from '../../hooks/useChartZones'
import { useMultiTFAnalysis } from '../../hooks/useMultiTFAnalysis'
import { usePriceForecast } from '../../hooks/usePriceForecast'
import ChartSettings from './ChartSettings'
import ChartOverlay from './ChartOverlay'
import SessionOverlay from './SessionOverlay'
import VolumePanel from './VolumePanel'
import OscillatorPanel from './OscillatorPanel'
import MultiTFPanel from './MultiTFPanel'
import PredictionOverlay from './PredictionOverlay'
import ScenarioLegend from './ScenarioLegend'
import { useSessionData } from '../../hooks/useSessionData'
import { SESSION_DEFINITIONS, getSessionAtHour } from '../../engine/sessions/sessionMap'

interface LiveChartProps {
  symbol: string
  flatSymbol: string
  signal?: CoinSignal | null
}

const CANDLE_LIMIT: Record<MexcTimeframe, number> = {
  '1m': 120,
  '5m': 120,
  '15m': 120,
  '1h': 120,
  '4h': 100,
  '1d': 90,
}

const INDICATOR_COLORS: Record<string, string> = {
  ema20: '#3b82f6',
  ema50: '#f59e0b',
  ema200: '#ef4444',
  sma9: '#8b5cf6',
  sma21: '#06b6d4',
  sma50: '#10b981',
  bb_upper: '#64748b',
  bb_middle: '#94a3b8',
  bb_lower: '#64748b',
  vwap: '#f97316',
}

const CHART_HEIGHT = 260

const LiveChart = ({ symbol, flatSymbol, signal = null }: LiveChartProps) => {
  const { t } = useTranslation()

  const ticker = useAppStore((s) => s.liveTickets[flatSymbol])
  const chartPreferences = useAppStore((s) => s.chartPreferences)
  const sessionSettings = useAppStore((s) => s.sessionSettings)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lineRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const priceLineRefs = useRef<IPriceLine[]>([])

  const [timeframe, setTimeframe] = useState<MexcTimeframe>('1h')
  const [candles, setCandles] = useState<OhlcvCandle[]>([])
  const [lwcData, setLwcData] = useState<CandlestickData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chartReady, setChartReady] = useState(0)
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null)
  const [showForecast, setShowForecast] = useState(true)
  const [activeScenarios, setActiveScenarios] = useState<Set<string>>(
    () => new Set(['A', 'B', 'C'])
  )

  const currentPrice = signal?.price ?? ticker?.price ?? 0

  const indicators = useChartIndicators(candles, chartPreferences.indicators)
  const { liquidityZones, priceLevels } = useChartZones(candles, chartPreferences.zones)

  const { alignment, liquidityMap, isLoading: mtfLoading } = useMultiTFAnalysis(
    symbol,
    currentPrice,
    true
  )

  const forecast = usePriceForecast(
    candles,
    alignment,
    liquidityMap,
    currentPrice,
    symbol,
    timeframe
  )

  const { sessions, weekends, news } = useSessionData(
    chartInstance,
    timeframe,
    sessionSettings
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setCandles([])
    setLwcData([])

    const load = async () => {
      try {
        const data = await fetchOhlcv(symbol, timeframe, CANDLE_LIMIT[timeframe])
        if (cancelled) return
        if (!data.length) {
          setError(t('chart_empty'))
          return
        }

        const mapped: CandlestickData[] = data.map((c) => ({
          time: (c[0] / 1000) as Time,
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
        }))
        setCandles(data)
        setLwcData(mapped)
      } catch (err) {
        logger.warn('LiveChart klines failed', err)
        if (!cancelled) setError(t('chart_error'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [symbol, timeframe, t])

  useEffect(() => {
    if (!containerRef.current || chartRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#111111' },
        textColor: '#e0e0e080',
      },
      grid: {
        vertLines: { color: '#1a1a1a' },
        horzLines: { color: '#1a1a1a' },
      },
      crosshair: { mode: 0 },
      timeScale: {
        borderColor: '#2a2a2a',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: '#2a2a2a' },
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    })

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00ff41',
      downColor: '#ff003c',
      borderUpColor: '#00ff41',
      borderDownColor: '#ff003c',
      wickUpColor: '#00ff4180',
      wickDownColor: '#ff003c80',
    })

    chartRef.current = chart
    candleRef.current = candleSeries
    setChartInstance(chart)
    setChartReady((n) => n + 1)

    const ro = new ResizeObserver((entries) => {
      if (!entries.length) return
      chart.applyOptions({
        width: entries[0].contentRect.width,
        height: CHART_HEIGHT,
      })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      Object.values(lineRefs.current).forEach((s) => {
        try {
          chart.removeSeries(s)
        } catch {
          /* ignore */
        }
      })
      lineRefs.current = {}
      priceLineRefs.current = []
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      setChartInstance(null)
    }
  }, [])

  useEffect(() => {
    if (!candleRef.current || !lwcData.length) return
    candleRef.current.setData(lwcData)
    chartRef.current?.timeScale().fitContent()
  }, [lwcData])

  useEffect(() => {
    if (!candleRef.current || !ticker || !lwcData.length) return
    if (timeframe === '4h' || timeframe === '1d') return

    const last = lwcData[lwcData.length - 1]
    const p = ticker.price
    if (Math.abs(last.close - p) < Number.EPSILON) return

    candleRef.current.update({
      ...last,
      close: p,
      high: Math.max(last.high, p),
      low: Math.min(last.low, p),
    })
  }, [ticker?.price, lwcData, timeframe])

  const updateLineSeries = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return

    const seriesMap: Record<string, LineData[]> = {
      ema20: indicators.ema20,
      ema50: indicators.ema50,
      ema200: indicators.ema200,
      sma9: indicators.sma9,
      sma21: indicators.sma21,
      sma50: indicators.sma50,
      vwap: indicators.vwap,
      bb_upper: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.upper,
      })),
      bb_middle: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.middle,
      })),
      bb_lower: indicators.bollingerBands.map((p) => ({
        time: p.time,
        value: p.lower,
      })),
    }

    Object.entries(seriesMap).forEach(([key, data]) => {
      if (data.length === 0) {
        if (lineRefs.current[key]) {
          try {
            chart.removeSeries(lineRefs.current[key])
          } catch {
            /* ignore */
          }
          delete lineRefs.current[key]
        }
        return
      }

      if (!lineRefs.current[key]) {
        const isDashed = key.startsWith('bb_')
        lineRefs.current[key] = chart.addLineSeries({
          color: INDICATOR_COLORS[key] ?? '#fff',
          lineWidth: key === 'ema200' ? 2 : 1,
          lineStyle: isDashed ? 2 : 0,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        })
      }

      lineRefs.current[key].setData(data)
    })
  }, [indicators])

  useEffect(() => {
    updateLineSeries()
  }, [updateLineSeries, chartReady])

  useEffect(() => {
    const series = candleRef.current
    if (!series) return

    for (const line of priceLineRefs.current) {
      try {
        series.removePriceLine(line)
      } catch {
        /* ignore */
      }
    }
    priceLineRefs.current = []

    const addLine = (
      price: number,
      color: string,
      title: string,
      lineStyle: 0 | 1 | 2 | 3 | 4 = 2
    ) => {
      try {
        const line = series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: true,
          title: chartPreferences.showLabels ? title : '',
        })
        priceLineRefs.current.push(line)
      } catch {
        /* ignore */
      }
    }

    for (const level of priceLevels) {
      addLine(level.price, level.color, level.label, level.lineStyle ?? 2)
    }

    if (signal?.sl != null) addLine(signal.sl, 'rgba(239, 68, 68, 0.8)', 'SL')
    if (signal?.tp1 != null) addLine(signal.tp1, 'rgba(34, 197, 94, 0.8)', 'TP1')
    if (signal?.tp2 != null) addLine(signal.tp2, 'rgba(34, 197, 94, 0.6)', 'TP2')
    if (signal?.tpDaily != null) {
      addLine(signal.tpDaily, 'rgba(100, 200, 255, 0.7)', 'TP Daily')
    }
  }, [priceLevels, chartPreferences.showLabels, chartReady, lwcData, signal])

  const oscillators: Array<'rsi' | 'macd' | 'stochastic' | 'atr'> = []
  if (chartPreferences.indicators.rsi) oscillators.push('rsi')
  if (chartPreferences.indicators.macd) oscillators.push('macd')
  if (chartPreferences.indicators.stochastic) oscillators.push('stochastic')
  if (chartPreferences.indicators.atr) oscillators.push('atr')

  const toggleScenario = (id: string) => {
    setActiveScenarios((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const liveSession = SESSION_DEFINITIONS[getSessionAtHour(new Date().getUTCHours())]
  const liveSessionBg = liveSession.lineColor.replace(
    /rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/,
    'rgba($1, $2, $3, 0.9)'
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-wider text-holo/40">
            {t('chart_title')}
          </span>
          {sessionSettings.enabled && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-black"
              style={{ backgroundColor: liveSessionBg }}
              title="Текущая торговая сессия (UTC)"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-black/70" />
              {liveSession.label}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              type="button"
              onClick={() => setTimeframe(tf.id)}
              className={`rounded px-2 py-1 font-mono text-xs transition-colors ${
                timeframe === tf.id
                  ? 'border border-matrix/50 bg-matrix/20 text-matrix'
                  : 'border border-transparent text-holo/40 hover:bg-hull-light hover:text-holo/70'
              }`}
            >
              {tf.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowForecast((v) => !v)}
            className={`rounded-lg p-1.5 transition-colors ${
              showForecast
                ? 'bg-holo/20 text-holo'
                : 'bg-hull-light/40 text-holo/60 hover:bg-hull-light/70 hover:text-holo'
            }`}
            title={t('forecast_toggle')}
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-hull-light/40 p-1.5 text-holo/60 transition-colors hover:bg-hull-light/70 hover:text-holo"
            title={t('chart_settings')}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="relative w-full overflow-hidden rounded-lg border border-hull-border bg-hull"
        style={{ height: CHART_HEIGHT }}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-hull/60 font-mono text-xs text-holo/40">
            {t('chart_loading')}
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center font-mono text-xs text-alert/80">
            {error}
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
        {chartReady > 0 && sessionSettings.enabled && (
          <SessionOverlay
            chart={chartInstance}
            series={candleRef.current}
            containerRef={containerRef}
            sessions={sessions}
            weekends={weekends}
            news={news}
            settings={sessionSettings}
            timeframe={timeframe}
          />
        )}
        {liquidityZones.length > 0 && chartReady > 0 && (
          <ChartOverlay
            chart={chartRef.current}
            series={candleRef.current}
            zones={liquidityZones}
            containerRef={containerRef}
            opacity={chartPreferences.opacity}
            showLabels={chartPreferences.showLabels}
          />
        )}
        {showForecast && forecast && chartReady > 0 && (
          <PredictionOverlay
            chart={chartRef.current}
            series={candleRef.current}
            forecast={forecast}
            activeScenarios={activeScenarios}
            containerRef={containerRef}
          />
        )}
      </div>

      {chartPreferences.indicators.volume && indicators.volume.length > 0 && (
        <VolumePanel volumeData={indicators.volume} height={50} />
      )}

      {oscillators.map((mode) => (
        <OscillatorPanel
          key={mode}
          mode={mode}
          rsiData={indicators.rsi}
          macdData={indicators.macd}
          stochasticData={indicators.stochastic}
          atrData={indicators.atr}
          height={80}
        />
      ))}

      <MultiTFPanel alignment={alignment} isLoading={mtfLoading} />

      {showForecast && forecast && (
        <ScenarioLegend
          scenarios={forecast.scenarios}
          dominantId={forecast.dominantScenario}
          activeScenarios={activeScenarios}
          onToggle={toggleScenario}
        />
      )}

      <ChartSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default LiveChart
```

---

## 5. src/hooks/useMexcScanner.ts

```typescript
import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  CORE_WATCHLIST,
  fetchOhlcv,
  fetchTickers,
  sleep,
  toFlatSymbol,
} from '../api/mexc'
import {
  calculateEma,
  detectMarketStructure,
  resolveDailyBias,
  type TrendDirection,
} from '../engine/smc'
import { analyzeSymbol, COOLDOWN_MS } from '../engine/ProbabilityEngine'
import type { CoinSignal, LiveTicker, MarketContext } from '../engine/types'
import { logger } from '../utils/logger'

const BTC = 'BTC/USDT:USDT'
const SCAN_PAUSE_MS = 120_000
const COIN_DELAY_MS = 300
const TICKER_POLL_MS = 5_000

/**
 * MEXC scanner — CORE_WATCHLIST + монеты из поиска (extraWatchlist).
 */
export const useMexcScanner = () => {
  const isMountedRef = useRef(true)
  const cooldownRef = useRef<Record<string, number>>({})
  const watchlistRef = useRef<string[]>([...CORE_WATCHLIST])

  const {
    updateTicker,
    updateSignals,
    setMarketContext,
    setScanning,
    setConnectionStatus,
  } = useAppStore()

  const syncWatchlist = useCallback(() => {
    const extra = useAppStore.getState().extraWatchlist
    const merged = Array.from(new Set<string>([...CORE_WATCHLIST, ...extra]))
    watchlistRef.current = merged
    return merged
  }, [])

  const refreshTickers = useCallback(async () => {
    try {
      const tickers = await fetchTickers()
      const watch = new Set(watchlistRef.current)
      let updated = 0
      for (const t of tickers) {
        if (!watch.has(t.symbol)) continue
        const live: LiveTicker = {
          symbol: toFlatSymbol(t.symbol),
          price: t.lastPrice,
          priceChange24h: t.priceChangePercent,
          volume24h: t.volume24h,
          high24h: t.high24h,
          low24h: t.low24h,
          timestamp: t.timestamp,
        }
        updateTicker(live)
        updated++
      }
      if (updated > 0) {
        setConnectionStatus('POLLING')
      }
    } catch (err) {
      logger.warn('Ticker poll failed', err)
      setConnectionStatus('OFFLINE')
    }
  }, [updateTicker, setConnectionStatus])

  const runScanCycle = useCallback(async () => {
    setScanning(true)
    syncWatchlist()

    try {
      // 0. Daily bias BTC 1D
      const candles1d = await fetchOhlcv(BTC, '1d', 60)
      const dailyBias = resolveDailyBias(candles1d)

      if (dailyBias.direction === 'NO_TRADE') {
        setMarketContext({
          dailyDirection: dailyBias.direction,
          dailyBias: dailyBias.bias,
          dailyConfidence: dailyBias.confidence,
          dailyPattern: dailyBias.dailyAnalysis?.pattern ?? '',
          dailyDetails: dailyBias.dailyAnalysis?.details ?? '',
          dailyAnalysis: dailyBias.dailyAnalysis,
          dailyLevels: dailyBias.dailyLevels,
          btcTrend: 'RANGING',
          emaConfirms: false,
          lastScanAt: Date.now(),
          watchlistSize: watchlistRef.current.length,
          scanProgress: 'Нет торговли — низкая уверенность дня',
        })
        logger.info('Daily bias NO_TRADE — skipping coin scan')
        return
      }

      await sleep(COIN_DELAY_MS)

      // 1. BTC structure 4H + EMA200 1H
      const btc4h = await fetchOhlcv(BTC, '4h', 100)
      await sleep(COIN_DELAY_MS)
      const btc1h = await fetchOhlcv(BTC, '1h', 300)

      const btcStructure = detectMarketStructure(btc4h, 50)
      const btcTrend: TrendDirection = btcStructure.trend
      const btcCloses1h = btc1h.map((c) => c[4])
      const btcEma200 = calculateEma(btcCloses1h, 200)
      const currentBtc = btcCloses1h[btcCloses1h.length - 1]
      let emaConfirms = false
      if (btcTrend === 'BULLISH' && btcEma200 && currentBtc > btcEma200) emaConfirms = true
      if (btcTrend === 'BEARISH' && btcEma200 && currentBtc < btcEma200) emaConfirms = true

      const ctxBase: Omit<MarketContext, 'scanProgress'> = {
        dailyDirection: dailyBias.direction,
        dailyBias: dailyBias.bias,
        dailyConfidence: dailyBias.confidence,
        dailyPattern: dailyBias.dailyAnalysis?.pattern ?? '',
        dailyDetails: dailyBias.dailyAnalysis?.details ?? '',
        dailyAnalysis: dailyBias.dailyAnalysis,
        dailyLevels: dailyBias.dailyLevels,
        btcTrend,
        emaConfirms,
        lastScanAt: Date.now(),
        watchlistSize: watchlistRef.current.length,
      }

      setMarketContext({ ...ctxBase, scanProgress: 'Сканирование...' })
      setConnectionStatus('POLLING')

      // Price map for 24h change
      const tickerMap = new Map<string, number>()
      try {
        const allTickers = await fetchTickers()
        for (const t of allTickers) {
          tickerMap.set(t.symbol, t.priceChangePercent)
          if (watchlistRef.current.includes(t.symbol)) {
            updateTicker({
              symbol: toFlatSymbol(t.symbol),
              price: t.lastPrice,
              priceChange24h: t.priceChangePercent,
              volume24h: t.volume24h,
              high24h: t.high24h,
              low24h: t.low24h,
              timestamp: t.timestamp,
            })
          }
        }
      } catch {
        /* non-fatal */
      }

      const results: CoinSignal[] = []
      const now = Date.now()

      for (let i = 0; i < watchlistRef.current.length; i++) {
        if (!isMountedRef.current) break
        const symbol = watchlistRef.current[i]

        setMarketContext({
          ...ctxBase,
          scanProgress: `${i + 1}/${watchlistRef.current.length} ${symbol}`,
        })

        const lastCd = cooldownRef.current[symbol] ?? 0
        const onCooldown = now - lastCd < COOLDOWN_MS

        try {
          await sleep(COIN_DELAY_MS)
          const ohlcv4h = await fetchOhlcv(symbol, '4h', 100)
          await sleep(200)
          const ohlcv1h = await fetchOhlcv(symbol, '1h', 100)
          await sleep(200)
          const ohlcv15m = await fetchOhlcv(symbol, '15m', 50)

          const baseSym = symbol.split('/')[0]
          const newsBoost =
            useAppStore.getState().newsSettings.scoreInfluence
              ? useAppStore.getState().newsIntel.coinSentiments[baseSym]
                  ?.scoreBoost
              : undefined

          const { signal, triggered } = analyzeSymbol({
            internalSymbol: symbol,
            ohlcv4h,
            ohlcv1h,
            ohlcv15m,
            priceChange24h: tickerMap.get(symbol) ?? 0,
            dailyBias,
            btcTrend,
            newsSentimentBoost: newsBoost,
          })

          // Respect cooldown for triggered setups (still show soft rows)
          if (triggered && !onCooldown) {
            cooldownRef.current[symbol] = Date.now()
            logger.info(`Signal ${signal.direction} ${symbol} score=${signal.score}`)
          } else if (triggered && onCooldown) {
            signal.hasActiveSetup = false
          }

          results.push(signal)

          updateTicker({
            symbol: signal.symbol,
            price: signal.price,
            priceChange24h: signal.priceChange24h,
            volume24h: 0,
            high24h: signal.price,
            low24h: signal.price,
            timestamp: Date.now(),
          })
        } catch (err) {
          logger.warn(`Scan error ${symbol}`, err)
        }
      }

      // Sort: active setups first, then by probability
      results.sort((a, b) => {
        if (a.hasActiveSetup !== b.hasActiveSetup) return a.hasActiveSetup ? -1 : 1
        return b.probabilityPct - a.probabilityPct
      })

      updateSignals(results)
      setMarketContext({
        ...ctxBase,
        lastScanAt: Date.now(),
        scanProgress: `Готово — ${results.filter((r) => r.hasActiveSetup).length} сетапов`,
      })
      setConnectionStatus('POLLING')
    } catch (err) {
      logger.error('Scan cycle failed', err)
      setConnectionStatus('OFFLINE')
    } finally {
      setScanning(false)
    }
  }, [
    setScanning,
    setMarketContext,
    setConnectionStatus,
    updateSignals,
    updateTicker,
    syncWatchlist,
  ])

  useEffect(() => {
    isMountedRef.current = true
    let cancelled = false

    const boot = async () => {
      syncWatchlist()
      await refreshTickers()
      if (cancelled) return

      while (isMountedRef.current && !cancelled) {
        await runScanCycle()
        if (cancelled || !isMountedRef.current) break
        for (let s = 0; s < SCAN_PAUSE_MS / 1000; s++) {
          if (!isMountedRef.current || cancelled) break
          await sleep(1000)
        }
      }
    }

    boot()

    const tickerInterval = setInterval(() => {
      if (isMountedRef.current) {
        syncWatchlist()
        refreshTickers()
      }
    }, TICKER_POLL_MS)

    // When user adds a coin via search — include it ASAP on next ticker poll
    const unsub = useAppStore.subscribe(
      (s) => s.extraWatchlist,
      () => {
        syncWatchlist()
      }
    )

    return () => {
      cancelled = true
      isMountedRef.current = false
      clearInterval(tickerInterval)
      unsub()
    }
  }, [refreshTickers, runScanCycle, syncWatchlist])

  return {
    isScanning: useAppStore((s) => s.isScanning),
  }
}
```

---

## 6. src/store/useAppStore.ts

```typescript
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { AppState, LiveTicker, CoinSignal, MarketContext } from '../engine/types'
import type { ChartPreferences } from '../engine/indicators/types'
import { DEFAULT_CHART_PREFERENCES } from '../engine/indicators/types'
import type { SessionSettings } from '../engine/sessions/types'
import { DEFAULT_SESSION_SETTINGS } from '../engine/sessions/types'
import type { NewsSettings } from '../engine/sentiment/types'
import {
  DEFAULT_NEWS_SETTINGS,
  EMPTY_NEWS_INTEL,
} from '../engine/sentiment/types'
import { CORE_WATCHLIST } from '../api/mexc'

const defaultMarketContext: MarketContext = {
  dailyDirection: 'BOTH',
  dailyBias: 'NEUTRAL',
  dailyConfidence: 0,
  dailyPattern: '',
  dailyDetails: '',
  dailyAnalysis: null,
  dailyLevels: null,
  btcTrend: 'RANGING',
  emaConfirms: false,
  lastScanAt: null,
  watchlistSize: CORE_WATCHLIST.length,
  scanProgress: '',
}

const EXTRA_KEY = 'enterprise_extra_watchlist'
const CHART_PREFS_KEY = 'enterprise_chart_preferences'
const SESSION_SETTINGS_KEY = 'enterprise_session_settings'
const NEWS_SETTINGS_KEY = 'enterprise_news_settings'

function loadExtraWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[]
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

function saveExtraWatchlist(list: string[]) {
  try {
    localStorage.setItem(EXTRA_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

function loadChartPreferences(): ChartPreferences {
  try {
    const raw = localStorage.getItem(CHART_PREFS_KEY)
    if (!raw) return DEFAULT_CHART_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<ChartPreferences>
    return {
      ...DEFAULT_CHART_PREFERENCES,
      ...parsed,
      indicators: {
        ...DEFAULT_CHART_PREFERENCES.indicators,
        ...(parsed.indicators ?? {}),
      },
      zones: {
        ...DEFAULT_CHART_PREFERENCES.zones,
        ...(parsed.zones ?? {}),
      },
    }
  } catch {
    return DEFAULT_CHART_PREFERENCES
  }
}

function loadSessionSettings(): SessionSettings {
  try {
    const saved = localStorage.getItem(SESSION_SETTINGS_KEY)
    return saved
      ? { ...DEFAULT_SESSION_SETTINGS, ...JSON.parse(saved) }
      : DEFAULT_SESSION_SETTINGS
  } catch {
    return DEFAULT_SESSION_SETTINGS
  }
}

function loadNewsSettings(): NewsSettings {
  try {
    const saved = localStorage.getItem(NEWS_SETTINGS_KEY)
    return saved
      ? { ...DEFAULT_NEWS_SETTINGS, ...JSON.parse(saved) }
      : DEFAULT_NEWS_SETTINGS
  } catch {
    return DEFAULT_NEWS_SETTINGS
  }
}

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    liveTickets: {},
    signals: [],
    marketContext: defaultMarketContext,
    isScanning: false,
    extraWatchlist: loadExtraWatchlist(),
    chartPreferences: loadChartPreferences(),
    sessionSettings: loadSessionSettings(),
    newsSettings: loadNewsSettings(),
    newsIntel: EMPTY_NEWS_INTEL,

    selectedCoin: null,
    isDrawerOpen: false,
    isProUser: true,
    isConnected: false,
    connectionStatus: 'OFFLINE',
    lastUpdate: Date.now(),

    updateTicker: (ticker: LiveTicker) => {
      set((state) => ({
        liveTickets: {
          ...state.liveTickets,
          [ticker.symbol]: ticker,
        },
        lastUpdate: Date.now(),
      }))
    },

    updateSignals: (signals: CoinSignal[]) => {
      set({ signals, lastUpdate: Date.now() })
    },

    upsertSignal: (signal: CoinSignal) => {
      set((state) => {
        const idx = state.signals.findIndex((s) => s.symbol === signal.symbol)
        const next =
          idx >= 0
            ? state.signals.map((s, i) => (i === idx ? signal : s))
            : [signal, ...state.signals]
        next.sort((a, b) => {
          if (a.hasActiveSetup !== b.hasActiveSetup) return a.hasActiveSetup ? -1 : 1
          return b.probabilityPct - a.probabilityPct
        })
        return { signals: next, lastUpdate: Date.now() }
      })
    },

    setMarketContext: (ctx: MarketContext | null) => {
      set({ marketContext: ctx })
    },

    setScanning: (scanning: boolean) => {
      set({ isScanning: scanning })
    },

    addToWatchlist: (internalSymbol: string) => {
      const core = new Set<string>(CORE_WATCHLIST)
      if (core.has(internalSymbol)) return false
      const current = get().extraWatchlist
      if (current.includes(internalSymbol)) return false
      const next = [...current, internalSymbol]
      saveExtraWatchlist(next)
      set({ extraWatchlist: next })
      return true
    },

    removeFromWatchlist: (internalSymbol: string) => {
      const next = get().extraWatchlist.filter((s) => s !== internalSymbol)
      saveExtraWatchlist(next)
      set({
        extraWatchlist: next,
        signals: get().signals.filter((s) => s.internalSymbol !== internalSymbol),
      })
    },

    selectCoin: (symbol: string | null) => {
      set({ selectedCoin: symbol })
    },

    setDrawerOpen: (open: boolean) => {
      set({ isDrawerOpen: open })
    },

    setProUser: (isPro: boolean) => {
      set({ isProUser: isPro })
    },

    setConnected: (connected: boolean) => {
      set({ isConnected: connected })
    },

    setConnectionStatus: (status: 'ONLINE' | 'POLLING' | 'OFFLINE') => {
      set({ connectionStatus: status, isConnected: status !== 'OFFLINE' })
    },

    setChartPreferences: (prefs) =>
      set((state) => ({
        chartPreferences: {
          ...state.chartPreferences,
          ...prefs,
          indicators: {
            ...state.chartPreferences.indicators,
            ...(prefs.indicators ?? {}),
          },
          zones: {
            ...state.chartPreferences.zones,
            ...(prefs.zones ?? {}),
          },
        },
      })),

    setSessionSettings: (partial) =>
      set((state) => {
        const next = { ...state.sessionSettings, ...partial }
        try {
          localStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return { sessionSettings: next }
      }),

    setNewsSettings: (partial) =>
      set((state) => {
        const next = { ...state.newsSettings, ...partial }
        try {
          localStorage.setItem(NEWS_SETTINGS_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return { newsSettings: next }
      }),

    setNewsIntel: (partial) =>
      set((state) => ({
        newsIntel: { ...state.newsIntel, ...partial },
      })),
  }))
)

useAppStore.subscribe(
  (state) => state.chartPreferences,
  (prefs) => {
    try {
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }
)
```

---

## 7. src/components/tactical/TacticalDrawer.tsx

```tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import ProbabilityGauge from './ProbabilityGauge'
import LiveChart from './LiveChart'
import OrderBookPanel from './OrderBookPanel'
import DataLog from './DataLog'
import NewsPanel from '../news/NewsPanel'
import FearGreedGauge from '../news/FearGreedGauge'
import type { CoinSignal } from '../../engine/types'

const TacticalDrawer = () => {
  const { t } = useTranslation()
  const { haptic } = useTelegramWebApp()
  const selectedCoin = useAppStore((state) => state.selectedCoin)
  const isDrawerOpen = useAppStore((state) => state.isDrawerOpen)
  const signals = useAppStore((state) => state.signals)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const newsSettings = useAppStore((state) => state.newsSettings)
  const newsIntel = useAppStore((state) => state.newsIntel)

  const drawerRef = useRef<HTMLDivElement>(null)

  const signal: CoinSignal | null = selectedCoin
    ? signals.find((s) => s.symbol === selectedCoin) ?? null
    : null

  useEffect(() => {
    if (isDrawerOpen && signal) {
      haptic.impact()
    }
  }, [isDrawerOpen, signal, haptic])

  const handleClose = () => {
    setDrawerOpen(false)
    selectCoin(null)
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose()
    }
  }

  if (!signal) return null

  const probability = signal.probabilityPct
  const direction = signal.direction
  const currentRSI = signal.currentRSI ?? 0

  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
      })
    }
    return price.toLocaleString('ru-RU', {
      maximumFractionDigits: 6,
      minimumFractionDigits: 2,
    })
  }

  const formatChange = (change: number): string => {
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change.toFixed(2)}%`
  }

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isDrawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleBackdropClick}
      />

      <div
        ref={drawerRef}
        className={`fixed bottom-0 left-0 right-0 w-full max-h-[85vh] bg-space border-t border-hull-border rounded-t-2xl overflow-y-auto z-50 transition-transform duration-400 ease-out ${
          isDrawerOpen
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 pointer-events-none'
        }`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="flex justify-center my-3">
          <div className="w-12 h-1 bg-hull-border rounded-full" />
        </div>

        <div className="px-4 pb-4 border-b border-hull-border/50">
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1">
              <h2 className="text-2xl font-mono font-bold text-holo mb-1">
                {signal.displayName}
              </h2>
              <div className="flex items-center gap-3 text-sm font-mono">
                <span className="text-holo/80">${formatPrice(signal.price)}</span>
                <span
                  className={signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'}
                >
                  {formatChange(signal.priceChange24h)}
                </span>
                {signal.hasActiveSetup && (
                  <span className="text-matrix text-xs uppercase">{t('signal_setup')}</span>
                )}
              </div>
            </div>
            <button
              onClick={handleClose}
              className="p-2 hover:bg-hull-light rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-holo/60" />
            </button>
          </div>
        </div>

        <div className="space-y-6 px-4 py-6">
          <div className="flex justify-center">
            <ProbabilityGauge value={probability} direction={direction} />
          </div>

          {newsSettings.enabled && newsSettings.showInDrawer && (
            <div className="space-y-3">
              {newsSettings.showFearGreed && newsIntel.fearGreed && (
                <FearGreedGauge data={newsIntel.fearGreed} />
              )}
              <NewsPanel
                coinSentiment={
                  newsIntel.coinSentiments[signal.displayName.split('/')[0]] ??
                  null
                }
                symbol={signal.displayName.split('/')[0]}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_rsi')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.currentRSI !== null ? currentRSI.toFixed(1) : '--'}
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_direction')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {direction || '--'}
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_score')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.score}/10
              </div>
            </div>

            <div className="bg-hull border border-hull-border rounded-lg p-3">
              <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                {t('tactical_trend')}
              </div>
              <div className="text-lg font-mono font-bold text-holo">
                {signal.coinTrend === 'BULLISH'
                  ? t('trend_bullish')
                  : signal.coinTrend === 'BEARISH'
                    ? t('trend_bearish')
                    : signal.coinTrend === 'RANGING'
                      ? t('trend_ranging')
                      : '--'}
              </div>
            </div>

            {signal.sl != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">SL</div>
                <div className="text-lg font-mono font-bold text-alert">
                  {formatPrice(signal.sl)}
                </div>
              </div>
            )}

            {signal.tp1 != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">TP1</div>
                <div className="text-lg font-mono font-bold text-matrix">
                  {formatPrice(signal.tp1)}
                </div>
              </div>
            )}

            {signal.tp2 != null && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">TP2</div>
                <div className="text-lg font-mono font-bold text-matrix">
                  {formatPrice(signal.tp2)}
                </div>
              </div>
            )}

            {signal.dailyBias && (
              <div className="bg-hull border border-hull-border rounded-lg p-3">
                <div className="text-xs text-holo/40 font-mono uppercase mb-1">
                  {t('tactical_daily_bias')}
                </div>
                <div className="text-sm font-mono font-bold text-holo">
                  {signal.dailyBias === 'BULLISH'
                    ? t('bias_bullish')
                    : signal.dailyBias === 'BEARISH'
                      ? t('bias_bearish')
                      : t('bias_neutral')}{' '}
                  {signal.dailyConfidence ?? ''}%
                </div>
              </div>
            )}
          </div>

          <LiveChart
            symbol={signal.internalSymbol}
            flatSymbol={signal.symbol}
            signal={signal}
          />

          <OrderBookPanel symbol={signal.internalSymbol} />

          <DataLog signal={signal} />
        </div>
      </div>
    </>
  )
}

export default TacticalDrawer
```

---

## 8. src/components/radar/RadarView.tsx

```tsx
import { Radar, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import CoinRow from './CoinRow'
import CoinSearch from './CoinSearch'
import FearGreedGauge from '../news/FearGreedGauge'

const RadarView = () => {
  const { t } = useTranslation()
  const signals = useAppStore((state) => state.signals)
  const connectionStatus = useAppStore((state) => state.connectionStatus)
  const isScanning = useAppStore((state) => state.isScanning)
  const marketContext = useAppStore((state) => state.marketContext)
  const extraWatchlist = useAppStore((state) => state.extraWatchlist)
  const newsSettings = useAppStore((state) => state.newsSettings)
  const fearGreed = useAppStore((state) => state.newsIntel.fearGreed)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)

  const handleCoinClick = (symbol: string) => {
    selectCoin(symbol)
    setDrawerOpen(true)
  }

  const getRelativeTime = (): string => {
    if (!marketContext?.lastScanAt) return ''
    try {
      const diffMs = Date.now() - marketContext.lastScanAt
      const diffMins = Math.floor(diffMs / (1000 * 60))
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
      if (diffHours > 0) return `${diffHours} ${t('time_ago_hours')}`
      if (diffMins > 0) return `${diffMins} ${t('time_ago_minutes')}`
      return `0 ${t('time_ago_minutes')}`
    } catch {
      return ''
    }
  }

  const translateBias = (bias: string) => {
    if (bias === 'BULLISH') return t('bias_bullish')
    if (bias === 'BEARISH') return t('bias_bearish')
    return t('bias_neutral')
  }

  const translateTrend = (trend: string) => {
    if (trend === 'BULLISH') return t('trend_bullish')
    if (trend === 'BEARISH') return t('trend_bearish')
    return t('trend_ranging')
  }

  const SkeletonRow = () => (
    <div className="flex items-center gap-3 border-b border-hull-border/50 px-4 py-3">
      <div className="h-4 w-6 animate-pulse rounded bg-hull-light" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-hull-light" />
        <div className="h-3 w-16 animate-pulse rounded bg-hull-light" />
      </div>
      <div className="h-6 w-16 animate-pulse rounded bg-hull-light" />
      <div className="h-2 w-20 animate-pulse rounded bg-hull-light" />
      <div className="h-4 w-4 animate-pulse rounded bg-hull-light" />
    </div>
  )

  const biasLabel = marketContext
    ? `${translateBias(marketContext.dailyBias)} ${marketContext.dailyConfidence}% · ${translateTrend(marketContext.btcTrend)}`
    : ''

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-4 pt-6">
        <div className="mb-1 flex items-center gap-2">
          <Radar className="h-5 w-5 text-matrix" />
          <h1 className="font-mono text-lg font-bold uppercase tracking-wide text-holo">
            {t('radar_title')}
          </h1>
          {isScanning && (
            <div className="pulse-dot h-2 w-2 rounded-full bg-matrix" />
          )}
        </div>
        <p className="ml-7 font-mono text-xs text-holo/40">{t('radar_subtitle')}</p>
        {biasLabel && (
          <p className="ml-7 mt-1 font-mono text-xs text-matrix/70">{biasLabel}</p>
        )}
        {marketContext?.scanProgress && (
          <p className="ml-7 mt-0.5 font-mono text-xs text-holo/30">
            {marketContext.scanProgress}
          </p>
        )}
        {newsSettings.enabled &&
          newsSettings.showFearGreed &&
          fearGreed && (
            <div className="ml-7 mt-3">
              <FearGreedGauge data={fearGreed} />
            </div>
          )}
      </div>

      <CoinSearch />

      <div className="border-b border-hull-border/30 px-4 py-2">
        <div className="flex items-center gap-3 font-mono text-xs uppercase text-holo/30">
          <div className="w-6 text-right">#</div>
          <div className="flex-1">{t('column_asset')}</div>
          <div className="w-20">{t('column_signal')}</div>
          <div className="w-32">{t('column_probability')}</div>
          <div className="w-4" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isScanning && signals.length === 0 ? (
          <div>
            {[1, 2, 3, 4].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : connectionStatus === 'OFFLINE' && signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <p className="mb-2 font-mono text-sm uppercase tracking-wider text-alert">
              {t('status_offline')}
            </p>
            <p className="max-w-xs text-center font-mono text-xs text-holo/60">
              {t('connection_unavailable')}
            </p>
          </div>
        ) : signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <div className="relative">
              <Radio className="mb-4 h-12 w-12 animate-pulse text-matrix/30" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-12 w-12 animate-ping rounded-full border-2 border-matrix/30" />
              </div>
            </div>
            <p className="font-mono text-sm uppercase tracking-wider text-holo/40">
              {t('status_scanning')}
            </p>
          </div>
        ) : (
          <div>
            {signals.map((signal, index) => (
              <CoinRow
                key={signal.symbol}
                signal={signal}
                rank={index + 1}
                onClick={() => handleCoinClick(signal.symbol)}
              />
            ))}
          </div>
        )}
      </div>

      {marketContext?.lastScanAt && (
        <div className="border-t border-hull-border/30 px-4 py-4 text-center">
          <p className="font-mono text-xs text-holo/20">
            {t('footer_data_age')} {getRelativeTime()}
          </p>
          <p className="mt-1 font-mono text-xs text-holo/20">
            {(marketContext.watchlistSize || 10) +
              (extraWatchlist.length ? ` (+${extraWatchlist.length})` : '')}{' '}
            {t('footer_pairs')}
          </p>
        </div>
      )}
    </div>
  )
}

export default RadarView
```

---

