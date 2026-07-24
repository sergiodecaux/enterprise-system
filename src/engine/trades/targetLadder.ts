/**
 * R-multiple target ladder (1R / 2R / 3R) with cascade reach probabilities.
 * Magnet can anchor TP3 when aligned with trade side.
 */

import type { PathPoint } from '../prediction/types'
import type { TradeMagnet, TradeTargetLadder } from '../setups/types'

export function computeTargetLadder(opts: {
  side: 'LONG' | 'SHORT'
  entry: number
  invalidation: number
  /** Existing single target — used as soft magnet candidate */
  preferredTarget?: number | null
  magnet?: TradeMagnet | null
  /** Base win% at entry fill (0–100) */
  baseWinPct: number
}): TradeTargetLadder {
  const { side, entry, invalidation, preferredTarget, magnet, baseWinPct } = opts
  const risk = Math.abs(entry - invalidation)
  if (!(entry > 0) || !(risk > 0)) {
    const flat = entry > 0 ? entry : 0
    return {
      r1: flat,
      r2: flat,
      r3: flat,
      pReach1: Math.round(baseWinPct),
      pReach2: Math.round(baseWinPct * 0.55),
      pReach3: Math.round(baseWinPct * 0.3),
    }
  }

  const dir = side === 'LONG' ? 1 : -1
  let r1 = entry + dir * risk * 1
  let r2 = entry + dir * risk * 2
  let r3 = entry + dir * risk * 3

  // Prefer structural magnet for TP3 when beyond ~2R and same direction
  const magnetPx = magnet?.price
  if (magnetPx != null && magnetPx > 0) {
    const magR = Math.abs(magnetPx - entry) / risk
    const aligned =
      (side === 'LONG' && magnetPx > entry) ||
      (side === 'SHORT' && magnetPx < entry)
    if (aligned && magR >= 1.8 && magR <= 4.5) {
      r3 = magnetPx
      if (magR < 2.2) r2 = entry + dir * risk * Math.min(2, magR * 0.75)
    }
  } else if (preferredTarget != null && preferredTarget > 0) {
    const prefR = Math.abs(preferredTarget - entry) / risk
    const aligned =
      (side === 'LONG' && preferredTarget > entry) ||
      (side === 'SHORT' && preferredTarget < entry)
    if (aligned && prefR >= 1.2) {
      if (prefR <= 1.4) r1 = preferredTarget
      else if (prefR <= 2.4) r2 = preferredTarget
      else r3 = preferredTarget
    }
  }

  // Cascade: reaching higher R is harder; magnet alignment soft-boosts TP3
  const base = Math.min(88, Math.max(22, baseWinPct))
  let p1 = base * 0.92
  let p2 = base * 0.58
  let p3 = base * 0.34
  if (magnetPx != null) {
    const aligned =
      (side === 'LONG' && magnetPx > entry) ||
      (side === 'SHORT' && magnetPx < entry)
    if (aligned) {
      p2 += 4
      p3 += 7
    } else {
      p2 -= 3
      p3 -= 6
    }
  }
  const rr3 = Math.abs(r3 - entry) / risk
  if (rr3 >= 3.2) p3 -= 4
  if (rr3 < 2.2) p3 += 3

  return {
    r1,
    r2,
    r3,
    pReach1: Math.round(Math.min(90, Math.max(18, p1))),
    pReach2: Math.round(Math.min(78, Math.max(12, p2))),
    pReach3: Math.round(Math.min(62, Math.max(8, p3))),
  }
}

/** Path: now → zone/entry → 1R → 2R → 3R (magnet) */
export function buildLadderPath(opts: {
  price: number
  entry: number
  zoneMid?: number | null
  ladder: TradeTargetLadder
  magnetLabel?: string
}): PathPoint[] {
  const { price, entry, zoneMid, ladder, magnetLabel } = opts
  const approach = Math.max(600, Math.abs(price - entry) / Math.max(price, 1e-9) * 100 * 90)
  const touch = zoneMid != null && zoneMid > 0 ? zoneMid : entry
  return [
    { timeOffsetSeconds: 0, price, label: 'сейчас' },
    {
      timeOffsetSeconds: approach,
      price: touch,
      label: 'зона',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: approach + 1800,
      price: entry,
      label: 'вход',
    },
    {
      timeOffsetSeconds: approach + 4500,
      price: ladder.r1,
      label: '1R',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: approach + 7800,
      price: ladder.r2,
      label: '2R',
      isKeyLevel: true,
    },
    {
      timeOffsetSeconds: approach + 12_000,
      price: ladder.r3,
      label: magnetLabel ? `3R · ${magnetLabel}` : '3R',
      isKeyLevel: true,
    },
  ]
}
