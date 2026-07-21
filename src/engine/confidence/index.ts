import type { OhlcvCandle } from '../../api/mexc'
import type { CoinSignal, OrderBookMetrics } from '../types'
import { detectMarketStructure } from '../smc'
import {
  calculateScalpConfidence,
  calculateIntradayConfidence,
  isKillzoneActive,
} from '../strategies'
import {
  calculateDynamicInvalidation,
  evaluateTradeInvalidation,
} from './invalidation'

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
  /** SCALP | INTRADAY — какой алгоритм использован */
  tradeStyle: 'SCALP' | 'INTRADAY'
}

export function calculateConfidenceScore(
  signal: CoinSignal,
  orderBookMetrics: OrderBookMetrics | null,
  _ohlcv1m: OhlcvCandle[] | null
): ConfidenceScoreResult {
  const style = signal.tradeStyle ?? 'INTRADAY'

  if (style === 'SCALP') {
    return calculateScalpConfidenceScore(signal, orderBookMetrics)
  }
  return calculateIntradayConfidenceScore(signal, orderBookMetrics)
}

function calculateScalpConfidenceScore(
  signal: CoinSignal,
  orderBookMetrics: OrderBookMetrics | null
): ConfidenceScoreResult {
  const wallSupport = Boolean(
    orderBookMetrics?.walls.some((w) =>
      signal.direction === 'LONG' ? w.side === 'BID' : w.side === 'ASK'
    )
  )

  const sc = calculateScalpConfidence({
    freshSweep:
      !!signal.raid && signal.raid.type !== 'NONE' && signal.raid.isFresh,
    absorption: !!signal.absorption?.detected,
    tapeBurst: !!signal.buyerAggression?.detected,
    cvdDivergence:
      !!signal.cvdDivergence?.detected &&
      ((signal.direction === 'LONG' &&
        signal.cvdDivergence.type === 'BULLISH') ||
        (signal.direction === 'SHORT' &&
          signal.cvdDivergence.type === 'BEARISH')),
    chochOrMss: !!(signal.ltfChoCH?.detected || signal.mss?.detected),
    wallSupport,
    liquidationSwept: !!(
      signal.liquidationContext?.swept && signal.liquidationContext.fresh
    ),
  })

  const factors: ConfidenceFactor[] = [
    {
      name: 'Liquidity Sweep',
      weight: 22,
      score: signal.raid?.isFresh ? 1 : 0,
      passed: !!signal.raid?.isFresh,
      reason: signal.raid?.label || 'Нет свежего sweep',
      emoji: '🔄',
    },
    {
      name: 'Order Flow',
      weight: 34,
      score:
        (signal.absorption?.detected ? 0.5 : 0) +
        (signal.buyerAggression?.detected ? 0.5 : 0),
      passed: !!(
        signal.absorption?.detected || signal.buyerAggression?.detected
      ),
      reason:
        sc.factors
          .filter((f) => ['Absorption', 'Tape Momentum'].includes(f))
          .join(' + ') || 'Нет аномалии ленты',
      emoji: '⚡',
    },
    {
      name: 'CVD / Структура',
      weight: 26,
      score:
        (signal.cvdDivergence?.detected ? 0.5 : 0) +
        (signal.ltfChoCH?.detected || signal.mss?.detected ? 0.5 : 0),
      passed: !!(
        signal.cvdDivergence?.detected ||
        signal.ltfChoCH?.detected ||
        signal.mss?.detected
      ),
      reason:
        sc.factors
          .filter((f) => ['CVD Divergence', 'LTF Structure'].includes(f))
          .join(' + ') || 'Нет LTF подтверждения',
      emoji: 'Δ',
    },
    {
      name: 'Liq Cluster',
      weight: 18,
      score: signal.liquidationContext?.swept ? 1 : 0,
      passed: !!signal.liquidationContext?.swept,
      reason: signal.liquidationContext?.label || 'Пул не снят',
      emoji: '💥',
    },
  ]

  const totalScore =
    signal.styleConfidence ??
    Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0))
  const passedFactors = factors.filter((f) => f.passed).length
  const approved = totalScore >= 70 && passedFactors >= 2

  return {
    totalScore: Math.min(totalScore, 98),
    factors,
    quality: sc.quality,
    passedFactors,
    approved,
    tradeStyle: 'SCALP',
    recommendation:
      totalScore >= 88
        ? `⚡️ SCALP ELITE ${totalScore}%. Микро-вход, стоп за свип.`
        : approved
          ? `⚡️ SCALP ${totalScore}%. Сетап допустим на M1/M5.`
          : `⚡️ SCALP ${totalScore}%. Недостаточно order-flow confluence.`,
  }
}

