import {
  MIN_RR,
  TP_MAX_PCT,
  TP_MIN_PCT,
  type Side,
  type VaneRiskLevels,
} from './types'
import {
  MICRO_MIN_RR,
  MICRO_SL_MAX_PCT,
  MICRO_SL_MIN_PCT,
  MICRO_TP_MAX_PCT,
  MICRO_TP_MIN_PCT,
} from './microStrategy'

/**
 * Standard Vane scalp TP from ATR1m, clamped to TP_MIN–TP_MAX.
 */
export function buildVaneRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
  oppositeLiq?: number | null
  /** High-WR micro band — tight SL/TP for large notional */
  micro?: boolean
}): VaneRiskLevels {
  if (opts.micro) return buildMicroRisk(opts)
  return buildStandardRisk(opts)
}

function buildStandardRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
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

  const minSlDist = entry * 0.0045
  if (side === 'LONG' && entry - sl < minSlDist) sl = entry - minSlDist
  if (side === 'SHORT' && sl - entry < minSlDist) sl = entry + minSlDist

  const slPct = (Math.abs(entry - sl) / entry) * 100
  const atr1 = opts.atr1m != null && opts.atr1m > 0 ? opts.atr1m : atr15m * 0.35
  const atr1Pct = (atr1 / entry) * 100
  const dynamicTp = Math.min(TP_MAX_PCT, Math.max(TP_MIN_PCT, atr1Pct * 2.4))
  const minTpPct = Math.max(TP_MIN_PCT, slPct * MIN_RR)
  let tpPct = Math.min(TP_MAX_PCT, Math.max(dynamicTp, minTpPct))

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

/**
 * MICRO: tight structural SL capped 0.32–0.45%, TP 0.45–0.70%.
 * Prefer R:R ≥ 1.15 so WR~65% still has positive expectancy.
 */
export function buildMicroRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
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

  const atrPad = Math.max(atr15m * 0.25, entry * 0.001)
  let sl: number
  if (side === 'LONG') {
    sl = Math.min(opts.structureExtreme, entry) - atrPad
  } else {
    sl = Math.max(opts.structureExtreme, entry) + atrPad
  }

  // Clamp SL into MICRO band
  const slDist = Math.abs(entry - sl)
  const minDist = entry * (MICRO_SL_MIN_PCT / 100)
  const maxDist = entry * (MICRO_SL_MAX_PCT / 100)
  let useDist = Math.min(maxDist, Math.max(minDist, slDist))
  sl = side === 'LONG' ? entry - useDist : entry + useDist

  const slPct = (useDist / entry) * 100

  const atr1 = opts.atr1m != null && opts.atr1m > 0 ? opts.atr1m : atr15m * 0.3
  const atr1Pct = (atr1 / entry) * 100
  // ~1.8× ATR1m inside micro band — small move, not swing
  let tpPct = Math.min(
    MICRO_TP_MAX_PCT,
    Math.max(MICRO_TP_MIN_PCT, atr1Pct * 1.8)
  )
  // Ensure min R:R
  tpPct = Math.max(tpPct, slPct * MICRO_MIN_RR)
  tpPct = Math.min(MICRO_TP_MAX_PCT, tpPct)

  const tp =
    side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100)
  const rr = slPct > 0 ? tpPct / slPct : 0
  if (rr < MICRO_MIN_RR) {
    return {
      entry,
      sl,
      tp,
      slPct,
      tpPct,
      rr,
      ok: false,
      rejectReason: `micro_rr_${rr.toFixed(2)}_lt_${MICRO_MIN_RR}`,
    }
  }
  return { entry, sl, tp, slPct, tpPct, rr, ok: true }
}

export function riskPctForTier(tier: 'TIER1' | 'TIER2'): number {
  return tier === 'TIER1' ? 1.75 : 0.75
}
