import { getSessionAtHour } from '../sessions/sessionMap'
import type { StyleProfile } from './types'

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
 * Риск-модель интрадея: широкий стоп за структуру, каскадные тейки.
 */
export function buildIntradayLevels(
  side: 'LONG' | 'SHORT',
  entry: number,
  structuralExtreme: number | null,
  localSwing: number | null,
  dailyTarget: number | null,
  atr: number
): { sl: number; tp1: number; tp2: number; tpDaily: number | null } {
  const { maxStopPct, minStopPct, tp1RMultiple, tp2RMultiple } =
    INTRADAY_PROFILE.risk
  const structBuffer = atr * 0.15

  let sl: number
  if (side === 'LONG') {
    const structSl =
      structuralExtreme != null
        ? structuralExtreme - structBuffer
        : entry - atr * 1.2
    sl = Math.min(structSl, entry * (1 - minStopPct / 100))
    const maxSl = entry * (1 - maxStopPct / 100)
    if (sl < maxSl) sl = maxSl
  } else {
    const structSl =
      structuralExtreme != null
        ? structuralExtreme + structBuffer
        : entry + atr * 1.2
    sl = Math.max(structSl, entry * (1 + minStopPct / 100))
    const maxSl = entry * (1 + maxStopPct / 100)
    if (sl > maxSl) sl = maxSl
  }

  const risk = Math.abs(entry - sl)
  let tp1 =
    side === 'LONG' ? entry + risk * tp1RMultiple : entry - risk * tp1RMultiple
  let tp2 =
    side === 'LONG' ? entry + risk * tp2RMultiple : entry - risk * tp2RMultiple

  if (localSwing != null) {
    if (side === 'LONG' && localSwing > entry) tp1 = localSwing
    if (side === 'SHORT' && localSwing < entry) tp1 = localSwing
  }

  let tpDaily: number | null = dailyTarget
  if (dailyTarget != null) {
    if (side === 'LONG' && dailyTarget <= entry) tpDaily = null
    else if (side === 'SHORT' && dailyTarget >= entry) tpDaily = null
    else tpDaily = dailyTarget
  }

  return { sl, tp1, tp2, tpDaily }
}
