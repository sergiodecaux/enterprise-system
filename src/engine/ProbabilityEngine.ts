/**
 * ProbabilityEngine — maps SniperBot SMC confluence weights to probability %.
 * Replaces historical system_core.json RSI-bucket lookups.
 * Orchestrates SCALP vs INTRADAY profiles, VPVR, liquidation gate, CVD.
 */
import type { OhlcvCandle } from '../api/mexc'
import type {
  AbsorptionCandle,
  BtcDivergenceResult,
  CoinSignal,
  LiquidityMap,
  LiquidityRaidResult,
  LTFChoCHResult,
  MSSResult,
  OTESniperZone,
  WallTrackerState,
} from './types'
import {
  calculateBtcDivergence,
  calculateConfluence,
  calculateFibonacciLevels,
  calculateOTEZone,
  calculateRsi,
  calculateAtr,
  checkCandleRejection,
  detectAbsorptionCandle,
  detectLiquidityRaid,
  detectLTFChoCH,
  detectMarketStructure,
  detectMSS,
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
import {
  classifyTradeStyle,
  calculateScalpConfidence,
  calculateIntradayConfidence,
  buildScalpLevels,
  buildIntradayLevels,
  isKillzoneActive,
} from './strategies'
import {
  calculateVolumeProfile,
  applyObPocConfluence,
} from './volumeProfile'
import {
  buildLiquidationClusters,
  evaluateLiquidationGate,
} from './derivatives'
import { detectCvdDivergence } from './orderflow'
import { calculateDynamicInvalidation } from './confidence/invalidation'
import { buildGhostPath } from './prediction/ghostPath'

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
  /** Опциональная карта ликвидности для score-буста */
  liquidityMap?: LiquidityMap
  /**
   * 1H свечи BTC для расчёта дивергенции силы.
   * Передаётся из scanner где BTC OHLCV уже загружен.
   */
  btcOhlcv1h?: OhlcvCandle[]
  /** 1m или 5m свечи для LTF MSS детекции */
  ohlcv5m?: OhlcvCandle[]
  /** 1m свечи для LTF CHoCH детекции */
  ohlcv1m?: OhlcvCandle[]
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
    btcDivergence: null,
    mss: null,
    raid: null,
    ote: null,
    absorption: null,
    ltfChoCH: null,
    buyerAggression: null,
    tradeStyle: null,
    styleReasons: [],
    styleConfidence: null,
    volumeProfile: null,
    liquidationContext: null,
    cvdDivergence: null,
    invalidationPrice: null,
    invalidationMessage: null,
    ghostPathWarning: null,
    unrealisticTp: false,
  }
}

/**
 * Обогащает сигнал: VPVR, ликвидации, CVD, стиль, confidence, ghost path, invalidation.
 */
