/**
 * ProbabilityEngine — SniperBot SMC confluence → probability %.
 *
 * Scoring is grouped into three non-linear clusters:
 *   HTF context 40 · Liquidity 33 · Microstructure 27
 * Additive boosts from correlated sources are not allowed to stack.
 *
 * Risk is structural: stop = zone invalidation ± 0.5×ATR. If that stop is
 * wider than the risk budget the setup is rejected as RISK_EXCEEDED, never
 * silently clamped. Take profit follows real opposite liquidity/structure;
 * when the nearest target is closer than the minimum RR the setup is rejected.
 */
import type { OhlcvCandle } from '../api/mexc'
import { isCommoditySymbol, toDisplayName, toFlatSymbol } from '../api/mexc'
import type {
  AbsorptionCandle,
  BtcDivergenceResult,
  CoinSignal,
  HtfTrendSnapshot,
  LiquidityMap,
  LTFChoCHResult,
  SetupRejectReason,
  SurgicalEntrySnapshot,
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
  type DailyBiasResult,
  type DailyLevels,
  type TradeSide,
  type TrendDirection,
} from './smc'
import { logger } from '../utils/logger'
import {
  classifyTradeStyle,
  calculateScalpConfidence,
  calculateIntradayConfidence,
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
import { pickInvalidationForDisplay } from './confidence/invalidation'
import { computeHtfTrendStrength } from './trend/htfTrendStrength'
import { buildGhostPath } from './prediction/ghostPath'
import { buildGlobalFibonacci } from './zones/globalFibonacci'
import { resolveSessionFlip } from './sessions/sessionFlip'
import {
  evaluateSessionQuality,
  type SessionQuality,
} from './sessions/sessionQuality'
import { computeMmIntent } from './mm/mmIntent'
import {
  resolveSurgicalEntry,
  isSurgicalReady,
} from './surgical/surgicalEntry'
import { buildScoreCard } from './confluence/scoreCard'
import { detectMarketRegime, type MarketRegime } from './regime/marketRegime'
import type { EnhancedCvdSnapshot } from './orderflow/enhancedCvd'
import type { ObDeltaSnapshot } from './orderbook/obDelta'
import type { SpoofAlert } from './mm/spoofing'
import type { IcebergResult } from './mm/iceberg'

export const CONFLUENCE_THRESHOLD = 4.5
export const SOFT_CONFLUENCE_THRESHOLD = 3.5
export const COOLDOWN_MS = 90 * 60 * 1000
export const SCALP_COOLDOWN_MS = 15 * 60 * 1000

/** Structural risk budget. A wider stop means the setup is rejected. */
const MAX_RISK_PCT = 3.0
const MAX_COMMODITY_RISK_PCT = 2.0
/** Minimum reward/risk against real opposite liquidity. */
const MIN_RR = 1.5
/** Commodity spread gate (percent, 0.05 = 5 bps). */
const COMMODITY_MAX_SPREAD_PCT = 0.05
/** Crypto perp spread gate (percent). */
const CRYPTO_MAX_SPREAD_PCT = 0.35

export interface MacroContextInput {
  /** DXY change over the session/day in percent */
  dxyChangePct?: number | null
  /** US10Y change over the session/day in percent */
  us10yChangePct?: number | null
}

export interface AnalyzeSymbolInput {
  internalSymbol: string
  ohlcv4h: OhlcvCandle[]
  ohlcv1h: OhlcvCandle[]
  ohlcv15m: OhlcvCandle[]
  /** Daily candles for global Fibonacci (falls back to 4h) */
  ohlcv1d?: OhlcvCandle[]
  priceChange24h: number
  dailyBias: DailyBiasResult
  btcTrend: TrendDirection
  /** Optional live wall tracker (open coin) for score boost */
  wallTracker?: WallTrackerState
  /** News sentiment boost from News Intelligence (−1.5…+1.5) */
  newsSentimentBoost?: number
  /**
   * Extra score nudge from BTC.D / Fear&Greed (worker market context).
   * Applied after news boost; clamped −0.8…+0.8.
   */
  marketCtxBoost?: number
  /** Human notes from market context (appended to zones when |boost| meaningful) */
  marketCtxNotes?: string[]
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
  /** Order book imbalance −100…+100 from live depth */
  bookImbalance?: number | null
  /** Live book spread in percent (0.08 = 0.08%). Optional; absent = no gate. */
  spreadPct?: number | null
  /** Optional DXY / yields context. Absent = neutral, never fabricated. */
  macroContext?: MacroContextInput | null
  /** Precomputed MM intent (from depth + liq map) */
  mmIntent?: import('./types').MmIntentSnapshot | null
  /** Session DNA for flip bias */
  sessionDna?: import('./types').SessionDNA | null
  /** Previous surgical plan (persist WAITING across scans) */
  previousSurgical?: SurgicalEntrySnapshot | null
  /** Enhanced CVD from REST deals (or OHLCV proxy) */
  enhancedCvd?: EnhancedCvdSnapshot | null
  spoofAlerts?: SpoofAlert[] | null
  icebergAlerts?: IcebergResult[] | null
  obDelta?: ObDeltaSnapshot | null
  /** Live Remizov sequence from OrderBookPanel */
  sequence?: import('./sequence/types').SequenceHit | null
}

export interface AnalyzeSymbolResult {
  signal: CoinSignal
  triggered: boolean
}

interface StructuralLevels {
  sl: number | null
  tp1: number | null
  tp2: number | null
  tpDaily: number | null
  riskPct: number
  rr: number | null
  reject: SetupRejectReason | null
  notes: string[]
}

interface ClusterScore {
  total: number
  htf: number
  liquidity: number
  microstructure: number
  notes: string[]
}

interface ClusterInput {
  side: TradeSide
  price: number
  atr: number
  confluenceScore: number
  inZone: boolean
  nearZone: boolean
  htfTrend: HtfTrendSnapshot | null
  dailyBias: DailyBiasResult
  regime: MarketRegime
  globalFib: ReturnType<typeof buildGlobalFibonacci> | null
  btcTrend: TrendDirection
  isCommodity: boolean
  macroContext?: MacroContextInput | null
  session: SessionQuality
  liquidityMap?: LiquidityMap
  raidFresh: boolean
  raidType: string
  oteInZone: boolean
  volumeProfile: ReturnType<typeof calculateVolumeProfile> | null
  liqGateOpen: boolean
  liqSwept: boolean
  rejection: boolean
  mss: boolean
  choch: boolean
  absorption: boolean
  cvdAligned: boolean
  cvdSource: 'TRADES' | 'OHLCV_PROXY' | 'NONE'
  bookAligned: boolean
  bookAgainst: boolean
  mmAligned: boolean
  wallAligned: boolean
  sequenceAligned: boolean
  spoofAligned: boolean
  icebergAligned: boolean
  obDeltaAligned: boolean
  rr: number | null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Sub-linear cluster shape: the 10th correlated signal cannot add 10 points. */
function shape(raw: number, max: number): number {
  return max * Math.pow(clamp(raw / max, 0, 1), 0.85)
}

function finitePositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/**
 * Structural stop and real target selection.
 * SL = far edge of the zone / invalidation ± 0.5×ATR.
 * TP = nearest opposite daily/liquidity/Fib structure.
 */
function buildLevels(opts: {
  side: TradeSide
  price: number
  confluence: ReturnType<typeof calculateConfluence>
  dailyLevels: DailyLevels | null
  atr: number
  targets: number[]
  maxRiskPct: number
}): StructuralLevels {
  const { side, price, confluence, dailyLevels, atr, targets, maxRiskPct } = opts
  const top = confluence.bestZone.top
  const bottom = confluence.bestZone.bottom
  const empty: StructuralLevels = {
    sl: null,
    tp1: null,
    tp2: null,
    tpDaily: null,
    riskPct: 0,
    rr: null,
    reject: 'INVALID_STRUCTURE',
    notes: ['STRUCTURE: нет валидной зоны'],
  }

  if (top == null || bottom == null || !(atr > 0) || !(price > 0)) {
    return empty
  }

  const zoneEdge = side === 'LONG' ? Math.min(top, bottom) : Math.max(top, bottom)
  const invalidation = confluence.bestZone.sl
  const farEdge =
    invalidation != null && Number.isFinite(invalidation)
      ? side === 'LONG'
        ? Math.min(zoneEdge, invalidation)
        : Math.max(zoneEdge, invalidation)
      : zoneEdge
  const buffer = atr * 0.5
  const sl = side === 'LONG' ? farEdge - buffer : farEdge + buffer

  if (!Number.isFinite(sl) || (side === 'LONG' ? sl >= price : sl <= price)) {
    return {
      ...empty,
      notes: ['STRUCTURE: цена уже за инвалидацией зоны'],
    }
  }

  const risk = Math.abs(price - sl)
  const riskPct = (risk / price) * 100
  const dailyTarget =
    side === 'LONG'
      ? dailyLevels?.pdh ??
        dailyLevels?.nearestResistance ??
        dailyLevels?.pwh ??
        null
      : dailyLevels?.pdl ??
        dailyLevels?.nearestSupport ??
        dailyLevels?.pwl ??
        null

  const tpDaily = finitePositive(dailyTarget)
    ? dailyTarget
    : null

  const sorted = Array.from(
    new Set(targets.filter((n) => finitePositive(n)))
  )
    .filter((n) => (side === 'LONG' ? n > price : n < price))
    .sort((a, b) => (side === 'LONG' ? a - b : b - a))

  const tp1 = sorted[0] ?? null
  const tp2 = sorted[1] ?? null
  const rr = tp1 != null ? Math.abs(tp1 - price) / risk : null

  let reject: SetupRejectReason | null = null
  const notes: string[] = [
    `RISK: ${riskPct.toFixed(2)}% · SL ${sl.toPrecision(6)} (±0.5 ATR)`,
  ]

  if (riskPct > maxRiskPct) {
    reject = 'RISK_EXCEEDED'
    notes.push(
      `RISK_EXCEEDED: структурный стоп ${riskPct.toFixed(2)}% > ${maxRiskPct.toFixed(2)}%`
    )
  }

  if (tp1 == null) {
    reject = reject ?? 'RR_TOO_LOW'
    notes.push('RR_TOO_LOW: нет противоположной ликвидности/структуры')
  } else if (rr != null && rr < MIN_RR) {
    reject = reject ?? 'RR_TOO_LOW'
    notes.push(
      `RR_TOO_LOW: ближайшая цель ${rr.toFixed(2)}R < ${MIN_RR.toFixed(2)}R`
    )
  } else if (rr != null) {
    notes.push(`RR: ${rr.toFixed(2)}R · TP ${tp1.toPrecision(6)}`)
  }

  if (tp2 == null && tp1 != null) {
    notes.push('TP2: нет следующей структуры — только TP1')
  }

  return { sl, tp1, tp2, tpDaily, riskPct, rr, reject, notes }
}

/**
 * Three clusters, capped and sub-linear.
 * HTF 40 · Liquidity 33 · Microstructure 27 = 100.
 */
function scoreClusters(input: ClusterInput): ClusterScore {
  const notes: string[] = []
  const sideSign = input.side === 'LONG' ? 1 : -1
  const htfAligned =
    input.side === 'LONG'
      ? input.htfTrend?.bias === 'BULLISH'
      : input.htfTrend?.bias === 'BEARISH'
  const htfAgainst =
    input.side === 'LONG'
      ? input.htfTrend?.bias === 'BEARISH'
      : input.htfTrend?.bias === 'BULLISH'

  let h = 0

  // 1. HTF trend (max 14)
  if (input.htfTrend) {
    const strength = clamp(input.htfTrend.strength, 0, 100) / 100
    if (htfAligned) {
      h += 6 + 8 * strength
    } else if (input.htfTrend.bias === 'RANGING') {
      h += 5
    } else if (htfAgainst) {
      h += 1
    }
  } else {
    h += 3
  }

  // 2. Daily bias (max 8)
  const dir = input.dailyBias.direction
  const dailyAllows =
    (input.side === 'LONG' && (dir === 'LONG_ONLY' || dir === 'BOTH')) ||
    (input.side === 'SHORT' && (dir === 'SHORT_ONLY' || dir === 'BOTH'))
  if (dailyAllows) {
    h += 4 + 4 * clamp(input.dailyBias.confidence, 0, 100) / 100
  } else if (dir === 'BOTH') {
    h += 3
  }

  // 3. Regime (max 5)
  if (input.regime === 'TRENDING_STRONG') h += htfAligned ? 5 : 1
  else if (input.regime === 'TRENDING_WEAK') h += htfAligned ? 3.5 : 1
  else if (input.regime === 'RANGING') h += 2

  // 4. Global Fib 141 context (max 5)
  if (input.globalFib?.entryBias === input.side) {
    if (input.globalFib.in141) h += 5
    else if (input.globalFib.near141) h += 3
    else if (input.globalFib.zone141) h += 1.5
  }

  // 5. Cross-market context (max 5)
  if (input.isCommodity) {
    // Gold/silver: DXY and yields are the relevant cross-market drivers.
    // Missing feeds are neutral, never invented.
    const dxy = input.macroContext?.dxyChangePct ?? null
    const yields = input.macroContext?.us10yChangePct ?? null
    let macroPts = 0
    let feed = 0
    for (const v of [dxy, yields]) {
      if (v == null || !Number.isFinite(v)) continue
      feed++
      if (-v * sideSign > 0.02) macroPts += 2.5
      else if (Math.abs(v) <= 0.02) macroPts += 1.5
    }
    if (feed === 0) {
      h += 2.5
      notes.push('MACRO: DXY/yields feed отсутствует — нейтрально')
    } else {
      h += Math.min(5, macroPts)
      notes.push(
        `MACRO: DXY ${dxy == null ? '—' : `${dxy.toFixed(2)}%`} · US10Y ${yields == null ? '—' : `${yields.toFixed(2)}%`}`
      )
    }
  } else {
    if (input.btcTrend === 'RANGING') h += 2.5
    else if (
      (input.side === 'LONG' && input.btcTrend === 'BULLISH') ||
      (input.side === 'SHORT' && input.btcTrend === 'BEARISH')
    ) {
      h += 5
    }
  }

  // 6. Session quality (max 3)
  h += clamp(input.session.score, 0, 100) / 100 * 3

  if (htfAgainst && input.htfTrend?.label === 'STRONG') {
    h = Math.min(h, 10)
    notes.push('HTF: сильный встречный тренд — кластер срезан')
  }

  const htfRaw = clamp(h, 0, 40)

  // Liquidity cluster (max 33)
  let l = 0
  if (input.inZone) l += 9
  else if (input.nearZone) l += 6

  if (input.raidFresh) l += 8
  else if (input.raidType !== 'NONE') l += 4

  if (input.oteInZone) l += 3

  if (input.rr != null) {
    if (input.rr >= 2.5) l += 7
    else if (input.rr >= 1.8) l += 5
    else if (input.rr >= 1.4) l += 2
  }

  const vp = input.volumeProfile
  if (vp?.obPocConfluence) l += 4
  else if (vp && input.price >= vp.val && input.price <= vp.vah) l += 2

  if (input.liqGateOpen) l += 3
  if (input.liqSwept) l += 2
  if (input.liquidityMap?.nearestBSL || input.liquidityMap?.nearestSSL) l += 1

  const liquidityRaw = clamp(l, 0, 33)

  // Microstructure cluster (max 27)
  const structureRaw = (input.rejection ? 6 : 0) + (input.mss || input.choch ? 5 : 0)

  // All order-flow evidence is one capped bucket. Stacking CVD + book + tape
  // + spoof + iceberg must not manufacture confidence.
  let flowRaw = 0
  if (input.absorption) flowRaw += 4
  if (input.cvdAligned) flowRaw += 5
  if (input.bookAligned) flowRaw += 4
  if (input.bookAgainst) flowRaw -= 2
  if (input.mmAligned || input.wallAligned) flowRaw += 3
  if (input.sequenceAligned) flowRaw += 1.5
  if (input.spoofAligned || input.icebergAligned || input.obDeltaAligned) flowRaw += 1.5
  const flowCapped = clamp(flowRaw, 0, 15)

  const confluencePts = clamp(input.confluenceScore, 0, 10) * 0.2
  const microRaw = clamp(structureRaw + flowCapped + confluencePts, 0, 27)

  if (input.cvdSource !== 'TRADES') {
    notes.push('ORDERFLOW: CVD прокси — микро-кластер ограничен')
  }

  const htf = shape(htfRaw, 40)
  const liquidity = shape(liquidityRaw, 33)
  const microstructure = shape(microRaw, 27)

  let total = htf + liquidity + microstructure
  if (input.regime === 'VOLATILE_CHOP') total *= 0.8
  if (input.session.avoid) total *= 0.9
  if (input.cvdSource !== 'TRADES') total = Math.min(total, 92)
  total = Math.round(clamp(total, 0, 100))

  notes.unshift(
    `CLUSTERS: HTF ${htf.toFixed(0)}/40 · LIQ ${liquidity.toFixed(0)}/33 · FLOW ${microstructure.toFixed(0)}/27`
  )

  return {
    total,
    htf,
    liquidity,
    microstructure,
    notes,
  }
}

function emptySignal(
  internalSymbol: string,
  price: number,
  priceChange24h: number,
  rsi: number | null,
  coinTrend: TrendDirection | null,
  btcTrend: TrendDirection,
  dailyBias: DailyBiasResult,
  atrPct: number | null,
  zones: string[] = [],
  rejected: SetupRejectReason | null = null
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
    zones,
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
    atrPct,
    rejected,
  }
}

/**
 * Enriches a signal: VPVR, liquidations, CVD, style confidence, ghost path,
 * invalidation and the strict ScoreCard readiness gate.
 * It never changes structural SL/TP.
 */
function enrichSignal(
  signal: CoinSignal,
  ctx: {
    ohlcv1h: OhlcvCandle[]
    ohlcv15m: OhlcvCandle[]
    ohlcv5m?: OhlcvCandle[]
    ohlcv1m?: OhlcvCandle[]
    ohlcv4h?: OhlcvCandle[]
    liquidityMap?: LiquidityMap
    tapeBurst?: boolean
    wallSupport?: boolean
    bestZoneTop?: number | null
    bestZoneBottom?: number | null
    enhancedCvd?: EnhancedCvdSnapshot | null
    spoofAlerts?: SpoofAlert[] | null
    icebergAlerts?: IcebergResult[] | null
    obDelta?: ObDeltaSnapshot | null
    sequence?: import('./sequence/types').SequenceHit | null
    htfTrend: HtfTrendSnapshot | null
    regime: MarketRegime
    session: SessionQuality
  }
): CoinSignal {
  if (!signal.direction) return signal

  const atr = calculateAtr(ctx.ohlcv1h, 14) ?? signal.price * 0.005
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

  const zones = [...signal.zones]
  if (volumeProfile?.obPocConfluence) {
    zones.push(`VPVR: ${volumeProfile.confluenceLabel}`)
  }
  if (cvdDivergence?.detected) {
    const aligned =
      (signal.direction === 'LONG' && cvdDivergence.type === 'BULLISH') ||
      (signal.direction === 'SHORT' && cvdDivergence.type === 'BEARISH')
    if (aligned) zones.push(`CVD: ${cvdDivergence.label}`)
  }
  if (liq.scoreBoost > 0) {
    zones.push(`LIQ: ${liq.label}`)
  }

  const enriched: CoinSignal = {
    ...signal,
    zones,
    volumeProfile,
    liquidationContext,
    cvdDivergence,
  }

  const classification = classifyTradeStyle(enriched)
  const style = classification.style
  const kz = isKillzoneActive()

  // Style confidence (does not rewrite levels)
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

  // Ghost path realism: flag unrealistic TP, never clamp it.
  let ghostPathWarning: string | null = null
  let unrealisticTp = false
  if (enriched.sl != null && enriched.tp1 != null) {
    const ghost = buildGhostPath({
      entry: enriched.surgicalEntry?.limitEntry ?? enriched.price,
      tp1: enriched.tp1,
      tp2: enriched.tp2,
      sl: enriched.sl,
      direction: signal.direction,
      atr,
      dailyAtrPct,
      style,
      candleTimeframeSeconds:
        style === 'SCALP' ? 60 : style === 'SWING' ? 14_400 : 900,
    })
    unrealisticTp = ghost.unrealisticTp
    ghostPathWarning = ghost.warning
    if (ghost.unrealisticTp) {
      zones.push(
        `TP_REALISM: ${ghost.warning ?? 'TP далеко для текущего ATR'}`
      )
    }
  }

  // HTF invalidation (1H/4H close) preferred for display; LTF for early warn
  const inv = pickInvalidationForDisplay({
    direction: signal.direction,
    ohlcv1m: ctx.ohlcv1m,
    ohlcv5m: ctx.ohlcv5m,
    ohlcv1h: ctx.ohlcv1h,
    ohlcv4h: ctx.ohlcv4h,
  })
  if (inv) {
    zones.push(
      inv.breached
        ? `HTF_BREAK: ${inv.timeframe.toUpperCase()}`
        : `INV_${inv.timeframe.toUpperCase()}: ${inv.price.toFixed(4)}`
    )
  }

  // Интрадей: liq gate закрыт — не убиваем сетап, а снижаем confidence
  let hasActiveSetup = enriched.hasActiveSetup
  if (
    hasActiveSetup &&
    style === 'INTRADAY' &&
    !liq.gateOpen &&
    styleConfidence < 70
  ) {
    styleConfidence = Math.min(styleConfidence, 62)
    zones.push(`LIQ_GATE_WARN: ${liq.label}`)
    logger.info(
      `[PE] ${signal.internalSymbol} liq gate closed — confidence capped, setup kept`
    )
  }

  // Strong opposing HTF → demote active setup
  if (
    hasActiveSetup &&
    ctx.htfTrend &&
    ctx.htfTrend.label === 'STRONG' &&
    ((signal.direction === 'LONG' && ctx.htfTrend.bias === 'BEARISH') ||
      (signal.direction === 'SHORT' && ctx.htfTrend.bias === 'BULLISH'))
  ) {
    hasActiveSetup = false
    zones.push('HTF_OPPOSE: сильный встречный тренд')
  }

  if (enriched.rejected) {
    hasActiveSetup = false
    zones.push(`REJECT: ${enriched.rejected}`)
  }

  // ── ScoreCard gate (strict A+/A only) ──────────────────────────────────
  const entryPx =
    signal.surgicalEntry?.limitEntry && signal.surgicalEntry.limitEntry > 0
      ? signal.surgicalEntry.limitEntry
      : signal.price
  const slPx = enriched.sl ?? 0
  const tpPx = enriched.tp1 ?? 0
  const inOb = zones.some((z) => /OB|Order.?Block|ORDER_BLOCK/i.test(z))
  const inFvg = zones.some((z) => /FVG/i.test(z))
  const hasZone =
    (ctx.bestZoneTop != null && ctx.bestZoneBottom != null) || inOb || inFvg

  const card = buildScoreCard({
    symbol: signal.internalSymbol,
    direction: signal.direction,
    style,
    htfTrend: ctx.htfTrend,
    mmIntent: signal.mmIntent ?? null,
    spoofAlerts: ctx.spoofAlerts ?? null,
    icebergAlerts: ctx.icebergAlerts ?? null,
    enhancedCvd: ctx.enhancedCvd ?? null,
    obDelta: ctx.obDelta ?? null,
    raid: signal.raid ?? null,
    inOrderBlock: inOb,
    inFvg,
    hasBestZone: hasZone,
    regime: ctx.regime,
    session: ctx.session,
    entry: entryPx,
    stopLoss: slPx,
    takeProfit: tpPx,
    sequence: ctx.sequence ?? null,
  })

  if (hasActiveSetup && !card.ready) {
    hasActiveSetup = false
  }
  zones.push(`SCORECARD: ${card.grade} ${card.totalScore}/${card.maxScore}`)

  let probabilityPct = signal.probabilityPct
  if (signal.rejected) {
    probabilityPct = Math.min(probabilityPct, 35)
  } else if (card.ready) {
    probabilityPct = Math.round(probabilityPct * 0.7 + card.percent * 0.3)
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
    htfTrend: ctx.htfTrend,
    scoreCard: {
      direction: card.direction,
      style: card.style,
      totalScore: card.totalScore,
      maxScore: card.maxScore,
      percent: card.percent,
      grade: card.grade,
      baseGrade: card.baseGrade,
      skipKind: card.skipKind,
      hardBlockers: card.hardBlockers,
      ready: card.ready,
      missingFactors: card.missingFactors,
      factors: card.factors,
      dataQuality: card.dataQualitySnapshot ?? null,
    },
    marketRegime: ctx.regime,
    sessionQuality: ctx.session,
    probabilityPct,
    activeSignal: enriched.activeSignal
      ? {
          ...enriched.activeSignal,
          win_rate: styleConfidence || probabilityPct,
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
    ohlcv1d,
    priceChange24h,
    dailyBias,
    btcTrend,
    wallTracker,
    newsSentimentBoost,
    marketCtxNotes,
    liquidityMap,
    btcOhlcv1h,
    ohlcv5m,
    ohlcv1m,
    bookImbalance,
    spreadPct,
    macroContext,
    mmIntent: mmIntentInput,
    sessionDna,
    previousSurgical,
    enhancedCvd,
    spoofAlerts,
    icebergAlerts,
    obDelta,
    sequence,
  } = input

  const commodity = isCommoditySymbol(internalSymbol)
  const closes1h = ohlcv1h.map((c) => c[4])
  const currentPrice = closes1h[closes1h.length - 1] ?? 0
  const rsi = closes1h.length ? calculateRsi(closes1h) : null
  const atr = calculateAtr(ohlcv1h, 14) ?? currentPrice * 0.005
  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : null
  const regime = detectMarketRegime(ohlcv1h, ohlcv4h)
  const session = evaluateSessionQuality()
  const htfTrend =
    ohlcv4h && ohlcv4h.length >= 20
      ? computeHtfTrendStrength(ohlcv1h, ohlcv4h)
      : ohlcv1h.length >= 30
        ? computeHtfTrendStrength(ohlcv1h, ohlcv1h)
        : null

  const effectiveBtcTrend: TrendDirection = commodity ? 'RANGING' : btcTrend

  const spreadLimit = commodity
    ? COMMODITY_MAX_SPREAD_PCT
    : CRYPTO_MAX_SPREAD_PCT
  if (spreadPct != null && Number.isFinite(spreadPct) && spreadPct > spreadLimit) {
    return {
      signal: emptySignal(
        internalSymbol,
        currentPrice,
        priceChange24h,
        rsi,
        null,
        btcTrend,
        dailyBias,
        atrPct,
        [
          `SPREAD_GATE: ${spreadPct.toFixed(3)}% > ${spreadLimit.toFixed(2)}%`,
        ],
        'SPREAD_TOO_WIDE'
      ),
      triggered: false,
    }
  }

  // Resolve / compute MM intent early for side selection
  const mmIntent =
    mmIntentInput ??
    computeMmIntent({
      price: currentPrice,
      book:
        bookImbalance != null
          ? {
              imbalance: bookImbalance,
              bidVolume: 0,
              askVolume: 0,
              bidOrders: 0,
              askOrders: 0,
              walls: [],
              midPrice: null,
              spread: null,
              spreadPercent: spreadPct ?? null,
              pressure:
                bookImbalance > 20
                  ? 'BUYERS'
                  : bookImbalance < -20
                    ? 'SELLERS'
                    : 'NEUTRAL',
            }
          : null,
      liquidityMap: liquidityMap ?? null,
    })

  const globalFib = buildGlobalFibonacci(
    ohlcv1d && ohlcv1d.length >= 20 ? ohlcv1d : ohlcv4h,
    currentPrice
  )

  // BTC divergence is meaningful for crypto only. Metals trade their own
  // supply/demand plus DXY/yields, never a BTC proxy.
  const divergence: BtcDivergenceResult =
    !commodity && btcOhlcv1h && btcOhlcv1h.length >= 25
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
        dailyBias,
        atrPct
      ),
      triggered: false,
    }
  }

  const coinStructure = detectMarketStructure(ohlcv4h, 50)
  const coinTrend = coinStructure.trend

  const ltfAlive =
    _raidLong.isFresh ||
    _raidShort.isFresh ||
    _ltfChoCH.detected ||
    _absorption.detected ||
    (_mssLong?.detected ?? false) ||
    (_mssShort?.detected ?? false)

  // Dual ranging blocks only when there is no LTF trigger. Commodities are
  // not gated by BTC's range.
  if (
    coinTrend === 'RANGING' &&
    (commodity ? !ltfAlive : effectiveBtcTrend === 'RANGING' && !ltfAlive)
  ) {
    return {
      signal: emptySignal(
        internalSymbol,
        currentPrice,
        priceChange24h,
        rsi,
        coinTrend,
        btcTrend,
        dailyBias,
        atrPct
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
    (coinTrend === 'BULLISH' ||
      (coinTrend === 'RANGING' &&
        (commodity
          ? ltfAlive
          : effectiveBtcTrend === 'BULLISH' ||
            (effectiveBtcTrend === 'RANGING' && ltfAlive))) ||
      (coinTrend === 'BEARISH' && (_raidLong.isFresh || _ltfChoCH.detected)))
  const shortAllowed =
    shortPermitted &&
    (coinTrend === 'BEARISH' ||
      (coinTrend === 'RANGING' &&
        (commodity
          ? ltfAlive
          : effectiveBtcTrend === 'BEARISH' ||
            (effectiveBtcTrend === 'RANGING' && ltfAlive))) ||
      (coinTrend === 'BULLISH' && _raidShort.isFresh))

  const sessionFlip = resolveSessionFlip({
    dailyLongOk: longPermitted,
    dailyShortOk: shortPermitted,
    coinTrend,
    liquidityMap: liquidityMap ?? null,
    sessionDna: sessionDna ?? null,
    mmIntent,
  })

  const longAllowedFinal = longAllowed || sessionFlip.longAllowedExtra
  const shortAllowedFinal = shortAllowed || sessionFlip.shortAllowedExtra
  if (sessionFlip.reason) {
    logger.info(`[PE] ${internalSymbol} session flip: ${sessionFlip.reason}`)
  }

  const liquidationClusters = buildLiquidationClusters(
    liquidityMap,
    currentPrice,
    ohlcv1h
  )
  const vpRaw = calculateVolumeProfile(ohlcv1h, 48, true)
  const cvdSrc = ohlcv5m?.length ? ohlcv5m : ohlcv15m
  const fallbackCvd = detectCvdDivergence(cvdSrc, 20)

  const targetsFor = (side: TradeSide): number[] => {
    const out: number[] = []
    const dl = dailyBias.dailyLevels
    if (dl) {
      if (side === 'LONG') {
        out.push(dl.pdh, dl.pwh, dl.nearestResistance ?? NaN)
      } else {
        out.push(dl.pdl, dl.pwl, dl.nearestSupport ?? NaN)
      }
      for (const k of dl.keyLevels ?? []) out.push(k.price)
    }
    if (liquidityMap) {
      const level =
        side === 'LONG' ? liquidityMap.nearestBSL : liquidityMap.nearestSSL
      if (level) out.push(level.price)
    }
    if (fibLevels) out.push(fibLevels['1.0'])
    if (globalFib?.price141 != null) out.push(globalFib.price141)
    if (vpRaw) out.push(side === 'LONG' ? vpRaw.vah : vpRaw.val)
    return out.filter((n) => finitePositive(n))
  }

  const trySide = (
    side: TradeSide,
    mode: 'STRICT' | 'SOFT'
  ): AnalyzeSymbolResult | null => {
    const confluence = calculateConfluence(
      currentPrice,
      orderBlocks,
      fvgList,
      fibLevels,
      side
    )
    const minScore =
      mode === 'STRICT' ? CONFLUENCE_THRESHOLD : SOFT_CONFLUENCE_THRESHOLD
    if (confluence.score < minScore) return null
    if (confluence.bestZone.top == null || confluence.bestZone.bottom == null) {
      return null
    }

    const top = confluence.bestZone.top
    const bottom = confluence.bestZone.bottom

    const rejection1h = checkCandleRejection(
      ohlcv1h[ohlcv1h.length - 1],
      top,
      bottom,
      side,
      0.35
    )
    const rejection15m =
      ohlcv15m.length > 0
        ? checkCandleRejection(
            ohlcv15m[ohlcv15m.length - 1],
            top,
            bottom,
            side,
            0.28
          )
        : { rejected: false, wickRatio: 0, bodyInZone: false }
    const rejection5m =
      ohlcv5m && ohlcv5m.length > 0
        ? checkCandleRejection(
            ohlcv5m[ohlcv5m.length - 1],
            top,
            bottom,
            side,
            0.25
          )
        : { rejected: false, wickRatio: 0, bodyInZone: false }

    const raidFresh =
      side === 'LONG' ? _raidLong.isFresh : _raidShort.isFresh
    const raid = side === 'LONG' ? _raidLong : _raidShort
    const surgicalLtf =
      _ltfChoCH.detected && !!_ltfChoCH.surgicalEntryDetected
    const ltfConfirm =
      raidFresh ||
      (side === 'LONG' && (_absorption.detected || _ltfChoCH.detected)) ||
      (side === 'SHORT' &&
        ((_mssShort?.detected ?? false) || _raidShort.isFresh))

    const hasRejection =
      rejection1h.rejected || rejection15m.rejected || rejection5m.rejected
    const priceInZone = currentPrice <= top && currentPrice >= bottom

    if (
      mode === 'STRICT' &&
      !hasRejection &&
      !(ltfConfirm && (priceInZone || surgicalLtf))
    ) {
      return null
    }

    // Regime-aware RSI: in a trend a 50–70 pullback is valid; only ranging
    // markets keep the old ~55 cap / ~45 floor.
    const trending =
      regime === 'TRENDING_STRONG' || regime === 'TRENDING_WEAK'
    if (side === 'LONG') {
      const maxRsi = trending ? 72 : 55
      const minRsi = trending ? 42 : 35
      if (rsi == null || rsi > maxRsi || rsi < minRsi) return null
    } else {
      const minRsi = trending ? 28 : 45
      const maxRsi = trending ? 58 : 65
      if (rsi == null || rsi < minRsi || rsi > maxRsi) return null
    }

    const levels = buildLevels({
      side,
      price: currentPrice,
      confluence,
      dailyLevels: dailyBias.dailyLevels,
      atr,
      targets: targetsFor(side),
      maxRiskPct: commodity ? MAX_COMMODITY_RISK_PCT : MAX_RISK_PCT,
    })

    const btcHardBlock =
      !commodity &&
      ((side === 'LONG' &&
        btcTrend === 'BEARISH' &&
        htfTrend?.bias === 'BEARISH' &&
        htfTrend.label === 'STRONG') ||
        (side === 'SHORT' &&
          btcTrend === 'BULLISH' &&
          htfTrend?.bias === 'BULLISH' &&
          htfTrend.label === 'STRONG'))

    const rejected: SetupRejectReason | null = btcHardBlock
      ? 'BTC_HARD_BLOCK'
      : levels.reject

    const mss = side === 'LONG' ? _mssLong : _mssShort
    const ote = calculateOTEZone(ohlcv1h, currentPrice, side)
    const ltf = {
      mss: mss?.detected ? mss : null,
      raid: raidFresh ? raid : null,
      ote: ote.priceInZone ? ote : null,
    }

    const liq = evaluateLiquidationGate(
      liquidationClusters,
      side,
      currentPrice,
      ltf.raid
    )
    const vpSide =
      vpRaw && top != null && bottom != null
        ? applyObPocConfluence(vpRaw, top, bottom)
        : vpRaw

    const cvdTrend = enhancedCvd
      ? enhancedCvd.trend
      : fallbackCvd.detected
        ? fallbackCvd.type
        : null
    const cvdSource: ClusterInput['cvdSource'] = enhancedCvd
      ? enhancedCvd.source
      : fallbackCvd.detected
        ? 'OHLCV_PROXY'
        : 'NONE'
    const cvdAligned =
      cvdTrend === (side === 'LONG' ? 'BULLISH' : 'BEARISH')

    const bookAligned =
      bookImbalance != null &&
      ((side === 'LONG' && bookImbalance >= 18) ||
        (side === 'SHORT' && bookImbalance <= -18))
    const bookAgainst =
      bookImbalance != null &&
      ((side === 'LONG' && bookImbalance <= -25) ||
        (side === 'SHORT' && bookImbalance >= 25))

    const mmAligned =
      mmIntent.drive !== 'NEUTRAL' &&
      mmIntent.preferredSide === side &&
      ((side === 'LONG' && mmIntent.scoreBoostForLong > 0.15) ||
        (side === 'SHORT' && mmIntent.scoreBoostForShort > 0.15))

    let wallAligned = false
    if (wallTracker) {
      for (const wall of wallTracker.walls.values()) {
        if (!wall.isActive) continue
        if (Math.abs(wall.price - currentPrice) / currentPrice > 0.005) continue
        if (
          (side === 'LONG' && wall.side === 'BID') ||
          (side === 'SHORT' && wall.side === 'ASK')
        ) {
          wallAligned = true
          break
        }
      }
    }

    const sequenceAligned =
      sequence != null &&
      sequence.side === side &&
      sequence.confidence >= 60
    const spoofAligned =
      spoofAlerts?.some(
        (a) =>
          a.detected &&
          ((side === 'LONG' && a.side === 'ASK') ||
            (side === 'SHORT' && a.side === 'BID'))
      ) ?? false
    const icebergAligned =
      icebergAlerts?.some(
        (a) =>
          a.detected &&
          a.status === 'HOLDING' &&
          ((side === 'LONG' && a.side === 'BID') ||
            (side === 'SHORT' && a.side === 'ASK'))
      ) ?? false
    const obDeltaAligned =
      obDelta != null &&
      ((side === 'LONG' && obDelta.volumeShift === 'BUYING') ||
        (side === 'SHORT' && obDelta.volumeShift === 'SELLING'))

    const nearZone =
      Math.abs(currentPrice - (top + bottom) / 2) <= atr * 0.75
    const cluster = scoreClusters({
      side,
      price: currentPrice,
      atr,
      confluenceScore: confluence.score,
      inZone: priceInZone,
      nearZone,
      htfTrend,
      dailyBias,
      regime,
      globalFib,
      btcTrend: effectiveBtcTrend,
      isCommodity: commodity,
      macroContext,
      session,
      liquidityMap,
      raidFresh,
      raidType: raid.type,
      oteInZone: ote.priceInZone,
      volumeProfile: vpSide,
      liqGateOpen: liq.gateOpen,
      liqSwept: liq.swept,
      rejection: hasRejection,
      mss: !!ltf.mss,
      choch: side === 'LONG' && _ltfChoCH.detected,
      absorption: side === 'LONG' && _absorption.detected,
      cvdAligned,
      cvdSource,
      bookAligned,
      bookAgainst,
      mmAligned,
      wallAligned,
      sequenceAligned,
      spoofAligned,
      icebergAligned,
      obDeltaAligned,
      rr: levels.rr,
    })

    const surgicalPlan = resolveSurgicalEntry({
      side,
      price: currentPrice,
      candles1m: ohlcv1m,
      candles5m: ohlcv5m,
      mmIntent,
      ote: ltf.ote,
      mss: ltf.mss,
      raid: ltf.raid,
      absorption: _absorption.detected ? _absorption : null,
      ltfChoCH: _ltfChoCH.detected ? _ltfChoCH : null,
      zoneTop: top,
      zoneBottom: bottom,
      previous: previousSurgical?.side === side ? previousSurgical : null,
      atr,
    })

    const preciseReady = isSurgicalReady(surgicalPlan)
    const hasMicroHunt = surgicalPlan.microTarget != null
    const setupActive =
      mode === 'STRICT' &&
      !rejected &&
      (hasMicroHunt ? preciseReady : true)

    if (hasMicroHunt && !preciseReady) {
      logger.info(
        `[PE] ${internalSymbol} surgical ${surgicalPlan.status}: ${surgicalPlan.reason}`
      )
    }

    const flat = toFlatSymbol(internalSymbol)
    const zones = [
      ...confluence.zones,
      ...cluster.notes,
      ...levels.notes,
      ...(rejected ? [`REJECT: ${rejected}`] : []),
      ...(newsSentimentBoost
        ? [`NEWS: ${newsSentimentBoost.toFixed(2)}`]
        : []),
      ...(marketCtxNotes ?? []).slice(0, 3).map((n) => `CTX: ${n}`),
      ...(divergence.type !== 'NONE'
        ? [`BTC_DIV: ${divergence.type}`]
        : []),
      `ENTRY: ${hasRejection ? 'REJECTION' : raidFresh ? 'RAID_ENTRY' : 'SURGICAL_LTF'}`,
      `SURGICAL: ${surgicalPlan.status}`,
    ]

    const signal: CoinSignal = {
      symbol: flat,
      internalSymbol,
      displayName: toDisplayName(internalSymbol),
      price: currentPrice,
      priceChange24h,
      currentRSI: rsi,
      probabilityPct: cluster.total,
      score: cluster.total / 10,
      direction: side,
      zones,
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
      hasActiveSetup: setupActive,
      activeSignal: {
        win_rate: cluster.total,
        samples: cluster.total / 10,
        direction: side,
        avg_return: 0,
      },
      activeSignalKey: `CLUSTER_${cluster.total}`,
      btcDivergence: divergence.type !== 'NONE' ? divergence : null,
      mss: ltf.mss,
      raid: ltf.raid,
      ote: ltf.ote,
      absorption: _absorption.detected ? _absorption : null,
      ltfChoCH: _ltfChoCH.detected ? _ltfChoCH : null,
      buyerAggression: null,
      mmIntent,
      sessionFlipReason: sessionFlip.reason || null,
      surgicalEntry: surgicalPlan,
      atrPct,
      rejected,
      globalFib: globalFib
        ? {
            impulse: globalFib.impulse,
            entryBias: globalFib.entryBias,
            activeLabel:
              globalFib.zone141?.label ?? globalFib.activeZone?.label ?? null,
            swingHigh: globalFib.swingHigh,
            swingLow: globalFib.swingLow,
            inReactionZone: globalFib.in141 || globalFib.near141,
            in141: globalFib.in141,
            near141: globalFib.near141,
            price141: globalFib.price141,
            mode: globalFib.mode,
          }
        : null,
    }

    return {
      signal: enrichSignal(signal, {
        ohlcv1h,
        ohlcv15m,
        ohlcv5m,
        ohlcv1m,
        ohlcv4h,
        liquidityMap,
        wallSupport:
          wallAligned ||
          (bookImbalance != null &&
            ((side === 'LONG' && bookImbalance > 15) ||
              (side === 'SHORT' && bookImbalance < -15))),
        bestZoneTop: top,
        bestZoneBottom: bottom,
        enhancedCvd,
        spoofAlerts,
        icebergAlerts,
        obDelta,
        sequence,
        htfTrend,
        regime,
        session,
      }),
      triggered: false, // replaced below after enrichment
    }
  }

  // Prefer session/MM liquidity hunt order; fib bias only if session not flipped
  const fibBias = globalFib?.entryBias
  let tryOrder: TradeSide[] = sessionFlip.tryOrder
  if (!sessionFlip.flipped && (fibBias === 'SHORT' || fibBias === 'LONG')) {
    tryOrder = [fibBias, fibBias === 'LONG' ? 'SHORT' : 'LONG']
  }

  let pending: AnalyzeSymbolResult | null = null

  for (const side of tryOrder) {
    if (side === 'LONG' && !longAllowedFinal) continue
    if (side === 'SHORT' && !shortAllowedFinal) continue
    const result = trySide(side, 'STRICT')
    if (!result) continue
    if (result.signal.hasActiveSetup) {
      return { signal: result.signal, triggered: true }
    }
    if (
      !pending ||
      (pending.signal.rejected != null && result.signal.rejected == null)
    ) {
      pending = result
    }
  }

  if (pending) {
    return { signal: pending.signal, triggered: false }
  }

  // No strict trigger — still show the best waiting plan on the radar.
  for (const side of tryOrder) {
    if (side === 'LONG' && !longAllowedFinal) continue
    if (side === 'SHORT' && !shortAllowedFinal) continue
    const result = trySide(side, 'SOFT')
    if (result) {
      return { signal: result.signal, triggered: false }
    }
  }

  return {
    signal: emptySignal(
      internalSymbol,
      currentPrice,
      priceChange24h,
      rsi,
      coinTrend,
      btcTrend,
      dailyBias,
      atrPct
    ),
    triggered: false,
  }
}
