import type { OhlcvCandle } from '../../api/mexc'
import type { CoinSignal, OrderBookMetrics } from '../types'
import { detectMarketStructure } from '../smc'

export interface ConfidenceFactor {
  name: string
  weight: number
  score: number
  passed: boolean
  reason: string
  emoji: string
}

export interface ConfidenceScoreResult {
  totalScore: number
  factors: ConfidenceFactor[]
  quality: 'ELITE' | 'STRONG' | 'WEAK'
  passedFactors: number
  approved: boolean
  recommendation: string
}

export function calculateConfidenceScore(
  signal: CoinSignal,
  orderBookMetrics: OrderBookMetrics | null,
  _ohlcv1m: OhlcvCandle[] | null
): ConfidenceScoreResult {
  const factors: ConfidenceFactor[] = []

  let htfScore = 0
  const htfReasons: string[] = []

  if (signal.direction === 'LONG' && signal.dailyBias === 'BULLISH') {
    htfScore += 0.33
    htfReasons.push('Дневной бычий')
  } else if (signal.direction === 'SHORT' && signal.dailyBias === 'BEARISH') {
    htfScore += 0.33
    htfReasons.push('Дневной медвежий')
  }

  if (signal.direction === 'LONG' && signal.btcTrend === 'BULLISH') {
    htfScore += 0.33
    htfReasons.push('BTC бычий')
  } else if (signal.direction === 'SHORT' && signal.btcTrend === 'BEARISH') {
    htfScore += 0.33
    htfReasons.push('BTC медвежий')
  }

  if (signal.direction === 'LONG' && signal.coinTrend === 'BULLISH') {
    htfScore += 0.34
    htfReasons.push('Монета бычья')
  } else if (signal.direction === 'SHORT' && signal.coinTrend === 'BEARISH') {
    htfScore += 0.34
    htfReasons.push('Монета медвежья')
  }

  factors.push({
    name: 'Контекст HTF',
    weight: 30,
    score: htfScore,
    passed: htfScore >= 0.66,
    reason: htfReasons.join(' + ') || 'Слабое совпадение',
    emoji: '🌍',
  })

  let ltfScore = 0
  const ltfReasons: string[] = []

  if (signal.mss?.detected) {
    ltfScore += 0.33
    ltfReasons.push('MSS')
  }

  if (signal.ltfChoCH?.detected) {
    ltfScore += 0.33
    ltfReasons.push('CHoCH')
    if (signal.ltfChoCH.surgicalEntryDetected) {
      ltfScore += 0.17
      ltfReasons.push('Точный вход')
    }
  }

  if (signal.raid && signal.raid.type !== 'NONE' && signal.raid.isFresh) {
    ltfScore += 0.33
    ltfReasons.push('Raid')
  }

  if (signal.ote?.priceInZone) {
    ltfScore += 0.17
    ltfReasons.push('OTE')
  }

  ltfScore = Math.min(ltfScore, 1.0)

  factors.push({
    name: 'Смена структуры LTF',
    weight: 30,
    score: ltfScore,
    passed: ltfScore >= 0.5,
    reason: ltfReasons.join(' + ') || 'Нет смены структуры',
    emoji: '📊',
  })

  let volumeScore = 0
  const volumeReasons: string[] = []

  if (signal.absorption?.detected) {
    volumeScore += 0.5
    volumeReasons.push(
      `Поглощение ×${signal.absorption.volumeMultiplier.toFixed(1)}`
    )
  }

  if (signal.buyerAggression?.detected && signal.direction === 'LONG') {
    volumeScore += 0.5
    volumeReasons.push(
      `Агрессия ×${signal.buyerAggression.buyToSellRatio.toFixed(1)}`
    )
  }

  factors.push({
    name: 'Подтверждение объёма',
    weight: 20,
    score: volumeScore,
    passed: volumeScore >= 0.5,
    reason: volumeReasons.join(' + ') || 'Нет всплеска объёма',
    emoji: '📈',
  })

  let wallScore = 0
  const wallReasons: string[] = []

  if (orderBookMetrics && orderBookMetrics.walls.length > 0) {
    const relevantWalls = orderBookMetrics.walls.filter((wall) => {
      if (signal.direction === 'LONG') return wall.side === 'BID'
      return wall.side === 'ASK'
    })

    if (relevantWalls.length > 0) {
      const strongestWall = relevantWalls[0]
      wallScore = 0.5
      if (strongestWall.ratio >= 3) {
        wallScore = 1.0
      }
      wallReasons.push(
        `Стенка ${strongestWall.side} ×${strongestWall.ratio.toFixed(1)}`
      )
    }
  }

  if (!wallReasons.length) {
    wallReasons.push('Нет значимых стенок')
  }

  factors.push({
    name: 'Стенка в стакане',
    weight: 20,
    score: wallScore,
    passed: wallScore >= 0.5,
    reason: wallReasons.join(' + '),
    emoji: '🧱',
  })

  const totalScore = Math.round(
    factors.reduce((sum, f) => sum + f.score * f.weight, 0)
  )

  const passedFactors = factors.filter((f) => f.passed).length
  const approved = totalScore >= 70 && passedFactors >= 3

  let quality: ConfidenceScoreResult['quality'] = 'WEAK'
  let recommendation = ''

  if (totalScore >= 85) {
    quality = 'ELITE'
    recommendation = `Сделка одобрена на ${totalScore}%. Все факторы синхронизированы. ВХОДИ!`
  } else if (totalScore >= 70) {
    quality = 'STRONG'
    recommendation = `Уверенность ${totalScore}%. ${passedFactors}/4 факторов подтверждены. Сделка допустима.`
  } else {
    quality = 'WEAK'
    recommendation = `Уверенность ${totalScore}%. Мусорный сигнал — пропустить.`
  }

  return {
    totalScore,
    factors,
    quality,
    passedFactors,
    approved,
    recommendation,
  }
}

export function isTradeInvalidated(
  ohlcv1m: OhlcvCandle[],
  direction: 'LONG' | 'SHORT',
  _entryPrice: number
): { invalidated: boolean; reason: string } {
  if (ohlcv1m.length < 10) {
    return { invalidated: false, reason: '' }
  }

  const structure = detectMarketStructure(ohlcv1m, 10)

  if (direction === 'LONG') {
    const currentPrice = ohlcv1m[ohlcv1m.length - 1][4]
    const lastSwingLow = structure.lastSwingLow

    if (
      lastSwingLow &&
      currentPrice < lastSwingLow &&
      structure.trend === 'BEARISH'
    ) {
      return {
        invalidated: true,
        reason: `Структура сломана. Новый нижний минимум: ${lastSwingLow.toFixed(4)}. Инициатива у продавцов.`,
      }
    }
  }

  if (direction === 'SHORT') {
    const currentPrice = ohlcv1m[ohlcv1m.length - 1][4]
    const lastSwingHigh = structure.lastSwingHigh

    if (
      lastSwingHigh &&
      currentPrice > lastSwingHigh &&
      structure.trend === 'BULLISH'
    ) {
      return {
        invalidated: true,
        reason: `Структура сломана. Новый верхний максимум: ${lastSwingHigh.toFixed(4)}. Инициатива у покупателей.`,
      }
    }
  }

  return { invalidated: false, reason: '' }
}
