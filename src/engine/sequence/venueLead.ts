/**
 * Cross-venue lead (Binance USDT-M) vs local MEXC walls.
 * If Binance dumps while a MEXC BID wall still stands → ARB_WALL_RISK (wall will be eaten).
 */

import type { MarketFrame } from './types'

export interface VenueLeadSnapshot {
  venue: 'BINANCE'
  /** Binance futures symbol e.g. BTCUSDT */
  binanceSymbol: string
  at: number
  mid: number | null
  /** Net aggressive USD over ~60s */
  deltaUsd1m: number
  /** Mid move over ~30s in bps */
  moveBps30s: number
  buyFlowPct: number
  /** Simple top-5 OBI −100…100 */
  obi: number | null
  connected: boolean
}

export type VenueLeadKind = 'NONE' | 'ARB_WALL_RISK' | 'LEAD_CONFIRM'

export interface VenueLeadEval {
  kind: VenueLeadKind
  /** Direction of the lead move / risk */
  side: 'LONG' | 'SHORT' | null
  reason: string
  /** Multiply sequence confidence */
  confidenceMul: number
  label: string
}

const leadCache = new Map<string, VenueLeadSnapshot>()

export function setVenueLeadCache(
  localSymbol: string,
  snap: VenueLeadSnapshot | null
): void {
  if (!snap) {
    leadCache.delete(localSymbol)
    return
  }
  leadCache.set(localSymbol, snap)
}

export function getVenueLeadCache(
  localSymbol: string,
  maxAgeMs = 8_000
): VenueLeadSnapshot | null {
  const s = leadCache.get(localSymbol)
  if (!s) return null
  if (Date.now() - s.at > maxAgeMs) return null
  return s
}

/**
 * Compare Binance lead tape/price vs local wall survival.
 */
export function evaluateVenueLead(opts: {
  localPrice: number
  bidWallAlive: boolean
  askWallAlive: boolean
  lead: VenueLeadSnapshot | null
}): VenueLeadEval {
  const lead = opts.lead
  if (!lead?.connected || lead.mid == null || !(opts.localPrice > 0)) {
    return {
      kind: 'NONE',
      side: null,
      reason: '',
      confidenceMul: 1,
      label: 'Binance …',
    }
  }

  const move = lead.moveBps30s
  const flow = lead.buyFlowPct
  const basisBps =
    lead.mid > 0
      ? ((opts.localPrice - lead.mid) / lead.mid) * 10_000
      : 0

  // Binance dumping hard while local BID wall still "holds" → arb will eat it
  if (move <= -10 && flow <= 45 && opts.bidWallAlive) {
    return {
      kind: 'ARB_WALL_RISK',
      side: 'SHORT',
      reason: `Binance −${Math.abs(move).toFixed(0)}bps · локальная ОПОРА ещё стоит — стену арбитражнут`,
      confidenceMul: 0.72,
      label: 'Arb ↓ стена',
    }
  }

  // Binance ripping while local ASK wall stands → roof will get arbed
  if (move >= 10 && flow >= 55 && opts.askWallAlive) {
    return {
      kind: 'ARB_WALL_RISK',
      side: 'LONG',
      reason: `Binance +${move.toFixed(0)}bps · локальная КРЫША ещё стоит — снимут арбитражем`,
      confidenceMul: 0.72,
      label: 'Arb ↑ стена',
    }
  }

  // Lead confirms local direction (same sign, meaningful move)
  if (move >= 8 && flow >= 56) {
    return {
      kind: 'LEAD_CONFIRM',
      side: 'LONG',
      reason: `Binance lead +${move.toFixed(0)}bps · buy ${flow.toFixed(0)}%`,
      confidenceMul: 1.08,
      label: 'BN ↑',
    }
  }
  if (move <= -8 && flow <= 44) {
    return {
      kind: 'LEAD_CONFIRM',
      side: 'SHORT',
      reason: `Binance lead ${move.toFixed(0)}bps · sell ${(100 - flow).toFixed(0)}%`,
      confidenceMul: 1.08,
      label: 'BN ↓',
    }
  }

  // Large positive basis: local rich vs Binance — fragile bid
  if (basisBps >= 25 && opts.bidWallAlive && move < 0) {
    return {
      kind: 'ARB_WALL_RISK',
      side: 'SHORT',
      reason: `Локально дороже Binance на ${basisBps.toFixed(0)}bps + BN вниз`,
      confidenceMul: 0.78,
      label: 'Basis rich',
    }
  }

  return {
    kind: 'NONE',
    side: null,
    reason: `BN ${move >= 0 ? '+' : ''}${move.toFixed(0)}bps`,
    confidenceMul: 1,
    label: 'BN ≈',
  }
}

export function venueLeadToFrame(
  evaled: VenueLeadEval,
  lead: VenueLeadSnapshot,
  now = Date.now()
): MarketFrame {
  return {
    at: now,
    kind: 'VENUE',
    side:
      evaled.side === 'LONG'
        ? 'BUY'
        : evaled.side === 'SHORT'
          ? 'SELL'
          : 'FLAT',
    price: lead.mid ?? undefined,
    volumeUsd: Math.abs(lead.deltaUsd1m),
    strength:
      evaled.kind === 'ARB_WALL_RISK'
        ? 0.9
        : evaled.kind === 'LEAD_CONFIRM'
          ? 0.7
          : 0.35,
    label: evaled.label,
    meta: {
      venue: 'BINANCE',
      kind: evaled.kind,
      moveBps: lead.moveBps30s,
      buyFlow: lead.buyFlowPct,
      mul: evaled.confidenceMul,
    },
  }
}
