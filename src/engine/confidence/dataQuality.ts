import type { EnhancedCvdSnapshot } from '../orderflow/enhancedCvd'
import type { ObDeltaSnapshot } from '../orderbook/obDelta'
import type { SpoofAlert } from '../mm/spoofing'
import type { IcebergResult } from '../mm/iceberg'

export type DataQualityLevel = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR'

export interface DataQualityReport {
  overall: DataQualityLevel
  overallScore: number
  cvd: {
    quality: DataQualityLevel
    source: 'TRADES' | 'OHLCV_PROXY' | 'NONE'
    tradeCount: number
    confidence: number
    penalty: number
  }
  marketMaker: {
    quality: DataQualityLevel
    spoofFreshness: number
    icebergConfidence: number
    obDeltaAge: number
    penalty: number
  }
  orderbook: {
    quality: DataQualityLevel
    dataAge: number
    hasDelta: boolean
    penalty: number
  }
  penalties: string[]
  warnings: string[]
  timestamp: number
}

export type SpoofAlertWithAge = SpoofAlert & { updatedAt?: number }
export type IcebergWithAge = IcebergResult & { updatedAt?: number }

export interface DataQualityInput {
  enhancedCvd?: EnhancedCvdSnapshot | null
  spoofAlerts?: SpoofAlertWithAge[] | null
  icebergAlerts?: IcebergWithAge[] | null
  obDelta?: ObDeltaSnapshot | null
  /** ms since last OB metrics update */
  obMetricsAge?: number
}

const STALE_THRESHOLD_MS = 10_000
const CRITICAL_STALE_MS = 30_000

function ageOf(ts: number | undefined, now: number): number {
  if (ts == null || ts <= 0) return 0 // unknown → treat as fresh
  return Math.max(0, now - ts)
}

/**
 * Assesses input-data quality for ScoreCard. Penalties subtract from totalScore.
 */
