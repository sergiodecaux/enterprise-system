import {
  MIN_RR,
  TP_MAX_PCT,
  TP_MIN_PCT,
  type Side,
  type VaneRiskLevels,
} from './types'

/**
 * TP 1.5–2.0% (30–40% margin @ 20x). SL = structure ± 0.5×ATR15m.
 * Reject if R:R < 1.8.
 */
export function buildVaneRisk(opts: {
  side: Side
  entry: number
  /** Sweep extreme / structural invalidation anchor */
  structureExtreme: number
  atr15m: number
  /** Optional opposite HTF liquidity target */
  oppositeLiq?: number | null
}): VaneRiskLevels {
  const { side, entry, atr15m } = opts
  if (!(entry > 0)) {
    return {
      entry: 0,
      sl: 0,
      tp: 0,
      slPct: 0,
      tpPct: 0,
      rr: 0,
      ok: false,
      rejectReason: 'bad_entry',
    }
  }

  const atrPad = Math.max(atr15m * 0.5, entry * 0.0015)
  let sl: number
  if (side === 'LONG') {
    const struct = Math.min(opts.structureExtreme, entry)
    sl = struct - atrPad
  } else {
    const struct = Math.max(opts.structureExtreme, entry)
    sl = struct + atrPad
  }

  // Floor: at least ~0.45% from entry so noise doesn't make SL zero-width
  const minSlDist = entry * 0.0045
  if (side === 'LONG' && entry - sl < minSlDist) sl = entry - minSlDist
  if (side === 'SHORT' && sl - entry < minSlDist) sl = entry + minSlDist

  const slPct = (Math.abs(entry - sl) / entry) * 100
  const minTpPct = Math.max(TP_MIN_PCT, slPct * MIN_RR)
  let tpPct = Math.min(TP_MAX_PCT, Math.max(TP_MIN_PCT, minTpPct))

  // Prefer opposite HTF liq if inside 1.5–2.5% band
  if (opts.oppositeLiq != null && opts.oppositeLiq > 0) {
    const liqPct =
      side === 'LONG'
        ? ((opts.oppositeLiq - entry) / entry) * 100
        : ((entry - opts.oppositeLiq) / entry) * 100
    if (liqPct >= TP_MIN_PCT && liqPct <= TP_MAX_PCT + 0.5) {
      tpPct = Math.min(TP_MAX_PCT, Math.max(TP_MIN_PCT, liqPct))
    }
  }

  const tp =
    side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100)
  const rr = slPct > 0 ? tpPct / slPct : 0

  if (rr < MIN_RR) {
    return {
      entry,
      sl,
      tp,
      slPct,
      tpPct,
      rr,
      ok: false,
      rejectReason: `rr_${rr.toFixed(2)}_lt_${MIN_RR}`,
    }
  }

  return { entry, sl, tp, slPct, tpPct, rr, ok: true }
}

export function riskPctForTier(tier: 'TIER1' | 'TIER2'): number {
  return tier === 'TIER1' ? 1.75 : 0.75
}