function enrichSignal(
  signal: CoinSignal,
  ctx: {
    ohlcv1h: OhlcvCandle[]
    ohlcv15m: OhlcvCandle[]
    ohlcv5m?: OhlcvCandle[]
    ohlcv1m?: OhlcvCandle[]
    liquidityMap?: LiquidityMap
    tapeBurst?: boolean
    wallSupport?: boolean
    bestZoneTop?: number | null
    bestZoneBottom?: number | null
  }
): CoinSignal {
  if (!signal.direction) return signal

  const atr =
    calculateAtr(ctx.ohlcv1h, 14) ?? signal.price * 0.005
  const dailyAtr =
    calculateAtr(ctx.ohlcv1h.slice(-24), 14) ?? atr
  const dailyAtrPct = (dailyAtr / signal.price) * 100

  // VPVR
  let vpRaw = calculateVolumeProfile(ctx.ohlcv1h, 48, true)
  if (vpRaw && ctx.bestZoneTop != null && ctx.bestZoneBottom != null) {
    vpRaw = applyObPocConfluence(vpRaw, ctx.bestZoneTop, ctx.bestZoneBottom)
  }
  const volumeProfile = vpRaw
    ? {
        poc: vpRaw.poc,
        vah: vpRaw.vah,
        val: vpRaw.val,
        obPocConfluence: vpRaw.obPocConfluence,
        confluenceLabel: vpRaw.confluenceLabel,
        scoreBoost: vpRaw.scoreBoost,
      }
    : null

  // CVD
  const cvdSrc = ctx.ohlcv5m?.length ? ctx.ohlcv5m : ctx.ohlcv15m
  const cvd = detectCvdDivergence(cvdSrc, 20)
  const cvdDivergence =
    cvd.detected
      ? {
          detected: true,
          type: cvd.type,
          scoreBoost: cvd.scoreBoost,
          label: cvd.label,
        }
      : null

  // Liquidation clusters + gate
  const clusters = buildLiquidationClusters(
    ctx.liquidityMap,
    signal.price,
    ctx.ohlcv1h
  )
  const liq = evaluateLiquidationGate(
    clusters,
    signal.direction,
    signal.price,
    signal.raid
  )
  const liquidationContext = {
    swept: liq.swept,
    fresh: liq.fresh,
    gateOpen: liq.gateOpen,
    scoreBoost: liq.scoreBoost,
    label: liq.label,
    blockingPrice: liq.blockingCluster?.price ?? null,
    clusterCount: clusters.length,
  }

  let score = signal.score
  const zones = [...signal.zones]

  if (volumeProfile?.obPocConfluence) {
    score = Math.min(score + volumeProfile.scoreBoost, 10)
    zones.push(`VPVR: ${volumeProfile.confluenceLabel}`)
  }
  if (cvdDivergence?.detected) {
    const aligned =
      (signal.direction === 'LONG' && cvdDivergence.type === 'BULLISH') ||
      (signal.direction === 'SHORT' && cvdDivergence.type === 'BEARISH')
    if (aligned) {
      score = Math.min(score + cvdDivergence.scoreBoost, 10)
      zones.push(`CVD: ${cvdDivergence.label}`)
    }
  }
  if (liq.scoreBoost > 0) {
    score = Math.min(score + liq.scoreBoost, 10)
    zones.push(`LIQ: ${liq.label}`)
  }

  // Partial enrich for classification
  let enriched: CoinSignal = {
    ...signal,
    score,
    zones,
    probabilityPct: scoreToProbability(score),
    volumeProfile,
    liquidationContext,
    cvdDivergence,
  }

  const classification = classifyTradeStyle(enriched)
  const style = classification.style
  const kz = isKillzoneActive()

  // Style-specific risk model (пересчёт SL/TP если есть уровни)
  if (enriched.hasActiveSetup && enriched.sl != null && enriched.tp1 != null) {
    if (style === 'SCALP') {
      const levels = buildScalpLevels(
        signal.direction,
        signal.ltfChoCH?.surgicalEntryPrice ?? signal.price,
        signal.raid?.sweptLevel ?? null,
        volumeProfile?.vah && signal.direction === 'LONG'
          ? volumeProfile.vah
          : volumeProfile?.val && signal.direction === 'SHORT'
            ? volumeProfile.val
            : null,
        atr
      )
      enriched = {
        ...enriched,
        sl: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
      }
    } else {
      const levels = buildIntradayLevels(
        signal.direction,
        signal.price,
        signal.direction === 'LONG'
          ? ctx.bestZoneBottom ?? null
          : ctx.bestZoneTop ?? null,
        null,
        enriched.tpDaily,
        atr
      )
      enriched = {
        ...enriched,
        sl: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        tpDaily: levels.tpDaily ?? enriched.tpDaily,
      }
    }
  }

  // Style confidence
  let styleConfidence = 0
  let styleFactors: string[] = []

  if (style === 'SCALP') {
    const sc = calculateScalpConfidence({
      freshSweep:
        !!signal.raid &&
        signal.raid.type !== 'NONE' &&
        signal.raid.isFresh,
      absorption: !!signal.absorption?.detected,
      tapeBurst: !!ctx.tapeBurst || !!signal.buyerAggression?.detected,
      cvdDivergence:
        !!cvdDivergence?.detected &&
        ((signal.direction === 'LONG' && cvdDivergence.type === 'BULLISH') ||
          (signal.direction === 'SHORT' && cvdDivergence.type === 'BEARISH')),
      chochOrMss: !!(signal.ltfChoCH?.detected || signal.mss?.detected),
      wallSupport: !!ctx.wallSupport,
      liquidationSwept: liq.swept && liq.fresh,
    })
    styleConfidence = sc.score
    styleFactors = sc.factors
  } else {
    const dailyAligned =
      (signal.direction === 'LONG' && signal.dailyBias === 'BULLISH') ||
      (signal.direction === 'SHORT' && signal.dailyBias === 'BEARISH')
    const h4Aligned =
      (signal.direction === 'LONG' && signal.coinTrend === 'BULLISH') ||
      (signal.direction === 'SHORT' && signal.coinTrend === 'BEARISH')
    const inOb = zones.some((z) => z.includes('OB'))

    const ic = calculateIntradayConfidence({
      dailyBiasAligned: dailyAligned,
      h4TrendAligned: h4Aligned,
      ltfChoCH: !!(signal.ltfChoCH?.detected || signal.mss?.detected),
      killzoneActive: kz.active,
      inHtfOrderBlock: inOb,
      oteInZone: !!signal.ote?.priceInZone,
      pocConfluence: !!volumeProfile?.obPocConfluence,
      liquidationSwept: liq.swept,
    })
    styleConfidence = ic.score
    styleFactors = ic.factors
  }

  // Ghost path realism
  let ghostPathWarning: string | null = null
  let unrealisticTp = false
  if (enriched.sl != null && enriched.tp1 != null) {
    const ghost = buildGhostPath({
      entry: enriched.ltfChoCH?.surgicalEntryPrice ?? enriched.price,
      tp1: enriched.tp1,
      tp2: enriched.tp2,
      sl: enriched.sl,
      direction: signal.direction,
      atr,
      dailyAtrPct,
      style,
      candleTimeframeSeconds: style === 'SCALP' ? 60 : 900,
    })
    unrealisticTp = ghost.unrealisticTp
    ghostPathWarning = ghost.warning
    if (ghost.unrealisticTp) {
      enriched = {
        ...enriched,
        tp1: ghost.adjustedTp1,
        tp2: ghost.adjustedTp2,
      }
      zones.push('TP_ADJUSTED: ATR realism')
    }
  }

  // Dynamic invalidation
  const invCandles = ctx.ohlcv5m?.length
    ? ctx.ohlcv5m
    : ctx.ohlcv1m?.length
      ? ctx.ohlcv1m
      : ctx.ohlcv15m
  const inv = calculateDynamicInvalidation(
    invCandles,
    signal.direction,
    ctx.ohlcv5m?.length ? '5m' : '1m'
  )

  // Интрадей: не триггерим элитный сетап если liq gate закрыт (сильный пул не снят)
  let hasActiveSetup = enriched.hasActiveSetup
  if (
    hasActiveSetup &&
    style === 'INTRADAY' &&
    !liq.gateOpen &&
    styleConfidence < 85
  ) {
    hasActiveSetup = false
    zones.push(`LIQ_GATE: ${liq.label}`)
    logger.info(
      `[PE] ${signal.internalSymbol} liq gate closed — setup deferred`
    )
  }

  return {
    ...enriched,
    zones,
    hasActiveSetup,
    tradeStyle: style,
    styleReasons: [...classification.reasons, ...styleFactors],
    styleConfidence,
    invalidationPrice: inv?.price ?? null,
    invalidationMessage: inv?.message ?? null,
    ghostPathWarning,
    unrealisticTp,
    activeSignal: enriched.activeSignal
      ? {
          ...enriched.activeSignal,
          win_rate: styleConfidence || enriched.probabilityPct,
        }
      : null,
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
    liquidityMap,
    btcOhlcv1h,
    ohlcv5m,
    ohlcv1m,
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

  const applyLiquidityBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (!liquidityMap || !direction) return { score, zones }
    const boost = liquidityMap.liquidityBoost
    if (boost === 0) return { score, zones }

    const relevantLevel =
      direction === 'LONG' ? liquidityMap.nearestSSL : liquidityMap.nearestBSL
    if (!relevantLevel || !relevantLevel.isActive) return { score, zones }

    const finalScore = Math.min(Math.max(score + boost, 0), 10)
    const tag = `LIQ_${relevantLevel.type}_${relevantLevel.strength}_${relevantLevel.distancePct.toFixed(1)}%`
    logger.info(
      `[PE] ${internalSymbol} liquidity boost: +${boost.toFixed(2)} (${tag})`
    )

    return {
      score: finalScore,
      zones: [...zones, `LIQ_BOOST: ${tag}`],
    }
  }

  const closes1h = ohlcv1h.map((c) => c[4])
  const currentPrice = closes1h[closes1h.length - 1] ?? 0
  const rsi = closes1h.length ? calculateRsi(closes1h) : null

  // ── BTC Divergence ────────────────────────────────────────────────────────
  const divergence: BtcDivergenceResult =
    btcOhlcv1h && btcOhlcv1h.length >= 25
      ? calculateBtcDivergence(btcOhlcv1h, ohlcv1h, 24)
      : {
          type: 'NONE',
          btcChangePct: 0,
          altChangePct: 0,
          relativeStrength: 0,
          scoreBoost: 0,
          label: '',
          lookbackCandles: 24,
        }

  const applyDivergenceBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (
      !direction ||
      divergence.type === 'NONE' ||
      divergence.type === 'CORRELATED'
    ) {
      return { score, zones }
    }

    let boost = 0
    let tag = ''

    if (direction === 'LONG' && divergence.type === 'BULL_DIV') {
      boost = divergence.scoreBoost
      tag = `DIV_BULL: +${boost.toFixed(2)}`
    } else if (direction === 'SHORT' && divergence.type === 'BEAR_DIV') {
      boost = divergence.scoreBoost
      tag = `DIV_BEAR: +${boost.toFixed(2)}`
    } else if (direction === 'LONG' && divergence.type === 'BEAR_DIV') {
      boost = -(divergence.scoreBoost * 0.5)
      tag = `DIV_CONTRA: ${boost.toFixed(2)}`
    } else if (direction === 'SHORT' && divergence.type === 'BULL_DIV') {
      boost = -(divergence.scoreBoost * 0.5)
      tag = `DIV_CONTRA: ${boost.toFixed(2)}`
    }

    if (boost === 0) return { score, zones }

    const finalScore = Math.min(Math.max(score + boost, 0), 10)
    logger.info(
      `[PE] ${internalSymbol} divergence boost: ${boost >= 0 ? '+' : ''}${boost.toFixed(2)} | ${divergence.label}`
    )

    return {
      score: finalScore,
      zones: [...zones, tag],
    }
  }

  // ── Pre-compute LTF signals (используются в trySide) ─────────────────────
  // MSS, Raid, OTE вычисляются один раз и используются в обоих направлениях
  const _mssLong =
    ohlcv5m && ohlcv5m.length >= 15 ? detectMSS(ohlcv5m, 'LONG', 30) : null
  const _mssShort =
    ohlcv5m && ohlcv5m.length >= 15 ? detectMSS(ohlcv5m, 'SHORT', 30) : null
  const _raidLong = detectLiquidityRaid(ohlcv1h, 'LONG', 20, 5)
  const _raidShort = detectLiquidityRaid(ohlcv1h, 'SHORT', 20, 5)

  const emptyAbsorption: AbsorptionCandle = {
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
  const _absorption: AbsorptionCandle =
    ohlcv1h.length >= 30
      ? detectAbsorptionCandle(ohlcv1h, 10, 2.5, 0.35, 0.45)
      : emptyAbsorption

  const emptyChoCH: LTFChoCHResult = {
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
  const _ltfChoCH: LTFChoCHResult =
    ohlcv1m && ohlcv1m.length >= 20 ? detectLTFChoCH(ohlcv1m, 2) : emptyChoCH

  const applyLTFBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): {
    score: number
    zones: string[]
    mss: MSSResult | null
    raid: LiquidityRaidResult | null
    ote: OTESniperZone | null
  } => {
    if (!direction) return { score, zones, mss: null, raid: null, ote: null }

    let s = score
    const z = [...zones]
    let mssResult: MSSResult | null = null
    let raidResult: LiquidityRaidResult | null = null
    let oteResult: OTESniperZone | null = null

    const mss = direction === 'LONG' ? _mssLong : _mssShort
    if (mss?.detected) {
      s = Math.min(s + mss.scoreBoost, 10)
      z.push(`MSS_${direction}: ${mss.label}`)
      mssResult = mss
      logger.info(`[PE] ${internalSymbol} MSS boost: +${mss.scoreBoost}`)
    }

    const raid = direction === 'LONG' ? _raidLong : _raidShort
    if (raid.type !== 'NONE' && raid.isFresh) {
      s = Math.min(s + raid.scoreBoost, 10)
      z.push(`RAID_${raid.type}: ${raid.label}`)
      raidResult = raid
      logger.info(`[PE] ${internalSymbol} Raid boost: +${raid.scoreBoost}`)
    }

    const ote = calculateOTEZone(ohlcv1h, currentPrice, direction)
    if (ote.priceInZone) {
      s = Math.min(s + ote.scoreBoost, 10)
      z.push(`OTE_${direction}: ${ote.label}`)
      oteResult = ote
      logger.info(`[PE] ${internalSymbol} OTE boost: +${ote.scoreBoost}`)
    }

    return { score: s, zones: z, mss: mssResult, raid: raidResult, ote: oteResult }
  }

  const applyAbsorptionBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (!_absorption.detected || direction !== 'LONG') return { score, zones }

    const finalScore = Math.min(score + _absorption.scoreBoost, 10)
    logger.info(
      `[PE] ${internalSymbol} Absorption boost: +${_absorption.scoreBoost} | ${_absorption.label}`
    )
    return {
      score: finalScore,
      zones: [...zones, `ABSORPTION: ${_absorption.label}`],
    }
  }

  const applyChoCHBoost = (
    score: number,
    direction: TradeSide | null,
    zones: string[]
  ): { score: number; zones: string[] } => {
    if (!_ltfChoCH.detected || direction !== 'LONG') return { score, zones }

    const finalScore = Math.min(score + _ltfChoCH.scoreBoost, 10)
    const tag = _ltfChoCH.surgicalEntryDetected
      ? `LTF_CHOCH+SURGICAL: ${_ltfChoCH.label}`
      : `LTF_CHOCH: ${_ltfChoCH.label}`

    logger.info(
      `[PE] ${internalSymbol} LTF CHoCH boost: +${_ltfChoCH.scoreBoost} | ${_ltfChoCH.label}`
    )

    return {
      score: finalScore,
      zones: [...zones, tag],
    }
  }

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
    const newsBoosted = applyNewsBoost(wallBoosted.score, wallBoosted.zones)
    const liqBoosted = applyLiquidityBoost(
      newsBoosted.score,
      side,
      newsBoosted.zones
    )
    const divBoosted = applyDivergenceBoost(
      liqBoosted.score,
      side,
      liqBoosted.zones
    )
    const ltfResult = applyLTFBoost(divBoosted.score, side, divBoosted.zones)
    const absorptionResult = applyAbsorptionBoost(
      ltfResult.score,
      side,
      ltfResult.zones
    )
    const chochResult = applyChoCHBoost(
      absorptionResult.score,
      side,
      absorptionResult.zones
    )
    const boosted = { score: chochResult.score, zones: chochResult.zones }
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
      btcDivergence: divergence.type !== 'NONE' ? divergence : null,
      mss: ltfResult.mss,
      raid: ltfResult.raid,
      ote: ltfResult.ote,
      absorption: _absorption.detected ? _absorption : null,
      ltfChoCH: _ltfChoCH.detected ? _ltfChoCH : null,
      buyerAggression: null,
    }

    const enriched = enrichSignal(signal, {
      ohlcv1h,
      ohlcv15m,
      ohlcv5m,
      ohlcv1m,
      liquidityMap,
      wallSupport: Boolean(wallTracker),
      bestZoneTop: confluence.bestZone.top,
      bestZoneBottom: confluence.bestZone.bottom,
    })

    return { signal: enriched, triggered: enriched.hasActiveSetup }
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
  const softNews = applyNewsBoost(softWall.score, softWall.zones)
  const softLiq = applyLiquidityBoost(
    softNews.score,
    softDirection,
    softNews.zones
  )
  const softDiv = applyDivergenceBoost(softLiq.score, softDirection, softLiq.zones)
  const softLTF = applyLTFBoost(softDiv.score, softDirection, softDiv.zones)
  const softAbsorption = applyAbsorptionBoost(
    softLTF.score,
    softDirection,
    softLTF.zones
  )
  const softChoCH = applyChoCHBoost(
    softAbsorption.score,
    softDirection,
    softAbsorption.zones
  )
  const softBoosted = { score: softChoCH.score, zones: softChoCH.zones }
  const flat = toFlatSymbol(internalSymbol)
  const probabilityPct = scoreToProbability(softBoosted.score)

  const softSignal: CoinSignal = {
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
    btcDivergence: divergence.type !== 'NONE' ? divergence : null,
    mss: softLTF.mss,
    raid: softLTF.raid,
    ote: softLTF.ote,
    absorption: _absorption.detected ? _absorption : null,
    ltfChoCH: _ltfChoCH.detected ? _ltfChoCH : null,
    buyerAggression: null,
  }

  const enrichedSoft =
    softSignal.direction != null
      ? enrichSignal(softSignal, {
          ohlcv1h,
          ohlcv15m,
          ohlcv5m,
          ohlcv1m,
          liquidityMap,
          wallSupport: Boolean(wallTracker),
        })
      : softSignal

  return {
    signal: enrichedSoft,
    triggered: false,
  }
}
