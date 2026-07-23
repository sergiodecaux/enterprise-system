import type { TradeStyle } from '../types'
import type { HtfTrendSnapshot } from '../types'
import type { MmIntentSnapshot } from '../types'
import type { LiquidityRaidResult } from '../types'
import type { MarketRegime } from '../regime/marketRegime'
import type { SessionQuality } from '../sessions/sessionQuality'
import type { EnhancedCvdSnapshot } from '../orderflow/enhancedCvd'
import type { ObDeltaSnapshot } from '../orderbook/obDelta'
import type { SpoofAlert } from '../mm/spoofing'
import type { IcebergResult } from '../mm/iceberg'
import {
  assessDataQuality,
  meetsMinimumDataQuality,
  toDataQualitySnapshot,
  type DataQualityReport,
  type DataQualitySnapshot,
  type SpoofAlertWithAge,
  type IcebergWithAge,
} from '../confidence/dataQuality'

export type ScoreGrade = 'A+' | 'A' | 'B' | 'SKIP'

export interface ScoreFactor {
  score: number
  max: number
  passed: boolean
  reason: string
}

export interface ScoreCardFactors {
  htfStructure: ScoreFactor
  mmIntent: ScoreFactor
  orderflow: ScoreFactor
  liquiditySweep: ScoreFactor
  obFvgEntry: ScoreFactor
  session: ScoreFactor
  regime: ScoreFactor
  rrQuality: ScoreFactor
}

export interface ScoreCard {
  symbol: string
  direction: 'LONG' | 'SHORT'
  style: TradeStyle
  factors: ScoreCardFactors
  totalScore: number
  maxScore: number
  percent: number
  grade: ScoreGrade
  ready: boolean
  missingFactors: string[]
  dataQuality?: DataQualityReport
  dataQualitySnapshot?: DataQualitySnapshot
}

export interface ScoreCardInput {
  symbol?: string
  direction: 'LONG' | 'SHORT'
  style: TradeStyle
  htfTrend?: HtfTrendSnapshot | null
  mmIntent?: MmIntentSnapshot | null
  spoofAlerts?: (SpoofAlert | SpoofAlertWithAge)[] | null
  icebergAlerts?: (IcebergResult | IcebergWithAge)[] | null
  enhancedCvd?: EnhancedCvdSnapshot | null
  obDelta?: ObDeltaSnapshot | null
  raid?: LiquidityRaidResult | null
  inOrderBlock?: boolean
  inFvg?: boolean
  hasBestZone?: boolean
  regime: MarketRegime
  session: SessionQuality
  entry: number
  stopLoss: number
  takeProfit: number
  /** Override OB age ms (default from obDelta.updatedAt) */
  obMetricsAge?: number
}

const THRESHOLDS: Record<
  TradeStyle,
  { A_plus: number; A: number; B: number }
> = {
  SCALP: { A_plus: 11, A: 9, B: 7 },
  INTRADAY: { A_plus: 10, A: 8, B: 6 },
  SWING: { A_plus: 9, A: 7, B: 5 },
}

function factor(
  score: number,
  max: number,
  reason: string,
  passAt = 1
): ScoreFactor {
  const s = Math.max(0, Math.min(max, score))
  return { score: s, max, passed: s >= passAt, reason }
}

function emptyFactors(reason: string): ScoreCardFactors {
  const z = (r: string) => factor(0, 1, r)
  return {
    htfStructure: factor(0, 2, reason),
    mmIntent: factor(0, 2, reason),
    orderflow: factor(0, 2, reason),
    liquiditySweep: z(reason),
    obFvgEntry: z(reason),
    session: z(reason),
    regime: z(reason),
    rrQuality: z(reason),
  }
}

/**
 * Strict 8-factor / 12-point ScoreCard + Data Quality gates.
 * Only A+/A → ready signal.
 */
