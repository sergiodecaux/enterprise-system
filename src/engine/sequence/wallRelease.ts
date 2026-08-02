import { getFrames } from './frameBus'
import { isSequenceAllowedInRegime, regimeConfidenceMul } from './regimeGate'
import type { SequenceEvalContext, SequenceHit } from './types'

const TTL_MS = 60_000

/**
 * Wall absorbed hits then got EATEN → breakout / continuation impulse.
 */
export function detectWallRelease(ctx: SequenceEvalContext): SequenceHit | null {
  const now = ctx.now ?? Date.now()
  const frames = getFrames(ctx.symbol, 5 * 60_000, now)

  const eatenBid = ctx.wallEatenBid === true
  const eatenAsk = ctx.wallEatenAsk === true
  if (!eatenBid && !eatenAsk) return null

  // Prefer side where wall died and tape agrees
  const aggr = ctx.aggressionBuyPct ?? 50
  let side: 'LONG' | 'SHORT' | null = null
  let wallPrice: number | null = null

  if (eatenAsk && aggr >= 52) {
    side = 'LONG'
    wallPrice = ctx.resistPrice ?? null
  } else if (eatenBid && aggr <= 48) {
    side = 'SHORT'
    wallPrice = ctx.supportPrice ?? null
  }

  if (!side) return null

  const hitFrames = frames.filter((f) => f.kind === 'HIT')
  const hitUsd = hitFrames.reduce((s, f) => s + (f.volumeUsd ?? 0), 0)

  let score = 52
  score += Math.min(14, hitUsd / 400_000)
  if (ctx.oi?.confirmsMove) score += 10
  if (side === 'LONG' && (ctx.bookImbalance ?? 0) > 10) score += 6
  if (side === 'SHORT' && (ctx.bookImbalance ?? 0) < -10) score += 6
  if (ctx.regime === 'TRENDING_STRONG' || ctx.regime === 'TRENDING_WEAK') {
    score += 8
  }

  if (score < 56) return null

  const kind = 'WALL_RELEASE' as const
  const mul = regimeConfidenceMul(kind, ctx.regime)
  const confidence = Math.round(Math.min(86, Math.max(54, score * mul)))
  const allowed = isSequenceAllowedInRegime(kind, ctx.regime)

  return {
    id: `seq_release_${side}_${wallPrice?.toPrecision(6) ?? 'x'}`,
    kind,
    side,
    confidence,
    title: `Предел · стена снята (${side === 'LONG' ? 'ASK' : 'BID'})`,
    summary:
      side === 'LONG'
        ? 'ASK-стена съедена после ударов покупками — путь вверх открыт, импульс продолжения'
        : 'BID-стена съедена продажами — поддержка снята, импульс вниз',
    steps: [
      `1) Стена ${side === 'LONG' ? 'ASK' : 'BID'} EATEN`,
      `2) Лента ${side === 'LONG' ? 'покупки' : 'продажи'} ~${aggr.toFixed(0)}%`,
      ctx.oi?.confirmsMove
        ? `3) OI подтверждает (${ctx.oi.changePct >= 0 ? '+' : ''}${ctx.oi.changePct.toFixed(1)}%)`
        : '3) Ждём закрепления за уровнем стены',
      '4) Вход на ретесте снятой стены · не mid-impulse',
    ],
    wallPrice,
    hitUsd,
    regime: ctx.regime,
    allowedInRegime: allowed,
    framesUsed: frames.length,
    detectedAt: now,
    expiresAt: now + TTL_MS,
  }
}
