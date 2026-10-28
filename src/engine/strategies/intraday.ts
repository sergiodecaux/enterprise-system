import { getSessionAtHour } from '../sessions/sessionMap'
import type { StructuralStyleLevels, StyleProfile } from './types'

export const INTRADAY_PROFILE: StyleProfile = {
  style: 'INTRADAY',
  label: 'Интрадей',
  badge: '🎯 INTRADAY',
  timeframeHint: 'H1',
  risk: {
    maxStopPct: 2.5,
    minStopPct: 0.35,
    tp1RMultiple: 2,
    tp2RMultiple: 3.5,
    horizonMinMinutes: 240,
    horizonMaxMinutes: 1440,
  },
  weights: {
    structure: 0.3,
    orderFlow: 0.1,
    session: 0.2,
    htfBias: 0.25,
    liquidation: 0.15,
  },
  minScore: 5,
  minStrengthFilters: 2,
  minRiskReward: 3,
}

/** Killzone: London / NY / Overlap — активные сессии для интрадея */
export function isKillzoneActive(nowMs: number = Date.now()): {
  active: boolean
  session: string
  label: string
} {
  const hour = new Date(nowMs).getUTCHours()
  const session = getSessionAtHour(hour)
  const active =
    session === 'LONDON' || session === 'NEW_YORK' || session === 'OVERLAP'

  const labels: Record<string, string> = {
    LONDON: 'London Killzone',
    NEW_YORK: 'NY Killzone',
    OVERLAP: 'London/NY Overlap',
    ASIA: 'Asia (вне killzone)',
    CLOSED: 'Closed',
  }

  return {
    active,
    session,
    label: labels[session] ?? session,
  }
}

/**
 * Confidence Score для INTRADAY.
 * Приоритет: Daily Bias + 4H Trend + 15m CHoCH + Killzone + HTF OB.
 */
export function calculateIntradayConfidence(input: {
  dailyBiasAligned: boolean
  h4TrendAligned: boolean
  ltfChoCH: boolean
  killzoneActive: boolean
  inHtfOrderBlock: boolean
  oteInZone: boolean
  pocConfluence: boolean
  liquidationSwept: boolean
}): { score: number; factors: string[]; quality: 'ELITE' | 'STRONG' | 'WEAK' } {
  const factors: string[] = []
  let raw = 0

  if (input.dailyBiasAligned) {
    raw += 18
    factors.push('Daily Bias')
  }
  if (input.h4TrendAligned) {
    raw += 16
    factors.push('4H Trend')
  }
  if (input.ltfChoCH) {
    raw += 16
    factors.push('15m/LTF CHoCH')
  }
  if (input.killzoneActive) {
    raw += 14
    factors.push('Killzone Alignment')
  }
  if (input.inHtfOrderBlock) {
    raw += 14
    factors.push('HTF Order Block')
  }
  if (input.oteInZone) {
    raw += 10
    factors.push('OTE Zone')
  }
  if (input.pocConfluence) {
    raw += 12
    factors.push('OB ∩ POC')
  }
  if (input.liquidationSwept) {
    raw += 12
    factors.push('Liq Sweep Confirmed')
  }

  const score = Math.min(Math.round(raw), 98)
  const quality =
    score >= 88 ? 'ELITE' : score >= 70 ? 'STRONG' : 'WEAK'

  return { score, factors, quality }
}

/**
 * Риск-модель интрадея: стоп за структурой ± 0.5×ATR, без клампа в
 * 0.35–2.5%. Слишком широкий структурный стоп отклоняет сетап.
 */
export function buildIntradayLevels(
  side: 'LONG' | 'SHORT',
  entry: number,
  structuralExtreme: number | null,
  localSwing: number | null,
  dailyTarget: number | null,
  atr: number
): StructuralStyleLevels {
  const { maxStopPct, tp1RMultiple, tp2RMultiple } = INTRADAY_PROFILE.risk
  const notes: string[] = []
  if (!(entry > 0) || !(atr > 0)) {
    return {
      sl: 0,
      tp1: 0,
      tp2: 0,
      tpDaily: null,
      riskPct: 0,
      rr: 0,
      ok: false,
      rejectReason: 'INVALID_STRUCTURE',
      notes: ['ENTRY/ATR invalid'],
    }
  }

  const buffer = atr * 0.5
  const hasStructure =
    structuralExtreme != null &&
    Number.isFinite(structuralExtreme) &&
    structuralExtreme > 0
  const structSl = hasStructure
    ? side === 'LONG'
      ? structuralExtreme - buffer
      : structuralExtreme + buffer
    : side === 'LONG'
      ? entry - atr * 1.2
      : entry + atr * 1.2
  const sl = structSl

  if (side === 'LONG' ? sl >= entry : sl <= entry) {
    return {
      sl,
      tp1: 0,
      tp2: 0,
      tpDaily: null,
      riskPct: 0,
      rr: 0,
      ok: false,
      rejectReason: 'INVALID_STRUCTURE',
      notes: ['Цена уже за структурной инвалидацией'],
    }
  }

  const risk = Math.abs(entry - sl)
  const riskPct = (risk / entry) * 100
  notes.push(
    hasStructure
      ? `SL: структура ±0.5 ATR (${riskPct.toFixed(2)}%)`
      : `SL: ATR fallback (${riskPct.toFixed(2)}%)`
  )

  if (riskPct > maxStopPct) {
    return {
      sl,
      tp1: 0,
      tp2: 0,
      tpDaily: null,
      riskPct,
      rr: 0,
      ok: false,
      rejectReason: 'RISK_EXCEEDED',
      notes: [...notes, `RISK ${riskPct.toFixed(2)}% > ${maxStopPct}%`],
    }
  }

  // Real local structure wins; otherwise an R-multiple model target.
  const localTp =
    localSwing != null &&
    Number.isFinite(localSwing) &&
    (side === 'LONG' ? localSwing > entry : localSwing < entry)
      ? localSwing
      : null
  const tp1 =
    localTp ??
    (side === 'LONG'
      ? entry + risk * tp1RMultiple
      : entry - risk * tp1RMultiple)
  const tp2ByR =
    side === 'LONG'
      ? entry + risk * tp2RMultiple
      : entry - risk * tp2RMultiple
  const tp2 =
    side === 'LONG'
      ? Math.max(tp2ByR, tp1 + risk * 0.5)
      : Math.min(tp2ByR, tp1 - risk * 0.5)

  const tpPct = (Math.abs(tp1 - entry) / entry) * 100
  const rr = riskPct > 0 ? tpPct / riskPct : 0
  const ok = rr >= INTRADAY_PROFILE.minRiskReward
  notes.push(
    `${localTp != null ? 'TP1: локальный swing' : 'TP1: R-model'} · ${rr.toFixed(2)}R`
  )

  let tpDaily: number | null = dailyTarget
  if (dailyTarget != null) {
    if (side === 'LONG' && dailyTarget <= entry) tpDaily = null
    else if (side === 'SHORT' && dailyTarget >= entry) tpDaily = null
  }

  return {
    sl,
    tp1,
    tp2,
    tpDaily,
    riskPct,
    rr,
    ok,
    rejectReason: ok ? undefined : 'RR_TOO_LOW',
    notes,
  }
}
