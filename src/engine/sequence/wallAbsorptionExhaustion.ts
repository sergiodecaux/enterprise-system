import { getFrames } from './frameBus'
import { isSequenceAllowedInRegime, regimeConfidenceMul } from './regimeGate'
import type { SequenceEvalContext, SequenceHit } from './types'

const WINDOW_MS = 5 * 60_000
const TTL_MS = 90_000
const MIN_HIT_USD = 250_000
const MIN_WALL_USD = 400_000
const MAX_DIST_PCT = 2.5

/**
 * Remizov limit: wall absorbs aggressive flow → aggression exhausts → bounce.
 *
 * Example: sells slam a BID whale for ~$10M/5m, wall stands, sell tape dies → LONG.
 */
export function detectWallAbsorptionExhaustion(
  ctx: SequenceEvalContext
): SequenceHit | null {
  const now = ctx.now ?? Date.now()
  const price = ctx.price
  if (!(price > 0)) return null

  const frames = getFrames(ctx.symbol, WINDOW_MS, now)
  const hitSell = sumHits(frames, 'SELL')
  const hitBuy = sumHits(frames, 'BUY')

  // Prefer live CVD volumes when frames are thin
  const sellVol =
    hitSell > 0 ? hitSell : estimateHitUsd(ctx.sellVol, ctx.aggressionBuyPct, 'SELL')
  const buyVol =
    hitBuy > 0 ? hitBuy : estimateHitUsd(ctx.buyVol, ctx.aggressionBuyPct, 'BUY')

  const candidates: Array<{
    side: 'LONG' | 'SHORT'
    wallPrice: number
    wallUsd: number
    distPct: number
    hitUsd: number
    wallAlive: boolean
    wallEaten: boolean
  }> = []

  if (
    ctx.supportPrice != null &&
    ctx.supportPrice > 0 &&
    (ctx.supportUsd ?? 0) >= MIN_WALL_USD
  ) {
    const dist = ctx.supportDistPct ?? pctDist(price, ctx.supportPrice)
    candidates.push({
      side: 'LONG',
      wallPrice: ctx.supportPrice,
      wallUsd: ctx.supportUsd ?? 0,
      distPct: dist,
      hitUsd: sellVol,
      wallAlive: ctx.bidWallAlive !== false,
      wallEaten: ctx.wallEatenBid === true,
    })
  }

  if (
    ctx.resistPrice != null &&
    ctx.resistPrice > 0 &&
    (ctx.resistUsd ?? 0) >= MIN_WALL_USD
  ) {
    const dist = ctx.resistDistPct ?? pctDist(price, ctx.resistPrice)
    candidates.push({
      side: 'SHORT',
      wallPrice: ctx.resistPrice,
      wallUsd: ctx.resistUsd ?? 0,
      distPct: dist,
      hitUsd: buyVol,
      wallAlive: ctx.askWallAlive !== false,
      wallEaten: ctx.wallEatenAsk === true,
    })
  }

  let best: (typeof candidates)[0] | null = null
  let bestScore = 0

  for (const c of candidates) {
    if (c.distPct > MAX_DIST_PCT) continue
    if (c.wallEaten) continue
    if (!c.wallAlive) continue
    if (c.hitUsd < MIN_HIT_USD) continue

    // Exhaustion: aggression against the wall has faded
    const aggr = ctx.aggressionBuyPct ?? 50
    const exhausted =
      c.side === 'LONG'
        ? aggr >= 42 && aggr <= 58 // sell pressure no longer dominant
          || (ctx.cvdDivergence === 'BULLISH')
          || ((ctx.cumulativeDelta ?? 0) > 0 && sellVol > buyVol * 1.15)
        : aggr >= 42 && aggr <= 58
          || (ctx.cvdDivergence === 'BEARISH')
          || ((ctx.cumulativeDelta ?? 0) < 0 && buyVol > sellVol * 1.15)

    // Still under pressure without exhaustion → not the limit yet
    const stillHammering =
      c.side === 'LONG' ? aggr < 38 : aggr > 62
    if (stillHammering && ctx.cvdDivergence !== (c.side === 'LONG' ? 'BULLISH' : 'BEARISH')) {
      continue
    }
    if (!exhausted && c.hitUsd < MIN_HIT_USD * 3) continue

    const hitRatio = Math.min(2.5, c.hitUsd / Math.max(c.wallUsd, 1))
    const nearBonus = c.distPct <= 1 ? 18 : c.distPct <= 1.8 ? 10 : 0
    const imb = ctx.bookImbalance ?? 0
    const imbAlign =
      c.side === 'LONG' ? (imb > 8 ? 8 : 0) : imb < -8 ? 8 : 0
    const exhaustBonus = exhausted ? 16 : 4
    const frameBonus = Math.min(10, Math.floor(frames.length / 8))

    const score =
      28 +
      hitRatio * 18 +
      nearBonus +
      imbAlign +
      exhaustBonus +
      frameBonus

    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }

  if (!best || bestScore < 48) return null

  const kind = 'WALL_ABSORPTION_EXHAUSTION' as const
  const mul = regimeConfidenceMul(kind, ctx.regime)
  const confidence = Math.round(
    Math.min(88, Math.max(52, bestScore * mul))
  )
  const allowed = isSequenceAllowedInRegime(kind, ctx.regime)

  const hitM = formatUsd(best.hitUsd)
  const wallM = formatUsd(best.wallUsd)
  const sideLabel = best.side === 'LONG' ? 'BID' : 'ASK'
  const bounce = best.side === 'LONG' ? 'вверх' : 'вниз'

  return {
    id: `seq_wae_${best.side}_${best.wallPrice.toPrecision(6)}`,
    kind,
    side: best.side,
    confidence,
    title: `Предел · стена ${sideLabel} держит`,
    summary:
      `За ~5м в ${sideLabel} @ ${fmtPx(best.wallPrice)} ударили ~${hitM} ` +
      `(стена ~${wallM}). Стена стоит · агрессия иссякает → отскок ${bounce}.`,
    steps: [
      `1) Крупный ${sideLabel} ${wallM} на ${fmtPx(best.wallPrice)} (−${best.distPct.toFixed(2)}%)`,
      `2) Рыночные ${best.side === 'LONG' ? 'продажи' : 'покупки'} ~${hitM} не сняли стену`,
      `3) Лента/дельта выдыхается — предел последовательности`,
      `4) Лимит у стены · не догонять середину импульса`,
    ],
    wallPrice: best.wallPrice,
    hitUsd: best.hitUsd,
    regime: ctx.regime,
    allowedInRegime: allowed,
    framesUsed: frames.length,
    detectedAt: now,
    expiresAt: now + TTL_MS,
  }
}

function sumHits(frames: { kind: string; side?: string; volumeUsd?: number }[], side: 'BUY' | 'SELL'): number {
  let s = 0
  for (const f of frames) {
    if (f.kind !== 'HIT') continue
    if (f.side === side) s += f.volumeUsd ?? 0
  }
  return s
}

function estimateHitUsd(
  vol: number | undefined,
  aggressionBuyPct: number | undefined,
  side: 'BUY' | 'SELL'
): number {
  if (!(vol != null && vol > 0)) return 0
  // vol may already be quote-ish; treat as relative mass
  const aggr = aggressionBuyPct ?? 50
  if (side === 'SELL' && aggr > 55) return vol * 0.35
  if (side === 'BUY' && aggr < 45) return vol * 0.35
  return vol * 0.7
}

function pctDist(price: number, level: number): number {
  return (Math.abs(price - level) / price) * 100
}

function formatUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`
  return `$${usd.toFixed(0)}`
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}
