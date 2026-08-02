import type { MexcTrade } from '../../api/mexc'
import type { MarketRegime } from '../regime/marketRegime'
import type { EnhancedCvdSnapshot } from '../orderflow/enhancedCvd'
import type { WhaleWatcherState, WallEvent, OrderBookWall } from '../types'
import { pushFrames } from './frameBus'
import { detectWallAbsorptionExhaustion } from './wallAbsorptionExhaustion'
import { detectCvdDivergenceLimit } from './cvdDivergenceLimit'
import { detectWallRelease } from './wallRelease'
import { detectOiDeltaConfirm } from './oiDeltaConfirm'
import { getOiSnapshot, recordOiSample, type OiSnapshot } from './oiTracker'
import { applySequenceHistWr } from './sequenceJournal'
import type { MarketFrame, SequenceEvalContext, SequenceHit } from './types'

export interface IngestOrderFlowInput {
  symbol: string
  price: number
  regime: MarketRegime
  whale?: WhaleWatcherState | null
  walls?: OrderBookWall[] | null
  wallEvents?: WallEvent[] | null
  trades?: MexcTrade[] | null
  cvd?: EnhancedCvdSnapshot | null
  bookImbalance?: number | null
  /** Open interest (contracts) from ticker.holdVol */
  openInterest?: number | null
  now?: number
}

/**
 * Cut the live process into frames, then look for the strongest sequence limit.
 * Client-only path (tactical / Elite) — not wired into meme bot.
 */
export function ingestAndDetectSequence(
  input: IngestOrderFlowInput
): SequenceHit | null {
  const now = input.now ?? Date.now()

  let oi: OiSnapshot | null = null
  if (input.openInterest != null && input.openInterest > 0 && input.price > 0) {
    recordOiSample(input.symbol, input.openInterest, input.price, now)
    oi = getOiSnapshot(input.symbol, 15 * 60_000, now)
  } else {
    oi = getOiSnapshot(input.symbol, 15 * 60_000, now)
  }

  const frames = buildFrames(input, now, oi)
  if (frames.length) pushFrames(input.symbol, frames)

  const whale = input.whale
  const support = whale?.strongestSupport ?? null
  const resist = whale?.strongestResistance ?? null

  const recentEvents = input.wallEvents ?? []
  const wallEatenBid = recentEvents.some(
    (e) => e.type === 'EATEN' && e.wall.side === 'BID' && now - e.timestamp < 60_000
  )
  const wallEatenAsk = recentEvents.some(
    (e) => e.type === 'EATEN' && e.wall.side === 'ASK' && now - e.timestamp < 60_000
  )

  const walls = input.walls ?? []
  const bidWallAlive =
    Boolean(support) ||
    walls.some((w) => w.side === 'BID' && w.volume * w.price >= 400_000)
  const askWallAlive =
    Boolean(resist) ||
    walls.some((w) => w.side === 'ASK' && w.volume * w.price >= 400_000)

  const cvd = input.cvd
  const ctx: SequenceEvalContext = {
    symbol: input.symbol,
    price: input.price,
    regime: input.regime,
    supportPrice: support?.price,
    supportUsd: support?.volumeUsd,
    supportDistPct: support?.distancePct,
    resistPrice: resist?.price,
    resistUsd: resist?.volumeUsd,
    resistDistPct: resist?.distancePct,
    buyVol: cvd?.buyVolume,
    sellVol: cvd?.sellVolume,
    cumulativeDelta: cvd?.cumulativeDelta,
    aggressionBuyPct: cvd?.aggression,
    cvdDivergence: cvd?.divergenceType ?? null,
    cvdHasDivergence: cvd?.divergence === true,
    bidWallAlive,
    askWallAlive,
    wallEatenBid,
    wallEatenAsk,
    bookImbalance: input.bookImbalance,
    oi,
    now,
  }

  const candidates = [
    detectWallAbsorptionExhaustion(ctx),
    detectCvdDivergenceLimit(ctx),
    detectWallRelease(ctx),
    detectOiDeltaConfirm(ctx),
  ].filter((h): h is SequenceHit => h != null && h.expiresAt >= now)

  if (!candidates.length) return null

  // Prefer allowed-in-regime, then confidence
  candidates.sort((a, b) => {
    const aOk = a.allowedInRegime ? 1 : 0
    const bOk = b.allowedInRegime ? 1 : 0
    if (bOk !== aOk) return bOk - aOk
    return b.confidence - a.confidence
  })

  const best = candidates[0]!
  return applySequenceHistWr(best, input.symbol)
}

