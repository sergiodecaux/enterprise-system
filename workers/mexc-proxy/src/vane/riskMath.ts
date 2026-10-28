import { MIN_RR, type Side, type VaneRiskLevels } from './types'
import { MICRO_MIN_RR } from './microStrategy'
import { MACRO_MIN_RR } from './macroStrategy'

/**
 * Structural risk only. A stop that needs more than this is rejected, never
 * squeezed into a cosmetic percentage band.
 */
const MAX_STRUCTURAL_SL_PCT = 3.5

function bad(reason: string): VaneRiskLevels {
  return {
    entry: 0,
    sl: 0,
    tp: 0,
    slPct: 0,
    tpPct: 0,
    rr: 0,
    ok: false,
    rejectReason: reason,
  }
}

function structuralStop(
  side: Side,
  entry: number,
  structureExtreme: number,
  atrPad: number
): number {
  if (side === 'LONG') {
    return Math.min(structureExtreme, entry) - atrPad
  }
  return Math.max(structureExtreme, entry) + atrPad
}

function oppositeTarget(
  side: Side,
  entry: number,
  oppositeLiq: number | null | undefined
): number | null {
  if (oppositeLiq == null || !(oppositeLiq > 0)) return null
  const toward =
    side === 'LONG' ? oppositeLiq > entry : oppositeLiq < entry
  return toward ? oppositeLiq : null
}

/**
 * Build SL from structure ± ATR pad and TP from real opposite liquidity.
 * When no liquidity target exists, use an ATR measured move. No min/max
 * percentage clamp is applied to either side; an unaffordable stop or a
 * sub-minimum RR is rejected.
 */
function buildStructuralRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
  oppositeLiq?: number | null
  padMult: number
  fallbackAtrMult: number
  minRR: number
  tag: string
}): VaneRiskLevels {
  const { side, entry, atr15m } = opts
  if (!(entry > 0) || !(atr15m > 0)) {
    return bad(`${opts.tag}_bad_entry`)
  }

  // ATR pad with a tiny floor to avoid a zero stop on a flat bar.
  const atrPad = Math.max(atr15m * opts.padMult, entry * 0.0005)
  const sl = structuralStop(side, entry, opts.structureExtreme, atrPad)
  const slDist = Math.abs(entry - sl)
  if (!(slDist > 0)) return bad(`${opts.tag}_bad_structure`)

  const slPct = (slDist / entry) * 100
  if (slPct > MAX_STRUCTURAL_SL_PCT) {
    return {
      entry,
      sl,
      tp: 0,
      slPct,
      tpPct: 0,
      rr: 0,
      ok: false,
      rejectReason: `${opts.tag}_risk_${slPct.toFixed(2)}_gt_${MAX_STRUCTURAL_SL_PCT}`,
    }
  }

  const liq = oppositeTarget(side, entry, opts.oppositeLiq)
  const atr1 =
    opts.atr1m != null && opts.atr1m > 0 ? opts.atr1m : atr15m * 0.35
  const fallbackDist = atr1 * opts.fallbackAtrMult
  const tpDist = liq != null ? Math.abs(liq - entry) : fallbackDist
  const tp =
    liq ??
    (side === 'LONG' ? entry + fallbackDist : entry - fallbackDist)
  const tpPct = (tpDist / entry) * 100
  const rr = slPct > 0 ? tpPct / slPct : 0

  if (rr < opts.minRR) {
    return {
      entry,
      sl,
      tp,
      slPct,
      tpPct,
      rr,
      ok: false,
      rejectReason: `${opts.tag}_rr_${rr.toFixed(2)}_lt_${opts.minRR}`,
    }
  }

  return { entry, sl, tp, slPct, tpPct, rr, ok: true }
}

/**
 * Standard Vane setup: structural SL ± 0.5×ATR15.
 */
export function buildVaneRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
  oppositeLiq?: number | null
  /** High-WR micro band — tight structural stop, not a clamp */
  micro?: boolean
  /** Real directional move — structural stop, ATR target */
  macro?: boolean
}): VaneRiskLevels {
  if (opts.macro) return buildMacroRisk(opts)
  if (opts.micro) return buildMicroRisk(opts)
  return buildStandardRisk(opts)
}

export function buildMacroRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
  oppositeLiq?: number | null
}): VaneRiskLevels {
  return buildStructuralRisk({
    ...opts,
    padMult: 0.35,
    fallbackAtrMult: 3.2,
    minRR: MACRO_MIN_RR,
    tag: 'macro',
  })
}

function buildStandardRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
  oppositeLiq?: number | null
}): VaneRiskLevels {
  return buildStructuralRisk({
    ...opts,
    padMult: 0.5,
    fallbackAtrMult: 2.4,
    minRR: MIN_RR,
    tag: 'rr',
  })
}

/**
 * Micro: tight structural stop ± 0.25×ATR15, TP to real liquidity or 1.8×ATR1m.
 * An unaffordable stop is rejected, never clamped into 0.32–0.45%.
 */
export function buildMicroRisk(opts: {
  side: Side
  entry: number
  structureExtreme: number
  atr15m: number
  atr1m?: number | null
  oppositeLiq?: number | null
}): VaneRiskLevels {
  return buildStructuralRisk({
    ...opts,
    padMult: 0.25,
    fallbackAtrMult: 1.8,
    minRR: MICRO_MIN_RR,
    tag: 'micro',
  })
}

export function riskPctForTier(tier: 'TIER1' | 'TIER2'): number {
  return tier === 'TIER1' ? 1.75 : 0.75
}
