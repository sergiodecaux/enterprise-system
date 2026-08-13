/**
 * MM intention — what the market maker is forced to do next,
 * not what price already did.
 */

export type MMPosition = 'LONG' | 'SHORT' | 'FLAT' | 'UNKNOWN'

export interface MMIntention {
  hasPosition: MMPosition
  mustDefend: boolean
  mustExit: boolean
  exitDirection: 'UP' | 'DOWN' | null
  reasons: string[]
}

export interface IntentionInput {
  obi?: number | null
  prevObi?: number | null
  wallPersisted?: boolean
  wallSide?: 'BID' | 'ASK' | null
  buyFlowPct?: number | null
  priceMoveBps?: number | null
  holdVol?: number | null
  prevHoldVol?: number | null
  absorptionLong?: boolean
  absorptionShort?: boolean
  /** Approximate wall age in seconds (from persisted ticks) */
  wallAgeSec?: number | null
}

export function readMMIntention(input: IntentionInput): MMIntention {
  const reasons: string[] = []
  let hasPosition: MMPosition = 'UNKNOWN'
  let mustDefend = false
  let mustExit = false
  let exitDirection: 'UP' | 'DOWN' | null = null

  const oiChg =
    input.holdVol != null &&
    input.prevHoldVol != null &&
    input.prevHoldVol > 0
      ? ((input.holdVol - input.prevHoldVol) / input.prevHoldVol) * 100
      : null

  const wallAge = input.wallAgeSec ?? (input.wallPersisted ? 90 : 0)
  const bidDefend =
    input.wallPersisted &&
    (input.wallSide === 'BID' || (input.obi != null && input.obi >= 12)) &&
    wallAge >= 60
  const askDefend =
    input.wallPersisted &&
    (input.wallSide === 'ASK' || (input.obi != null && input.obi <= -12)) &&
    wallAge >= 60

  // Bid wall held + OI rising → MM long, must defend
  if (bidDefend && oiChg != null && oiChg > 0.2) {
    hasPosition = 'LONG'
    mustDefend = true
    reasons.push('mm_long:bid_wall+oi_up')
  } else if (bidDefend && (oiChg == null || oiChg >= -0.15)) {
    hasPosition = 'LONG'
    mustDefend = true
    reasons.push('mm_long:bid_persist')
  }

  // Ask wall held + OI rising → MM short inventory / defending ask
  if (askDefend && oiChg != null && oiChg > 0.2) {
    hasPosition = 'SHORT'
    mustDefend = true
    reasons.push('mm_short:ask_wall+oi_up')
  } else if (askDefend && hasPosition === 'UNKNOWN') {
    hasPosition = 'SHORT'
    mustDefend = true
    reasons.push('mm_short:ask_persist')
  }

  // Buy tape powerful but price stuck + OI flat → distributing into bids
  const buyAbs =
    input.absorptionShort ||
    (input.buyFlowPct != null &&
      input.priceMoveBps != null &&
      input.buyFlowPct >= 55 &&
      Math.abs(input.priceMoveBps) <= 12)
  if (buyAbs && (oiChg == null || oiChg <= 0.35)) {
    mustExit = true
    exitDirection = null // already exiting into tape (distribution)
    if (hasPosition === 'UNKNOWN' || hasPosition === 'LONG') {
      hasPosition = 'LONG'
    }
    reasons.push('must_exit:sell_into_buy_tape')
  }

  // Sell tape stuck + OI flat → accumulating (exit of shorts / load longs)
  const sellAbs =
    input.absorptionLong ||
    (input.buyFlowPct != null &&
      input.priceMoveBps != null &&
      input.buyFlowPct <= 45 &&
      Math.abs(input.priceMoveBps) <= 12)
  if (sellAbs && (oiChg == null || Math.abs(oiChg) <= 0.4)) {
    if (!mustExit) {
      hasPosition = hasPosition === 'UNKNOWN' ? 'FLAT' : hasPosition
      reasons.push('accum:absorb_sell_tape')
    }
  }

  // OI falling hard while price flat → forced exit / de-risk
  if (oiChg != null && oiChg <= -0.6) {
    mustExit = true
    exitDirection =
      input.obi != null && input.obi >= 8
        ? 'UP'
        : input.obi != null && input.obi <= -8
          ? 'DOWN'
          : exitDirection
    reasons.push(`must_exit:oi_dump:${oiChg.toFixed(2)}`)
  }

  if (hasPosition === 'UNKNOWN' && oiChg != null && Math.abs(oiChg) < 0.2) {
    hasPosition = 'FLAT'
    reasons.push('flat:oi_quiet')
  }

  if (!reasons.length) reasons.push('intention:unknown')

  return {
    hasPosition,
    mustDefend,
    mustExit,
    exitDirection,
    reasons,
  }
}

/** SHORT A: MM exiting or flat — not defending bids under price. */
export function intentionAllowsShort(i: MMIntention): boolean {
  if (i.mustDefend && i.hasPosition === 'LONG') return false
  return i.mustExit || i.hasPosition === 'FLAT' || i.hasPosition === 'SHORT'
}

/** LONG A: MM defending bids or long — not dumping into buy tape. */
export function intentionAllowsLong(i: MMIntention): boolean {
  if (i.mustExit && i.hasPosition === 'LONG' && !i.mustDefend) return false
  return i.mustDefend || i.hasPosition === 'LONG' || i.hasPosition === 'FLAT'
}