function buildFrames(
  input: IngestOrderFlowInput,
  now: number,
  oi: OiSnapshot | null
): MarketFrame[] {
  const out: MarketFrame[] = []

  out.push({
    at: now,
    kind: 'REGIME',
    side: 'FLAT',
    label: input.regime,
    strength:
      input.regime === 'TRENDING_STRONG'
        ? 1
        : input.regime === 'VOLATILE_CHOP'
          ? 0.9
          : input.regime === 'TRENDING_WEAK'
            ? 0.55
            : 0.4,
  })

  if (input.bookImbalance != null) {
    out.push({
      at: now,
      kind: 'BOOK',
      side:
        input.bookImbalance > 8
          ? 'BID'
          : input.bookImbalance < -8
            ? 'ASK'
            : 'FLAT',
      strength: Math.min(1, Math.abs(input.bookImbalance) / 100),
      meta: { imbalance: input.bookImbalance },
    })
  }

  if (oi) {
    out.push({
      at: now,
      kind: 'OI',
      side:
        oi.changePct > 0.3 ? 'BUY' : oi.changePct < -0.3 ? 'SELL' : 'FLAT',
      strength: Math.min(1, Math.abs(oi.changePct) / 3),
      label: oi.divergenceType,
      meta: {
        changePct: oi.changePct,
        priceChangePct: oi.priceChangePct,
        confirms: oi.confirmsMove,
      },
    })
  }

  const whale = input.whale
  if (whale?.strongestSupport) {
    const w = whale.strongestSupport
    out.push({
      at: now,
      kind: 'WALL',
      side: 'BID',
      price: w.price,
      volumeUsd: w.volumeUsd,
      strength: Math.min(1, w.volumeUsd / 5_000_000),
      label: 'WHALE_BID',
      meta: { distancePct: w.distancePct },
    })
  }
  if (whale?.strongestResistance) {
    const w = whale.strongestResistance
    out.push({
      at: now,
      kind: 'WALL',
      side: 'ASK',
      price: w.price,
      volumeUsd: w.volumeUsd,
      strength: Math.min(1, w.volumeUsd / 5_000_000),
      label: 'WHALE_ASK',
      meta: { distancePct: w.distancePct },
    })
  }

  for (const e of input.wallEvents ?? []) {
    if (now - e.timestamp > 30_000) continue
    out.push({
      at: e.timestamp,
      kind: 'WALL',
      side: e.wall.side,
      price: e.wall.price,
      volumeUsd: e.wall.currentVolume * e.wall.price,
      strength: e.type === 'EATEN' ? 1 : e.type === 'SPOOFED' ? 0.8 : 0.5,
      label: e.type,
    })
  }

  const trades = input.trades ?? []
  if (trades.length >= 4) {
    const cut = now - 60_000
    let buyUsd = 0
    let sellUsd = 0
    let buyN = 0
    let sellN = 0
    for (const t of trades) {
      if (t.timestamp < cut) continue
      const usd = t.price * t.volume
      if (t.side === 'BUY') {
        buyUsd += usd
        buyN++
      } else {
        sellUsd += usd
        sellN++
      }
    }
    if (buyUsd > 0) {
      out.push({
        at: now,
        kind: 'HIT',
        side: 'BUY',
        volumeUsd: buyUsd,
        strength: Math.min(1, buyUsd / 2_000_000),
        meta: { count: buyN },
      })
    }
    if (sellUsd > 0) {
      out.push({
        at: now,
        kind: 'HIT',
        side: 'SELL',
        volumeUsd: sellUsd,
        strength: Math.min(1, sellUsd / 2_000_000),
        meta: { count: sellN },
      })
    }
  }

  if (input.cvd) {
    out.push({
      at: now,
      kind: 'DELTA',
      side:
        input.cvd.trend === 'BULLISH'
          ? 'BUY'
          : input.cvd.trend === 'BEARISH'
            ? 'SELL'
            : 'FLAT',
      volumeUsd: Math.abs(input.cvd.cumulativeDelta),
      strength: Math.min(1, Math.abs(input.cvd.aggression - 50) / 50),
      label: input.cvd.divergenceType,
      meta: {
        aggression: input.cvd.aggression,
        divergence: input.cvd.divergence,
      },
    })
  }

  return out
}
