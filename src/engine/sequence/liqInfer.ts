/**
 * Infer liquidation cascades from tape bursts (MEXC has no public force-order feed).
 * Short liquidations → forced BUY cascade; long liquidations → forced SELL cascade.
 */

import type { MexcTrade } from '../../api/mexc'
import type { MarketFrame } from './types'

const BURST_WINDOW_MS = 3_500
const MIN_BURST_USD = 45_000
const MIN_TRADES = 6
const MIN_DOMINANCE = 0.72

export interface InferredLiq {
  at: number
  side: 'LONG_LIQ' | 'SHORT_LIQ'
  usd: number
  price: number
  tradeCount: number
  label: string
}

/**
 * Detect a one-sided tape flush that behaves like a liquidation wave.
 */
export function inferLiquidationBurst(
  trades: MexcTrade[] | null | undefined,
  now = Date.now()
): InferredLiq | null {
  if (!trades?.length) return null
  const cut = now - BURST_WINDOW_MS
  const recent = trades.filter((t) => t.timestamp >= cut)
  if (recent.length < MIN_TRADES) return null

  let buyUsd = 0
  let sellUsd = 0
  let buyN = 0
  let sellN = 0
  let lastPx = recent[recent.length - 1]?.price ?? 0
  let firstPx = recent[0]?.price ?? 0

  for (const t of recent) {
    const usd = t.price * t.volume
    if (t.side === 'BUY') {
      buyUsd += usd
      buyN++
    } else {
      sellUsd += usd
      sellN++
    }
  }

  const total = buyUsd + sellUsd
  if (total < MIN_BURST_USD) return null

  const buyDom = buyUsd / total
  const sellDom = sellUsd / total
  const movePct =
    firstPx > 0 ? ((lastPx - firstPx) / firstPx) * 100 : 0

  // Forced buys (shorts liquidated) — price should tick up
  if (buyDom >= MIN_DOMINANCE && movePct >= 0.02) {
    return {
      at: now,
      side: 'SHORT_LIQ',
      usd: buyUsd,
      price: lastPx,
      tradeCount: buyN,
      label: `Ликвидации шортов ~$${fmt(buyUsd)}`,
    }
  }
  // Forced sells (longs liquidated)
  if (sellDom >= MIN_DOMINANCE && movePct <= -0.02) {
    return {
      at: now,
      side: 'LONG_LIQ',
      usd: sellUsd,
      price: lastPx,
      tradeCount: sellN,
      label: `Ликвидации лонгов ~$${fmt(sellUsd)}`,
    }
  }

  return null
}

export function liqToFrame(liq: InferredLiq): MarketFrame {
  return {
    at: liq.at,
    kind: 'LIQ',
    side: liq.side,
    price: liq.price,
    volumeUsd: liq.usd,
    strength: Math.min(1, liq.usd / 500_000),
    label: liq.label,
    meta: { trades: liq.tradeCount },
  }
}

/** Sum recent LIQ frames in window. */
export function sumRecentLiq(
  frames: MarketFrame[],
  side?: 'LONG_LIQ' | 'SHORT_LIQ'
): number {
  let s = 0
  for (const f of frames) {
    if (f.kind !== 'LIQ') continue
    if (side && f.side !== side) continue
    s += f.volumeUsd ?? 0
  }
  return s
}

function fmt(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1e6).toFixed(2)}M`
  if (usd >= 1_000) return `${(usd / 1e3).toFixed(0)}K`
  return String(Math.round(usd))
}
