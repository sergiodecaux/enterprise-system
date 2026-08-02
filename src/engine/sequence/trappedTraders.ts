/**
 * Trapped traders — strongest fuel sequence.
 *
 * Process: price near wall → OI spikes → aggression extreme → price stalls
 * (whale absorbs) → aggression fades → trapped crowd becomes fuel → reverse.
 */

import { getFrames } from './frameBus'
import { isSequenceAllowedInRegime, regimeConfidenceMul } from './regimeGate'
import { passesAnomalyGate, type HitZScore } from './hitBaseline'
import { sumRecentLiq } from './liqInfer'
import type { SequenceEvalContext, SequenceHit } from './types'

const WINDOW_MS = 8 * 60_000
const TTL_MS = 100_000
const MAX_DIST_PCT = 2.2
const MIN_WALL_USD = 350_000
const MIN_HIT_USD = 200_000
const MAX_PRICE_MOVE_PCT = 0.35 // "price doesn't rise/fall" while absorbed

interface TrapMem {
  side: 'LONG' | 'SHORT'
  armedAt: number
  peakHitUsd: number
  oiChangeAtArm: number
  wallPrice: number
}

const trapMem = new Map<string, TrapMem>()

export function detectTrappedTraders(
  ctx: SequenceEvalContext,
  zInfo?: HitZScore | null
): SequenceHit | null {
  const now = ctx.now ?? Date.now()
  const price = ctx.price
  if (!(price > 0)) return null

  const oi = ctx.oi
  const aggr = ctx.aggressionBuyPct ?? 50
  const frames = getFrames(ctx.symbol, WINDOW_MS, now)
  const hitBuy = sumHit(frames, 'BUY')
  const hitSell = sumHit(frames, 'SELL')

  const candidates: Array<{
    side: 'LONG' | 'SHORT'
    wallPrice: number
    wallUsd: number
    distPct: number
    hitUsd: number
    aggressionOk: boolean
    oiOk: boolean
    stalled: boolean
    exhausted: boolean
    liqFuel: number
  }> = []

  // Trap longs near resistance: buys slam ask wall, OI up, price stalls → SHORT fuel
  if (
    ctx.resistPrice != null &&
    (ctx.resistUsd ?? 0) >= MIN_WALL_USD &&
    (ctx.resistDistPct ?? 99) <= MAX_DIST_PCT
  ) {
    const dist = ctx.resistDistPct ?? pct(price, ctx.resistPrice)
    const hitUsd = hitBuy > 0 ? hitBuy : (ctx.buyVol ?? 0)
    const oiOk = (oi?.changePct ?? 0) >= 0.35 || (oi?.samples ?? 0) < 3
    const aggressionOk = aggr >= 58
    const stalled =
      Math.abs(oi?.priceChangePct ?? 0) <= MAX_PRICE_MOVE_PCT ||
      dist <= 0.85
    const exhausted = aggr <= 54 && hitUsd >= MIN_HIT_USD
    const liqFuel = sumRecentLiq(frames, 'SHORT_LIQ')
    candidates.push({
      side: 'SHORT',
      wallPrice: ctx.resistPrice,
      wallUsd: ctx.resistUsd ?? 0,
      distPct: dist,
      hitUsd,
      aggressionOk,
      oiOk,
      stalled,
      exhausted: exhausted || (liqFuel >= 40_000 && aggr <= 56),
      liqFuel,
    })
  }

  // Trap shorts near support: sells slam bid, OI up, price holds → LONG fuel
  if (
    ctx.supportPrice != null &&
    (ctx.supportUsd ?? 0) >= MIN_WALL_USD &&
    (ctx.supportDistPct ?? 99) <= MAX_DIST_PCT
  ) {
    const dist = ctx.supportDistPct ?? pct(price, ctx.supportPrice)
    const hitUsd = hitSell > 0 ? hitSell : (ctx.sellVol ?? 0)
    const oiOk = (oi?.changePct ?? 0) >= 0.35 || (oi?.samples ?? 0) < 3
    const aggressionOk = aggr <= 42
    const stalled =
      Math.abs(oi?.priceChangePct ?? 0) <= MAX_PRICE_MOVE_PCT ||
      dist <= 0.85
    const exhausted = aggr >= 46 && hitUsd >= MIN_HIT_USD
    const liqFuel = sumRecentLiq(frames, 'LONG_LIQ')
    candidates.push({
      side: 'LONG',
      wallPrice: ctx.supportPrice,
      wallUsd: ctx.supportUsd ?? 0,
      distPct: dist,
      hitUsd,
      aggressionOk,
      oiOk,
      stalled,
      exhausted: exhausted || (liqFuel >= 40_000 && aggr >= 44),
      liqFuel,
    })
  }

  let best: (typeof candidates)[0] | null = null
  let bestScore = 0

  for (const c of candidates) {
    if (c.hitUsd < MIN_HIT_USD) continue
    if (!c.aggressionOk && !c.exhausted) continue
    if (!c.stalled && c.liqFuel < 50_000) continue

    // Arm memory while loading
    if (c.aggressionOk && c.stalled && c.oiOk) {
      trapMem.set(ctx.symbol, {
        side: c.side,
        armedAt: now,
        peakHitUsd: Math.max(
          c.hitUsd,
          trapMem.get(ctx.symbol)?.peakHitUsd ?? 0
        ),
        oiChangeAtArm: oi?.changePct ?? 0,
        wallPrice: c.wallPrice,
      })
    }

    const mem = trapMem.get(ctx.symbol)
    const wasArmed =
      mem != null &&
      mem.side === c.side &&
      now - mem.armedAt < WINDOW_MS

    // Limit only when exhaustion (or liq climax + fade)
    if (!c.exhausted && !wasArmed) continue
    if (!c.exhausted && wasArmed && !c.aggressionOk) {
      // still loading
      continue
    }
    if (!c.exhausted) continue

    if (!passesAnomalyGate(zInfo, { soft: true })) continue

    let score = 50
    score += Math.min(16, c.hitUsd / 200_000)
    if (c.oiOk) score += 10
    if (c.stalled) score += 8
    if (wasArmed) score += 10
    if (c.liqFuel >= 40_000) score += 12
    if (c.distPct <= 1) score += 6
    if (ctx.cvdDivergence === (c.side === 'LONG' ? 'BULLISH' : 'BEARISH')) {
      score += 8
    }

    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }

  if (!best || bestScore < 58) return null

  const kind = 'TRAPPED_TRADERS' as const
  const mul =
    regimeConfidenceMul(kind, ctx.regime) *
    (zInfo?.confidenceMul ?? 1) *
    (ctx.spotPerpMul ?? 1)
  const confidence = Math.round(
    Math.min(90, Math.max(56, bestScore * mul))
  )
  const allowed = isSequenceAllowedInRegime(kind, ctx.regime)

  const bounce = best.side === 'LONG' ? 'вверх' : 'вниз'
  const crowd = best.side === 'LONG' ? 'шорты' : 'лонги'

  // Clear arm after firing
  trapMem.delete(ctx.symbol)

  return {
    id: `seq_trap_${best.side}_${best.wallPrice.toPrecision(6)}`,
    kind,
    side: best.side,
    confidence,
    title: `Топливо · запертые ${crowd}`,
    summary:
      `Толпа била в стену @ ${fmtPx(best.wallPrice)}, OI рос, цена почти не шла — ` +
      `кит поглотил ярость. Агрессия иссякла → ${crowd} стали топливом, смотри ${bounce}.` +
      (best.liqFuel >= 40_000
        ? ` (+ликвидации ~$${fmtK(best.liqFuel)})`
        : ''),
    steps: [
      `1) Цена у стены ${fmtPx(best.wallPrice)} (−${best.distPct.toFixed(2)}%)`,
      `2) OI↑ / агрессия зашкалила, цена почти стоит — поглощение`,
      best.liqFuel >= 40_000
        ? `3) Волна ликвидаций ~$${fmtK(best.liqFuel)} — кульминация`
        : `3) Удары ~$${fmtK(best.hitUsd)} не сдвинули цену`,
      `4) Агрессия стихла → предел: отскок ${bounce}`,
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

function sumHit(
  frames: { kind: string; side?: string; volumeUsd?: number }[],
  side: 'BUY' | 'SELL'
): number {
  let s = 0
  for (const f of frames) {
    if (f.kind !== 'HIT') continue
    if (f.side === side) s += f.volumeUsd ?? 0
  }
  return s
}

function pct(price: number, level: number): number {
  return (Math.abs(price - level) / price) * 100
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function fmtK(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1e6).toFixed(2)}M`
  if (usd >= 1_000) return `${(usd / 1e3).toFixed(0)}K`
  return String(Math.round(usd))
}
