import { getFrames } from './frameBus'
import { isSequenceAllowedInRegime, regimeConfidenceMul } from './regimeGate'
import type { SequenceEvalContext, SequenceHit } from './types'

const TTL_MS = 90_000

/**
 * OI rising with price + delta aligned → fresh money, impulse continuation.
 */
export function detectOiDeltaConfirm(
  ctx: SequenceEvalContext
): SequenceHit | null {
  const now = ctx.now ?? Date.now()
  const oi = ctx.oi
  if (!oi || oi.samples < 3) return null
  if (!oi.confirmsMove && Math.abs(oi.changePct) < 0.6) return null

  const aggr = ctx.aggressionBuyPct ?? 50
  const cvd = ctx.cumulativeDelta ?? 0

  let side: 'LONG' | 'SHORT' | null = null
  if (oi.priceChangePct > 0.12 && oi.changePct > 0.4 && (aggr >= 54 || cvd > 0)) {
    side = 'LONG'
  } else if (
    oi.priceChangePct < -0.12 &&
    oi.changePct < -0.4 &&
    (aggr <= 46 || cvd < 0)
  ) {
    // OI falling with price falling can be long unwind — weaker
    side = 'SHORT'
  } else if (
    oi.priceChangePct < -0.12 &&
    oi.changePct > 0.5 &&
    aggr <= 45
  ) {
    // New shorts building into dump
    side = 'SHORT'
  }

  if (!side) return null
  if (oi.divergenceType === 'DISTRIBUTION' && side === 'LONG') return null

  const frames = getFrames(ctx.symbol, 10 * 60_000, now)
  let score = 48 + Math.min(16, Math.abs(oi.changePct) * 4)
  if (oi.confirmsMove) score += 10
  if (side === 'LONG' && aggr >= 58) score += 8
  if (side === 'SHORT' && aggr <= 42) score += 8
  if (ctx.regime === 'TRENDING_STRONG') score += 8
  if (ctx.regime === 'VOLATILE_CHOP') score -= 12

  if (score < 56) return null

  const kind = 'OI_DELTA_CONFIRM' as const
  const mul = regimeConfidenceMul(kind, ctx.regime)
  const confidence = Math.round(Math.min(85, Math.max(54, score * mul)))
  const allowed = isSequenceAllowedInRegime(kind, ctx.regime)

  return {
    id: `seq_oi_${side}_${Math.round(oi.changePct * 10)}`,
    kind,
    side,
    confidence,
    title: `Предел · OI + дельта (${side})`,
    summary:
      side === 'LONG'
        ? `OI ${oi.changePct >= 0 ? '+' : ''}${oi.changePct.toFixed(1)}% при росте цены и покупках — живые лонги, продолжение ↑`
        : `OI/цена/продажи выстроились вниз — давление шортов, продолжение ↓`,
    steps: [
      `1) OI Δ ${oi.changePct >= 0 ? '+' : ''}${oi.changePct.toFixed(2)}% · price Δ ${oi.priceChangePct >= 0 ? '+' : ''}${oi.priceChangePct.toFixed(2)}%`,
      `2) Aggression buy ${aggr.toFixed(0)}%`,
      `3) Режим ${ctx.regime}`,
      '4) Тянуть по тренду · подтягивать на мелком откате',
    ],
    wallPrice: null,
    hitUsd: 0,
    regime: ctx.regime,
    allowedInRegime: allowed,
    framesUsed: frames.length,
    detectedAt: now,
    expiresAt: now + TTL_MS,
  }
}
