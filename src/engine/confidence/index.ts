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
  calculateHtfInvalidation,
  evaluateTradeInvalidation,
  evaluateFullInvalidation,
  pickInvalidationForDisplay,
} from './invalidation'
import {
  aggressionPctFromRatio,
  applyBtcDumpPenalty,
  detectBtcDump,
  detectEffortVsResult,
  evaluateTripleFilter,
  mergeMmGates,
  priceChangePctOver,
  type BtcDumpResult,
  type WeightedObiResult,
} from '../mm'

export interface ConfidenceFactor {
  name: string
  weight: number
  score: number
  passed: boolean
  reason: string
  emoji: string
}

export type MmGateStatus =
  | 'ABSORPTION_TRAP'
  | 'MM_DISTRIBUTION'
  | 'TRIPLE_CONFIRMED'
  | 'BTC_DUMP'
  | 'NO_LIQUIDITY_RAID'
  | ''

export interface ConfidenceScoreResult {
  totalScore: number
  factors: ConfidenceFactor[]
  quality: 'ELITE' | 'STRONG' | 'WEAK'
  passedFactors: number
  approved: boolean
  recommendation: string
  /** SCALP | INTRADAY | SWING — какой алгоритм использован */
  tradeStyle: 'SCALP' | 'INTRADAY' | 'SWING'
  /** MM / Effort-vs-Result gate status for UI */
  mmStatus?: MmGateStatus
}

export interface ConfidenceExtras {
  /** 1m OHLCV for price-result / effort filters */
  ohlcv1m?: OhlcvCandle[] | null
  /** BTC 1m for dump penalty on meme longs */
  btcOhlcv1m?: OhlcvCandle[] | null
  /** Weighted near-touch OBI */
  weightedObi?: WeightedObiResult | null
  /** Treat signal as meme (memePulse or explicit) */
  isMeme?: boolean
}

export function calculateConfidenceScore(
  signal: CoinSignal,
  orderBookMetrics: OrderBookMetrics | null,
  ohlcv1m: OhlcvCandle[] | null,
  extras?: ConfidenceExtras
): ConfidenceScoreResult {
  const style = signal.tradeStyle ?? 'INTRADAY'
  const candles = extras?.ohlcv1m ?? ohlcv1m

  let base: ConfidenceScoreResult
  if (style === 'SCALP') {
    base = calculateScalpConfidenceScore(signal, orderBookMetrics)
  } else if (style === 'SWING') {
    const intraday = calculateIntradayConfidenceScore(signal, orderBookMetrics)
    const fibBoost =
      signal.globalFib?.inReactionZone &&
      signal.globalFib.entryBias === signal.direction
        ? signal.globalFib.activeLabel?.includes('141')
          ? 6
          : 3
        : 0
    const totalScore = Math.min(intraday.totalScore + fibBoost, 98)
    base = {
      ...intraday,
      totalScore,
      tradeStyle: 'SWING',
      recommendation:
        totalScore >= 88
          ? `🕯 SWING ELITE ${totalScore}%. Fib/HTF структура, держим дни.`
          : totalScore >= 70
            ? `🕯 SWING ${totalScore}%. Сетап на 4H–1D.`
            : `🕯 SWING ${totalScore}%. Ждём подтверждение у зоны.`,
    }
  } else {
    base = calculateIntradayConfidenceScore(signal, orderBookMetrics)
  }

  return applyMarketMakerGates(signal, base, orderBookMetrics, candles, extras)
}