function calculateIntradayConfidenceScore(
  signal: CoinSignal,
  orderBookMetrics: OrderBookMetrics | null
): ConfidenceScoreResult {
  const kz = isKillzoneActive()
  const dailyAligned =
    (signal.direction === 'LONG' && signal.dailyBias === 'BULLISH') ||
    (signal.direction === 'SHORT' && signal.dailyBias === 'BEARISH')
  const h4Aligned =
    (signal.direction === 'LONG' && signal.coinTrend === 'BULLISH') ||
    (signal.direction === 'SHORT' && signal.coinTrend === 'BEARISH')
  const inOb = signal.zones.some((z) => z.includes('OB'))

  const ic = calculateIntradayConfidence({
    dailyBiasAligned: dailyAligned,
    h4TrendAligned: h4Aligned,
    ltfChoCH: !!(signal.ltfChoCH?.detected || signal.mss?.detected),
    killzoneActive: kz.active,
    inHtfOrderBlock: inOb,
    oteInZone: !!signal.ote?.priceInZone,
    pocConfluence: !!signal.volumeProfile?.obPocConfluence,
    liquidationSwept: !!signal.liquidationContext?.swept,
  })

  const factors: ConfidenceFactor[] = [
    {
      name: 'HTF Bias',
      weight: 30,
      score: (dailyAligned ? 0.5 : 0) + (h4Aligned ? 0.5 : 0),
      passed: dailyAligned && h4Aligned,
      reason:
        [dailyAligned && 'Daily', h4Aligned && '4H'].filter(Boolean).join(' + ') ||
        'Нет HTF alignment',
      emoji: '🌍',
    },
    {
      name: 'Структура / CHoCH',
      weight: 25,
      score:
        (signal.ltfChoCH?.detected || signal.mss?.detected ? 0.6 : 0) +
        (signal.ote?.priceInZone ? 0.4 : 0),
      passed: !!(signal.ltfChoCH?.detected || signal.mss?.detected),
      reason:
        ic.factors
          .filter((f) => f.includes('CHoCH') || f.includes('OTE'))
          .join(' + ') || 'Нет смены характера',
      emoji: '📊',
    },
    {
      name: 'Killzone + OB/POC',
      weight: 25,
      score:
        (kz.active ? 0.4 : 0) +
        (inOb ? 0.3 : 0) +
        (signal.volumeProfile?.obPocConfluence ? 0.3 : 0),
      passed: kz.active || inOb || !!signal.volumeProfile?.obPocConfluence,
      reason:
        ic.factors
          .filter(
            (f) =>
              f.includes('Killzone') || f.includes('OB') || f.includes('POC')
          )
          .join(' + ') || 'Вне сессии / без зоны',
      emoji: '🎯',
    },
    {
      name: 'Liq Sweep Gate',
      weight: 20,
      score: signal.liquidationContext?.swept
        ? 1
        : signal.liquidationContext?.gateOpen
          ? 0.4
          : 0,
      passed: !!signal.liquidationContext?.gateOpen,
      reason: signal.liquidationContext?.label || 'Нет liq-контекста',
      emoji: '💥',
    },
  ]

  void orderBookMetrics

  const totalScore =
    signal.styleConfidence ??
    Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0))
  const passedFactors = factors.filter((f) => f.passed).length
  const approved = totalScore >= 70 && passedFactors >= 3

  return {
    totalScore: Math.min(totalScore, 98),
    factors,
    quality: ic.quality,
    passedFactors,
    approved,
    tradeStyle: 'INTRADAY',
    recommendation:
      totalScore >= 88
        ? `🎯 INTRADAY ELITE ${totalScore}%. Каскадные TP, стоп за структуру.`
        : approved
          ? `🎯 INTRADAY ${totalScore}%. Сетап допустим на H1/15m.`
          : `🎯 INTRADAY ${totalScore}%. Недостаточно HTF confluence.`,
  }
}

export function isTradeInvalidated(
  ohlcv1m: OhlcvCandle[],
  direction: 'LONG' | 'SHORT',
  _entryPrice: number
): { invalidated: boolean; reason: string; invalidationPrice?: number } {
  const inv = calculateDynamicInvalidation(ohlcv1m, direction, '1m')
  if (inv?.breached) {
    return {
      invalidated: true,
      reason: inv.message,
      invalidationPrice: inv.price,
    }
  }

  if (ohlcv1m.length < 10) {
    return { invalidated: false, reason: '' }
  }

  const structure = detectMarketStructure(ohlcv1m, 10)
  const currentPrice = ohlcv1m[ohlcv1m.length - 1][4]

  if (direction === 'LONG') {
    const lastSwingLow = structure.lastSwingLow
    if (
      lastSwingLow &&
      currentPrice < lastSwingLow &&
      structure.trend === 'BEARISH'
    ) {
      return {
        invalidated: true,
        reason:
          'Паттерн сломан (Structure Shift M1). Вероятность отработки упала до 20%. Закрывай руками или переводи в BE, не жди удара в Stop Loss!',
        invalidationPrice: lastSwingLow,
      }
    }
  }

  if (direction === 'SHORT') {
    const lastSwingHigh = structure.lastSwingHigh
    if (
      lastSwingHigh &&
      currentPrice > lastSwingHigh &&
      structure.trend === 'BULLISH'
    ) {
      return {
        invalidated: true,
        reason:
          'Паттерн сломан (Structure Shift M1). Вероятность отработки упала до 20%. Закрывай руками или переводи в BE, не жди удара в Stop Loss!',
        invalidationPrice: lastSwingHigh,
      }
    }
  }

  return { invalidated: false, reason: '' }
}

export { calculateDynamicInvalidation, evaluateTradeInvalidation }
