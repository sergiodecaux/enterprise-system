import type { StructuralStyleLevels, StyleProfile } from './types'

export const SCALP_PROFILE: StyleProfile = {
  style: 'SCALP',
  label: 'Скальп',
  badge: 'SCALP',
  timeframeHint: 'M5',
  risk: {
    maxStopPct: 0.8,
    minStopPct: 0.08,
    tp1RMultiple: 1.5,
    tp2RMultiple: 2.5,
    horizonMinMinutes: 5,
    horizonMaxMinutes: 120,
  },
  weights: {
    structure: 0.2,
    orderFlow: 0.35,
    session: 0.1,
    htfBias: 0.1,
    liquidation: 0.25,
  },
  minScore: 5,
  minStrengthFilters: 2,
  minRiskReward: 2,
}

/**
 * Confidence Score для SCALP.
 * Приоритет: Liquidity Sweep + Tape/Absorption + CVD/Raid + микро-структура.
 */
export function calculateScalpConfidence(input: {
  freshSweep: boolean
  absorption: boolean
  tapeBurst: boolean
  cvdDivergence: boolean
  chochOrMss: boolean
  wallSupport: boolean
  liquidationSwept: boolean
}): { score: number; factors: string[]; quality: 'ELITE' | 'STRONG' | 'WEAK' } {
  const factors: string[] = []
  let raw = 0

  if (input.freshSweep) {
    raw += 22
    factors.push('Liquidity Sweep')
  }
  if (input.absorption) {
    raw += 18
    factors.push('Absorption')
  }
  if (input.tapeBurst) {
    raw += 16
    factors.push('Tape Momentum')
  }
  if (input.cvdDivergence) {
    raw += 14
    factors.push('CVD Divergence')
  }
  if (input.chochOrMss) {
    raw += 12
    factors.push('LTF Structure')
  }
  if (input.wallSupport) {
    raw += 10
    factors.push('Orderbook Wall')
  }
  if (input.liquidationSwept) {
    raw += 18
    factors.push('Liq Cluster Sweep')
  }

  const score = Math.min(Math.round(raw), 98)
  const quality =
    score >= 88 ? 'ELITE' : score >= 70 ? 'STRONG' : 'WEAK'

  return { score, factors, quality }
}

/**
 * Риск-модель скальпа: стоп за свип ± ATR-буфер, без клампа в 0.08–0.8%.
 * Слишком широкий структурный стоп отклоняет сетап.
 */
export function buildScalpLevels(
  side: 'LONG' | 'SHORT',
  entry: number,
  sweepLevel: number | null,
  nearestImbalance: number | null,
  atr: number
): StructuralStyleLevels {
  const { maxStopPct, tp1RMultiple, tp2RMultiple } = SCALP_PROFILE.risk
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

  const microAtr = atr * 0.35
  const hasSweep =
    sweepLevel != null && Number.isFinite(sweepLevel) && sweepLevel > 0
  const sl = hasSweep
    ? side === 'LONG'
      ? sweepLevel * 0.9985
      : sweepLevel * 1.0015
    : side === 'LONG'
      ? entry - microAtr
      : entry + microAtr

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
      notes: ['Цена уже за свипом'],
    }
  }

  const risk = Math.abs(entry - sl)
  const riskPct = (risk / entry) * 100
  notes.push(
    hasSweep
      ? `SL: свип + буфер (${riskPct.toFixed(2)}%)`
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

  const realTarget =
    nearestImbalance != null &&
    Number.isFinite(nearestImbalance) &&
    (side === 'LONG' ? nearestImbalance > entry : nearestImbalance < entry)
      ? nearestImbalance
      : null
  const tp1 =
    realTarget ??
    (side === 'LONG'
      ? entry + risk * tp1RMultiple
      : entry - risk * tp1RMultiple)
  const tp2ByR =
    side === 'LONG'
      ? entry + risk * tp2RMultiple
      : entry - risk * tp2RMultiple
  const tp2 =
    side === 'LONG'
      ? Math.max(tp2ByR, tp1 + risk * 0.25)
      : Math.min(tp2ByR, tp1 - risk * 0.25)

  const tpPct = (Math.abs(tp1 - entry) / entry) * 100
  const rr = riskPct > 0 ? tpPct / riskPct : 0
  const ok = rr >= SCALP_PROFILE.minRiskReward
  notes.push(
    `${realTarget != null ? 'TP1: имбаланс' : 'TP1: R-model'} · ${rr.toFixed(2)}R`
  )

  return {
    sl,
    tp1,
    tp2,
    tpDaily: null,
    riskPct,
    rr,
    ok,
    rejectReason: ok ? undefined : 'RR_TOO_LOW',
    notes,
  }
}
