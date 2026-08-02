import { getFrames } from './frameBus'
import { isSequenceAllowedInRegime, regimeConfidenceMul } from './regimeGate'
import type { SequenceEvalContext, SequenceHit } from './types'

const TTL_MS = 75_000

/**
 * Price drifts one way while CVD / aggression goes the other → fuel exhausted.
 */
export function detectCvdDivergenceLimit(
  ctx: SequenceEvalContext
): SequenceHit | null {
  const now = ctx.now ?? Date.now()
  const div = ctx.cvdDivergence
  if (div !== 'BULLISH' && div !== 'BEARISH') return null

  const aggr = ctx.aggressionBuyPct ?? 50
  const frames = getFrames(ctx.symbol, 5 * 60_000, now)
  const deltaFrames = frames.filter((f) => f.kind === 'DELTA').length

  const side: 'LONG' | 'SHORT' = div === 'BULLISH' ? 'LONG' : 'SHORT'
  const exhausted =
    side === 'LONG'
      ? aggr >= 40
      : aggr <= 60

  if (!exhausted && deltaFrames < 2) return null

  const kind = 'CVD_DIVERGENCE_LIMIT' as const
  let score = 50 + (ctx.cvdHasDivergence ? 10 : 4)
  score += Math.min(12, deltaFrames * 3)
  if (side === 'LONG' && (ctx.bookImbalance ?? 0) > 5) score += 6
  if (side === 'SHORT' && (ctx.bookImbalance ?? 0) < -5) score += 6
  if (ctx.oi?.divergenceType === 'DISTRIBUTION' && side === 'SHORT') score += 10
  if (ctx.oi?.divergenceType === 'SHORT_BUILD' && side === 'LONG') score += 6

  if (score < 54) return null

  const mul = regimeConfidenceMul(kind, ctx.regime)
  const confidence = Math.round(Math.min(84, Math.max(52, score * mul)))
  const allowed = isSequenceAllowedInRegime(kind, ctx.regime)

  return {
    id: `seq_cvd_${side}_${Math.round(ctx.price * 1e4)}`,
    kind,
    side,
    confidence,
    title: `Предел · CVD ${div === 'BULLISH' ? 'бычья' : 'медвежья'} дивергенция`,
    summary:
      div === 'BULLISH'
        ? 'Цена слабее / вниз, а дельта копится в покупки — продажи иссякают, вероятен отскок ↑'
        : 'Цена выше, а дельта отрицательная — рост на пустом топливе, вероятен откат ↓',
    steps: [
      `1) CVD divergence ${div}`,
      `2) Aggression ~${aggr.toFixed(0)}% buy`,
      ctx.oi
        ? `3) OI ${ctx.oi.changePct >= 0 ? '+' : ''}${ctx.oi.changePct.toFixed(1)}% / 15м`
        : '3) Ждём подтверждения у зоны / стены',
      '4) Не догонять — лимит на реакции',
    ],
    wallPrice: null,
    hitUsd: Math.abs(ctx.cumulativeDelta ?? 0),
    regime: ctx.regime,
    allowedInRegime: allowed,
    framesUsed: frames.length,
    detectedAt: now,
    expiresAt: now + TTL_MS,
  }
}