function applyMarketMakerGates(
  signal: CoinSignal,
  base: ConfidenceScoreResult,
  orderBookMetrics: OrderBookMetrics | null,
  ohlcv1m: OhlcvCandle[] | null,
  extras?: ConfidenceExtras
): ConfidenceScoreResult {
  const isMeme = extras?.isMeme ?? !!signal.memePulse
  const direction = signal.direction
  let totalScore = base.totalScore
  let approved = base.approved
  let recommendation = base.recommendation
  let mmStatus: MmGateStatus = ''
  const factors = [...base.factors]

  // ── Liquidity Raid gate (memes: mandatory SMC sweep, except elite setups) ─
  if (isMeme && direction) {
    const eliteMeme =
      !!signal.memePulse?.squeeze?.setup ||
      !!signal.memePulse?.squeeze?.inProgress ||
      !!signal.memePulse?.flatline?.detected ||
      !!signal.memePulse?.cvdTrap?.detected ||
      !!signal.memePulse?.backside?.detected
    const hasFreshRaid =
      !!signal.raid &&
      signal.raid.type !== 'NONE' &&
      signal.raid.isFresh
    factors.push({
      name: 'Liquidity Sweep (SMC Raid)',
      weight: 0,
      score: hasFreshRaid || eliteMeme ? 1 : 0,
      passed: hasFreshRaid || eliteMeme,
      reason: hasFreshRaid
        ? signal.raid!.label
        : eliteMeme
          ? 'Элитный мем-сетап (свой триггер входа)'
          : 'Нет 2-го захода / sweep — на мемах вход только после снятия стопов',
      emoji: '🔄',
    })
    if (!eliteMeme && !hasFreshRaid) {
      approved = false
      mmStatus = 'NO_LIQUIDITY_RAID'
      totalScore = Math.min(totalScore, 45)
      recommendation =
        '🔄 Liquidity Raid обязателен для мемов. Ждём sweep лоя и резкий возврат — не входим на первом касании.'
    }
  }

  // ── Effort vs Result + Triple Filter ──────────────────────────────────
  if (direction) {
    const aggr = signal.buyerAggression
    const spread = signal.memePulse?.spreadPressure
    let buyerPct = 50
    let sellerPct = 50

    if (aggr && (aggr.buyVolume > 0 || aggr.sellVolume > 0)) {
      const total = aggr.buyVolume + aggr.sellVolume
      buyerPct = (aggr.buyVolume / total) * 100
      sellerPct = 100 - buyerPct
    } else if (spread) {
      const fromRatio = aggressionPctFromRatio(spread.buyToSellRatio)
      buyerPct = fromRatio.buyerPct
      sellerPct = fromRatio.sellerPct
    } else if (aggr) {
      const fromRatio = aggressionPctFromRatio(aggr.buyToSellRatio)
      buyerPct = fromRatio.buyerPct
      sellerPct = fromRatio.sellerPct
    }

    const pxChange =
      ohlcv1m && ohlcv1m.length >= 6
        ? priceChangePctOver(ohlcv1m, 5)
        : (signal.memePulse?.volumeSpike?.priceChangePct ??
          signal.memePulse?.meanReversion?.deviationPct ??
          0)

    // Only run hard gates when we have aggression data
    const hasFlowData = !!(aggr || spread)
    if (hasFlowData) {
      const effort = detectEffortVsResult({
        direction,
        buyerAggressionPct: buyerPct,
        sellerAggressionPct: sellerPct,
        priceChangePct: pxChange,
        imbalance: orderBookMetrics?.imbalance ?? null,
      })

      const aggressionAligned =
        direction === 'LONG'
          ? buyerPct >= 80 || !!aggr?.detected || spread?.pressure === 'BUYERS'
          : sellerPct >= 80 || spread?.pressure === 'SELLERS'

      const obi = extras?.weightedObi ?? null
      const obiAligned =
        obi != null
          ? direction === 'LONG'
            ? obi.nearTouchPressure === 'BUY'
            : obi.nearTouchPressure === 'SELL'
          : orderBookMetrics != null
            ? direction === 'LONG'
              ? orderBookMetrics.imbalance > 20
              : orderBookMetrics.imbalance < -20
            : false

      const priceResultOk =
        direction === 'LONG' ? pxChange >= 0.5 : pxChange <= -0.5

      const triple = evaluateTripleFilter({
        direction,
        aggressionAligned,
        obiAligned,
        priceResultOk,
        buyerAggressionPct: buyerPct,
      })

      const gate = mergeMmGates(effort, triple, obi)

      if (gate.blocked && gate.scoreOverride != null) {
        totalScore = gate.scoreOverride
        approved = false
        mmStatus =
          effort.status === 'ABSORPTION_TRAP'
            ? 'ABSORPTION_TRAP'
            : 'MM_DISTRIBUTION'
        recommendation = gate.recommendation
        factors.push({
          name: gate.status || 'Effort vs Result',
          weight: 0,
          score: 0,
          passed: false,
          reason: gate.recommendation,
          emoji: '⚠️',
        })
      } else if (triple.passed) {
        mmStatus = 'TRIPLE_CONFIRMED'
        factors.push({
          name: 'Triple Filter',
          weight: 0,
          score: 1,
          passed: true,
          reason: triple.reason,
          emoji: '🎯',
        })
      } else if (aggressionAligned && !priceResultOk) {
        factors.push({
          name: 'Effort vs Result',
          weight: 0,
          score: 0.2,
          passed: false,
          reason: 'Агрессия есть, цена не подтверждает — осторожно',
          emoji: '⚖️',
        })
      }
    }

    // Distribution from meme absorption alert
    if (
      signal.memePulse?.absorptionAlert?.type === 'DISTRIBUTION' &&
      direction === 'LONG'
    ) {
      totalScore = 10
      approved = false
      mmStatus = 'MM_DISTRIBUTION'
      recommendation =
        signal.memePulse.absorptionAlert.alert ??
        '⚠️ ABSORPTION / DISTRIBUTION — лонг аннулирован'
    }
  }

  // ── BTC dump penalty (meme longs) ─────────────────────────────────────
  let dump: BtcDumpResult | null = null
  if (extras?.btcOhlcv1m?.length) {
    dump = detectBtcDump(extras.btcOhlcv1m)
    const penalized = applyBtcDumpPenalty(totalScore, direction, isMeme, dump)
    if (penalized.applied) {
      totalScore = penalized.score
      mmStatus = mmStatus || 'BTC_DUMP'
      if (totalScore < 70) approved = false
      recommendation = `📉 ${penalized.label} | Score → ${totalScore}%`
      factors.push({
        name: 'BTC Correlation',
        weight: 0,
        score: 0,
        passed: false,
        reason: penalized.label,
        emoji: '📉',
      })
    }
  }

  const passedFactors = factors.filter((f) => f.passed).length
  const quality: ConfidenceScoreResult['quality'] =
    totalScore >= 88 ? 'ELITE' : totalScore >= 70 ? 'STRONG' : 'WEAK'

  return {
    ...base,
    totalScore: Math.min(Math.max(totalScore, 0), 98),
    factors,
    quality,
    passedFactors,
    approved,
    recommendation,
    mmStatus,
  }
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

  // Use order book pressure as soft factor when available
  if (orderBookMetrics) {
    const aligned =
      (signal.direction === 'LONG' && orderBookMetrics.pressure === 'BUYERS') ||
      (signal.direction === 'SHORT' && orderBookMetrics.pressure === 'SELLERS')
    factors.push({
      name: 'Order Book',
      weight: 0,
      score: aligned ? 1 : 0,
      passed: aligned,
      reason: aligned
        ? `Давление стакана: ${orderBookMetrics.pressure}`
        : `Стакан: ${orderBookMetrics.pressure} (imbalance ${orderBookMetrics.imbalance.toFixed(0)}%)`,
      emoji: '📚',
    })
  }

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

export {
  calculateDynamicInvalidation,
  calculateHtfInvalidation,
  evaluateTradeInvalidation,
  evaluateFullInvalidation,
  pickInvalidationForDisplay,
}