export function buildScoreCard(input: ScoreCardInput): ScoreCard {
  const dir = input.direction
  const style = input.style

  const dataQuality = assessDataQuality({
    enhancedCvd: input.enhancedCvd,
    spoofAlerts: input.spoofAlerts as SpoofAlertWithAge[] | null,
    icebergAlerts: input.icebergAlerts as IcebergWithAge[] | null,
    obDelta: input.obDelta,
    obMetricsAge:
      input.obMetricsAge ??
      (input.obDelta
        ? Date.now() - input.obDelta.updatedAt
        : undefined),
  })
  const dqSnap = toDataQualitySnapshot(dataQuality)

  const qualityCheck = meetsMinimumDataQuality(
    dataQuality,
    style === 'SCALP'
  )
  if (!qualityCheck.ok) {
    return {
      symbol: input.symbol ?? '',
      direction: dir,
      style,
      factors: emptyFactors(qualityCheck.reason ?? 'Data quality fail'),
      totalScore: 0,
      maxScore: 12,
      percent: 0,
      grade: 'SKIP',
      ready: false,
      missingFactors: [
        qualityCheck.reason ?? 'Data quality fail',
        ...dataQuality.penalties,
      ],
      dataQuality,
      dataQualitySnapshot: dqSnap,
    }
  }

  // ── 1. HTF Structure (0–2) ─────────────────────────────────────────────
  const htf = input.htfTrend
  let htfScore = 0
  let htfReason = '⚠️ HTF unavailable'
  if (htf) {
    const aligned4 =
      (dir === 'LONG' && htf.bias4h === 'BULLISH') ||
      (dir === 'SHORT' && htf.bias4h === 'BEARISH')
    const aligned1 =
      (dir === 'LONG' && htf.bias1h === 'BULLISH') ||
      (dir === 'SHORT' && htf.bias1h === 'BEARISH')
    if (aligned4 && aligned1) {
      htfScore = 2
      htfReason = `✅ 4H+1H aligned ${dir === 'LONG' ? 'BULLISH' : 'BEARISH'}`
    } else if (aligned4 || aligned1) {
      htfScore = 1
      htfReason = aligned4
        ? `⚠️ 4H aligned, 1H mixed`
        : `⚠️ 1H aligned, 4H counter-trend`
    } else {
      htfScore = 0
      htfReason =
        style === 'SWING'
          ? `❌ Against HTF — bad for SWING`
          : `⚠️ Counter-trend (needs extra confirmation)`
    }
  }

  // ── 2. MM Intent (0–2) + spoof freshness ───────────────────────────────
  const mm = input.mmIntent
  let mmScore = 0
  let mmReason = '❌ MM neutral / unavailable'
  const spoofN = (input.spoofAlerts ?? []).filter((s) => s.detected).length
  const iceN = (input.icebergAlerts ?? []).filter((i) => i.detected).length

  if (mm) {
    const aligned = mm.preferredSide === dir
    const strong = mm.confidence >= 70
    if (aligned && strong) {
      mmScore = 2
      mmReason = `✅ MM strongly aligned (conf ${mm.confidence})`
    } else if (aligned) {
      mmScore = 1
      mmReason = `⚠️ MM weakly aligned (conf ${mm.confidence})`
    } else if (mm.preferredSide == null && mm.drive !== 'NEUTRAL') {
      const driveAligned =
        (dir === 'LONG' && mm.drive === 'UP') ||
        (dir === 'SHORT' && mm.drive === 'DOWN')
      if (driveAligned) {
        mmScore = 1
        mmReason = `⚠️ MM drive ${mm.drive} (no preferred yet)`
      } else {
        mmReason = `❌ MM against (${mm.label})`
      }
    } else {
      mmReason = `❌ MM against / neutral (${mm.label})`
    }
  }

  if (spoofN > 0 && mmScore < 2) {
    if (dataQuality.marketMaker.spoofFreshness >= 80) {
      mmScore = Math.min(mmScore + 1, 2)
      mmReason += ` + spoof×${spoofN}`
    } else if (dataQuality.marketMaker.spoofFreshness >= 40) {
      mmScore = Math.min(mmScore + 0.5, 2)
      mmReason += ` + spoof×${spoofN} (stale)`
    } else {
      mmReason += ` (spoof×${spoofN} too old)`
    }
  }
  if (iceN > 0 && mmScore < 2) {
    mmScore = Math.min(mmScore + 1, 2)
    mmReason += ` + iceberg×${iceN}`
  }

  // ── 3. Orderflow / CVD (0–2) + quality penalty ─────────────────────────
  const cvd = input.enhancedCvd
  let ofScore = 0
  let ofReason = '❌ CVD unavailable'
  if (cvd) {
    const cvdAligned =
      (dir === 'LONG' && cvd.trend === 'BULLISH') ||
      (dir === 'SHORT' && cvd.trend === 'BEARISH')
    const aggressionAligned =
      (dir === 'LONG' && cvd.aggression >= 58) ||
      (dir === 'SHORT' && cvd.aggression <= 42)
    const divOk =
      cvd.divergence &&
      ((dir === 'LONG' && cvd.divergenceType === 'BULLISH') ||
        (dir === 'SHORT' && cvd.divergenceType === 'BEARISH'))

    if ((cvdAligned && aggressionAligned) || divOk) {
      ofScore = 2
      ofReason = divOk
        ? `✅ CVD divergence ${cvd.divergenceType}`
        : `✅ CVD + aggression (${cvd.aggression.toFixed(0)}% buys, ${cvd.source})`
    } else if (cvdAligned || aggressionAligned) {
      ofScore = 1
      ofReason = `⚠️ Partial orderflow (${cvd.source})`
    } else {
      ofScore = 0
      ofReason = `❌ CVD/aggression against (${cvd.source})`
    }

    if (dataQuality.cvd.quality === 'POOR' && ofScore > 0) {
      ofScore = Math.max(0, ofScore - 1)
      ofReason += ' [CVD качество низкое]'
    } else if (dataQuality.cvd.quality === 'FAIR' && ofScore > 1) {
      ofScore = Math.max(1, ofScore - 0.5)
      ofReason += ' [CVD OHLCV proxy]'
    }
  }

  // ── 4. Liquidity Sweep (0–1) ───────────────────────────────────────────
  const raid = input.raid
  let liqScore = 0
  let liqReason = '❌ No liquidity sweep'
  const swept =
    raid &&
    raid.isFresh &&
    raid.type !== 'NONE' &&
    ((dir === 'LONG' && raid.type === 'BULL_SWEEP') ||
      (dir === 'SHORT' && raid.type === 'BEAR_SWEEP'))
  if (swept) {
    liqScore = 1
    liqReason = `✅ ${raid!.type} fresh`
  } else {
    const shift = input.obDelta?.volumeShift
    if (
      (dir === 'LONG' && shift === 'BUYING') ||
      (dir === 'SHORT' && shift === 'SELLING')
    ) {
      liqScore = 1
      liqReason = `✅ OB delta ${shift}`
    }
  }

  // ── 5. OB + FVG entry (0–1) ────────────────────────────────────────────
  let obScore = 0
  let obReason = '❌ Entry not in OB/FVG'
  if (input.inOrderBlock && input.inFvg) {
    obScore = 1
    obReason = '✅ OB + FVG confluence'
  } else if (input.inOrderBlock || input.inFvg || input.hasBestZone) {
    obScore = 1
    obReason = input.inOrderBlock
      ? '✅ Entry in Order Block'
      : input.inFvg
        ? '✅ Entry in FVG'
        : '✅ Entry in confluence zone'
  }

  // ── 6. Session (0–1) ───────────────────────────────────────────────────
  const sess = input.session
  let sessionScore = 0
  let sessionReason = `❌ ${sess.session} low liquidity`
  if (sess.score >= 80) {
    sessionScore = 1
    sessionReason = `✅ ${sess.session} peak liquidity`
  } else if (sess.score >= 50) {
    sessionScore = style === 'SCALP' ? 0 : 1
    sessionReason =
      style === 'SCALP'
        ? `⚠️ ${sess.session} weak for SCALP`
        : `⚠️ ${sess.session} ok for ${style}`
  }

  // ── 7. Regime (0–1) ────────────────────────────────────────────────────
  let regimeScore = 0
  let regimeReason = `⚠️ ${input.regime}`
  if (input.regime === 'TRENDING_STRONG') {
    regimeScore = 1
    regimeReason = '✅ Strong trend'
  } else if (input.regime === 'TRENDING_WEAK') {
    regimeScore = 1
    regimeReason = '⚠️ Weak trend'
  } else if (input.regime === 'RANGING') {
    regimeScore = 1
    regimeReason = '✅ Range — bounce/mean-revert ok'
  } else if (input.regime === 'VOLATILE_CHOP') {
    regimeScore = 0
    regimeReason = '❌ Choppy — skip / scalp only with care'
  }

  // ── 8. R:R Quality (0–1) ───────────────────────────────────────────────
  const entry = input.entry
  const sl = input.stopLoss
  const tp = input.takeProfit
  let rrScore = 0
  let rrReason = '❌ Invalid levels'
  if (entry > 0 && sl > 0 && tp > 0) {
    const riskDist = Math.abs(entry - sl) / entry
    const rewardDist = Math.abs(tp - entry) / entry
    const rr = rewardDist / (riskDist || 0.001)
    const minRR = { SCALP: 2, INTRADAY: 2.5, SWING: 3 }[style]
    if (rr >= minRR && riskDist < 0.025) {
      rrScore = 1
      rrReason = `✅ R:R ${rr.toFixed(1)}:1 (min ${minRR}), SL ${(riskDist * 100).toFixed(2)}%`
    } else if (rr >= minRR * 0.8) {
      rrScore = 0
      rrReason = `⚠️ R:R ${rr.toFixed(1)}:1 below min ${minRR}`
    } else {
      rrScore = 0
      rrReason = `❌ R:R ${rr.toFixed(1)}:1 too low`
    }
  }

  const factors: ScoreCardFactors = {
    htfStructure: factor(htfScore, 2, htfReason),
    mmIntent: factor(mmScore, 2, mmReason),
    orderflow: factor(ofScore, 2, ofReason),
    liquiditySweep: factor(liqScore, 1, liqReason, 1),
    obFvgEntry: factor(obScore, 1, obReason, 1),
    session: factor(sessionScore, 1, sessionReason, 1),
    regime: factor(regimeScore, 1, regimeReason, 1),
    rrQuality: factor(rrScore, 1, rrReason, 1),
  }

  let totalScore = Object.values(factors).reduce((s, f) => s + f.score, 0)
  const qualityPenalty = Math.round(
    dataQuality.cvd.penalty +
      dataQuality.marketMaker.penalty +
      dataQuality.orderbook.penalty
  )
  totalScore = Math.max(0, totalScore - qualityPenalty)

  const maxScore = 12
  const percent = Math.round((totalScore / maxScore) * 100)
  const t = THRESHOLDS[style]

  let grade: ScoreGrade
  if (totalScore >= t.A_plus) grade = 'A+'
  else if (totalScore >= t.A) grade = 'A'
  else if (totalScore >= t.B) grade = 'B'
  else grade = 'SKIP'

  const hardBlocked =
    factors.rrQuality.score === 0 ||
    (style === 'SCALP' && input.regime === 'VOLATILE_CHOP') ||
    dataQuality.overall === 'POOR'

  if (hardBlocked) grade = 'SKIP'

  const ready = (grade === 'A+' || grade === 'A') && !hardBlocked

  const missingFactors = [
    ...Object.entries(factors)
      .filter(([, f]) => !f.passed)
      .map(([name, f]) => `${name}: ${f.reason}`),
    ...dataQuality.penalties,
  ]
  if (dataQuality.warnings.length > 0 && grade !== 'SKIP') {
    missingFactors.push(...dataQuality.warnings)
  }
  if (qualityPenalty > 0) {
    missingFactors.push(
      `Data quality penalty: −${qualityPenalty} (${dataQuality.overallScore}/100)`
    )
  }

  return {
    symbol: input.symbol ?? '',
    direction: dir,
    style,
    factors,
    totalScore,
    maxScore,
    percent,
    grade,
    ready,
    missingFactors,
    dataQuality,
    dataQualitySnapshot: dqSnap,
  }
}