export function assessDataQuality(input: DataQualityInput): DataQualityReport {
  const now = Date.now()
  const penalties: string[] = []
  const warnings: string[] = []

  let cvdQuality: DataQualityLevel = 'POOR'
  let cvdConfidence = 0
  let cvdPenalty = 0
  let cvdSource: 'TRADES' | 'OHLCV_PROXY' | 'NONE' = 'NONE'
  let tradeCount = 0

  if (!input.enhancedCvd) {
    cvdQuality = 'POOR'
    cvdPenalty = 2
    penalties.push('CVD отсутствует')
  } else {
    cvdSource = input.enhancedCvd.source
    tradeCount = input.enhancedCvd.tradeCount

    if (cvdSource === 'TRADES') {
      if (tradeCount >= 50) {
        cvdQuality = 'EXCELLENT'
        cvdConfidence = 100
      } else if (tradeCount >= 25) {
        cvdQuality = 'GOOD'
        cvdConfidence = 85
        warnings.push(`CVD: мало сделок (${tradeCount}, норма ≥50)`)
      } else if (tradeCount >= 10) {
        cvdQuality = 'FAIR'
        cvdConfidence = 65
        cvdPenalty = 1
        penalties.push(`CVD: очень мало сделок (${tradeCount})`)
      } else {
        cvdQuality = 'POOR'
        cvdConfidence = 40
        cvdPenalty = 1.5
        penalties.push(`CVD: критично мало сделок (${tradeCount})`)
      }
    } else {
      cvdQuality = 'FAIR'
      cvdConfidence = 50
      cvdPenalty = 1
      penalties.push('CVD: OHLCV proxy (не точный)')
    }

    const cvdAge = ageOf(input.enhancedCvd.updatedAt, now)
    if (cvdAge > CRITICAL_STALE_MS) {
      cvdPenalty += 1
      penalties.push(`CVD устарел (${(cvdAge / 1000).toFixed(0)}s)`)
    } else if (cvdAge > STALE_THRESHOLD_MS) {
      warnings.push(`CVD старый (${(cvdAge / 1000).toFixed(0)}s)`)
    }
  }

  let mmQuality: DataQualityLevel = 'FAIR'
  let spoofFreshness = 0
  let icebergConfidence = 0
  let obDeltaAge = 999_999
  let mmPenalty = 0

  const spoofAlerts = input.spoofAlerts ?? []
  const freshSpoof = spoofAlerts.filter(
    (s) => s.detected && ageOf(s.updatedAt, now) < 15_000
  )

  if (freshSpoof.length > 0) {
    spoofFreshness = 100
    mmQuality = 'EXCELLENT'
  } else if (spoofAlerts.some((s) => s.detected)) {
    const ages = spoofAlerts
      .filter((s) => s.detected)
      .map((s) => ageOf(s.updatedAt, now))
    const oldestAge = Math.min(...ages)
    spoofFreshness = Math.max(0, 100 - oldestAge / 300)
    if (oldestAge > CRITICAL_STALE_MS) {
      mmPenalty += 0.5
      warnings.push(`Spoof alerts устарели (${(oldestAge / 1000).toFixed(0)}s)`)
    }
    mmQuality = spoofFreshness > 60 ? 'GOOD' : 'FAIR'
  }

  const icebergAlerts = input.icebergAlerts ?? []
  const detectedIcebergs = icebergAlerts.filter((i) => i.detected)
  if (detectedIcebergs.length > 0) {
    icebergConfidence = Math.min(
      100,
      detectedIcebergs.reduce((sum, i) => sum + (i.bounceProbPct ?? 70), 0) /
        detectedIcebergs.length
    )
    if (icebergConfidence >= 80) mmQuality = 'EXCELLENT'
  }

  if (input.obDelta) {
    obDeltaAge = ageOf(input.obDelta.updatedAt, now)
    if (obDeltaAge > CRITICAL_STALE_MS) {
      mmPenalty += 1
      penalties.push(`OB Delta устарел (${(obDeltaAge / 1000).toFixed(0)}s)`)
      mmQuality = 'POOR'
    } else if (obDeltaAge > STALE_THRESHOLD_MS) {
      warnings.push(`OB Delta старый (${(obDeltaAge / 1000).toFixed(0)}s)`)
      if (mmQuality === 'EXCELLENT') mmQuality = 'GOOD'
    }
  } else {
    mmPenalty += 0.5
    warnings.push('OB Delta отсутствует')
  }

  let obQuality: DataQualityLevel = 'GOOD'
  let obPenalty = 0
  const obAge = input.obMetricsAge ?? 5_000

  if (obAge > CRITICAL_STALE_MS) {
    obQuality = 'POOR'
    obPenalty = 1.5
    penalties.push(`OrderBook критично старый (${(obAge / 1000).toFixed(0)}s)`)
  } else if (obAge > STALE_THRESHOLD_MS) {
    obQuality = 'FAIR'
    obPenalty = 0.5
    warnings.push(`OrderBook старый (${(obAge / 1000).toFixed(0)}s)`)
  } else if (obAge > 5_000) {
    obQuality = 'GOOD'
  } else {
    obQuality = 'EXCELLENT'
  }

  const totalPenalty = cvdPenalty + mmPenalty + obPenalty
  const overallScore = Math.max(0, Math.round(100 - totalPenalty * 10))

  let overall: DataQualityLevel
  if (overallScore >= 90) overall = 'EXCELLENT'
  else if (overallScore >= 70) overall = 'GOOD'
  else if (overallScore >= 50) overall = 'FAIR'
  else overall = 'POOR'

  return {
    overall,
    overallScore,
    cvd: {
      quality: cvdQuality,
      source: cvdSource,
      tradeCount,
      confidence: cvdConfidence,
      penalty: cvdPenalty,
    },
    marketMaker: {
      quality: mmQuality,
      spoofFreshness,
      icebergConfidence,
      obDeltaAge,
      penalty: mmPenalty,
    },
    orderbook: {
      quality: obQuality,
      dataAge: obAge,
      hasDelta: !!input.obDelta,
      penalty: obPenalty,
    },
    penalties,
    warnings,
    timestamp: now,
  }
}

export function meetsMinimumDataQuality(
  report: DataQualityReport,
  strictMode = false
): { ok: boolean; reason?: string } {
  if (strictMode) {
    if (report.cvd.quality === 'POOR') {
      return { ok: false, reason: 'CVD качество POOR' }
    }
    if (report.orderbook.quality === 'POOR') {
      return { ok: false, reason: 'OrderBook качество POOR' }
    }
    if (report.overall === 'POOR') {
      return { ok: false, reason: 'Общее качество данных POOR' }
    }
  }

  if (report.overallScore < 40) {
    return {
      ok: false,
      reason: `Данные слишком низкого качества (${report.overallScore}/100)`,
    }
  }

  return { ok: true }
}

/** Compact snapshot for CoinSignal / Telegram */
export function toDataQualitySnapshot(
  report: DataQualityReport
): DataQualitySnapshot {
  return {
    overall: report.overall,
    overallScore: report.overallScore,
    cvdQuality: report.cvd.quality,
    cvdSource: report.cvd.source,
    penalties: report.penalties.slice(0, 4),
    warnings: report.warnings.slice(0, 4),
  }
}

export interface DataQualitySnapshot {
  overall: DataQualityLevel
  overallScore: number
  cvdQuality: DataQualityLevel
  cvdSource: 'TRADES' | 'OHLCV_PROXY' | 'NONE'
  penalties: string[]
  warnings: string[]
}
