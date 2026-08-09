import type { MexcTrade } from '../../api/mexc'
import type { MarketRegime } from '../regime/marketRegime'
import type { EnhancedCvdSnapshot } from '../orderflow/enhancedCvd'
import type { WhaleWatcherState, WallEvent, OrderBookWall } from '../types'
import { pushFrames, getFrames } from './frameBus'
import { detectWallAbsorptionExhaustion } from './wallAbsorptionExhaustion'
import { detectCvdDivergenceLimit } from './cvdDivergenceLimit'
import { detectWallRelease } from './wallRelease'
import { detectOiDeltaConfirm } from './oiDeltaConfirm'
import { detectTrappedTraders } from './trappedTraders'
import { getOiSnapshot, recordOiSample, type OiSnapshot } from './oiTracker'
import { applySequenceHistWr } from './sequenceJournal'
import { inferLiquidationBurst, liqToFrame } from './liqInfer'
import {
  getHitZScore,
  getSigmaZScore,
  recordHitSample,
  recordSigmaSample,
  blendSigmaMuls,
  passesAnomalyGate,
} from './sigmaBaseline'
import {
  deltaFromTrades,
  getCachedSpotPerpHealth,
  spotPerpToFrame,
} from './spotPerpHealth'
import {
  evaluateVenueLead,
  getVenueLeadCache,
  venueLeadToFrame,
} from './venueLead'
import {
  announceSequenceSound,
  playProcessSound,
} from './processAudio'
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
  /** When false, skip Binance lead (already applied via cache) */
  useVenueLead?: boolean
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
    if (oi && oi.changePct >= 0.85) {
      playProcessSound('OI_RISE', Math.min(1, oi.changePct / 2))
    }
  } else {
    oi = getOiSnapshot(input.symbol, 15 * 60_000, now)
  }

  const liq = inferLiquidationBurst(input.trades, now)
  if (liq) playProcessSound('LIQ', Math.min(1, liq.usd / 400_000))

  const frames = buildFrames(input, now, oi, liq)
  if (frames.length) pushFrames(input.symbol, frames)

  // Sigma baselines: HIT + DELTA + WALL (anomaly-only confidence)
  const hitFrames = frames.filter((f) => f.kind === 'HIT')
  let hitUsdWindow = 0
  for (const f of hitFrames) {
    const usd = f.volumeUsd ?? 0
    hitUsdWindow += usd
    if (usd > 0) {
      recordHitSample(input.symbol, usd, now)
      playProcessSound(
        f.side === 'BUY' ? 'HIT_BUY' : 'HIT_SELL',
        Math.min(1, usd / 500_000)
      )
    }
  }
  const recentHits = getFrames(input.symbol, 5 * 60_000, now).filter(
    (f) => f.kind === 'HIT'
  )
  const hit5m = recentHits.reduce((s, f) => s + (f.volumeUsd ?? 0), 0)
  const zInfo = getHitZScore(input.symbol, hit5m || hitUsdWindow, now)

  const perpDelta = deltaFromTrades(input.trades, 5 * 60_000, now)
  const deltaAbsUsd = Math.abs(perpDelta)
  if (deltaAbsUsd > 0) {
    recordSigmaSample(input.symbol, 'DELTA', deltaAbsUsd, now)
  }
  const deltaZ = getSigmaZScore(input.symbol, 'DELTA', deltaAbsUsd || 1, now)

  const wallUsd = Math.max(
    input.whale?.strongestSupport?.volumeUsd ?? 0,
    input.whale?.strongestResistance?.volumeUsd ?? 0,
    ...(input.walls ?? []).map((w) => w.volume * w.price)
  )
  if (wallUsd > 0) {
    recordSigmaSample(input.symbol, 'WALL', wallUsd, now)
  }
  const wallZ = getSigmaZScore(input.symbol, 'WALL', wallUsd || 1, now)
  const sigmaBlend = blendSigmaMuls([zInfo, deltaZ, wallZ])

  const spotPerp = getCachedSpotPerpHealth(input.symbol, perpDelta, now)
  if (spotPerp.status !== 'UNKNOWN') {
    pushFrames(input.symbol, [spotPerpToFrame(spotPerp, now)])
  }

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
  if (wallEatenBid || wallEatenAsk) {
    playProcessSound('WALL_RELEASE', 0.8)
  }

  const walls = input.walls ?? []
  const bidWallAlive =
    Boolean(support) ||
    walls.some((w) => w.side === 'BID' && w.volume * w.price >= 400_000)
  const askWallAlive =
    Boolean(resist) ||
    walls.some((w) => w.side === 'ASK' && w.volume * w.price >= 400_000)

  const venueLead =
    input.useVenueLead === false
      ? null
      : getVenueLeadCache(input.symbol)
  const venueEval = evaluateVenueLead({
    localPrice: input.price,
    bidWallAlive,
    askWallAlive,
    lead: venueLead,
  })
  if (venueLead && venueEval.kind !== 'NONE') {
    pushFrames(input.symbol, [venueLeadToFrame(venueEval, venueLead, now)])
    if (venueEval.kind === 'ARB_WALL_RISK') {
      playProcessSound('WALL_RELEASE', 0.55)
    }
  }

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
    hitZScore: zInfo.z,
    hitIsAnomaly: zInfo.isAnomaly,
    spotPerpMul: spotPerp.confidenceMul,
    spotPerpStatus: spotPerp.status,
    liqUsd: liq?.usd ?? null,
    liqSide: liq?.side ?? null,
    venueLeadKind: venueEval.kind,
    venueLeadSide: venueEval.side,
    venueLeadMul: venueEval.confidenceMul,
  }

  const candidates = [
    detectTrappedTraders(ctx, zInfo),
    detectWallAbsorptionExhaustion(ctx),
    detectCvdDivergenceLimit(ctx),
    detectWallRelease(ctx),
    detectOiDeltaConfirm(ctx),
  ].filter((h): h is SequenceHit => h != null && h.expiresAt >= now)

  // Sigma soft demote when HIT/DELTA/WALL are all "normal noise"
  const adjusted = candidates.map((h) => {
    let conf = h.confidence
    const hitDriven =
      h.kind === 'WALL_ABSORPTION_EXHAUSTION' ||
      h.kind === 'TRAPPED_TRADERS' ||
      h.kind === 'WALL_RELEASE'
    if (hitDriven && sigmaBlend.anyReady && !sigmaBlend.anyAnomaly) {
      conf = Math.round(conf * 0.52)
    } else if (hitDriven && sigmaBlend.anyReady) {
      conf = Math.round(Math.min(92, conf * sigmaBlend.mul))
    } else if (hitDriven && zInfo.ready && !passesAnomalyGate(zInfo, { soft: true })) {
      conf = Math.round(conf * 0.55)
    }
    // Spot/perp health — dirty growth cuts hard
    if (spotPerp.status !== 'UNKNOWN') {
      conf = Math.round(Math.min(92, Math.max(30, conf * spotPerp.confidenceMul)))
    }
    // Fuel: trapped / liq exhaustion / spot-led get a bump
    if (h.kind === 'TRAPPED_TRADERS') conf = Math.min(92, conf + 3)
    if (liq && liq.usd >= 80_000) conf = Math.min(92, conf + 2)
    if (spotPerp.status === 'SPOT_LED') conf = Math.min(92, conf + 2)
    if (spotPerp.status === 'DIVERGED' || spotPerp.status === 'PERP_LED') {
      conf = Math.max(30, conf - 4)
    }
    // Binance lead: demote local wall bounce when arb risk; boost release with lead
    if (venueEval.kind === 'ARB_WALL_RISK') {
      if (
        h.kind === 'WALL_ABSORPTION_EXHAUSTION' &&
        venueEval.side &&
        h.side !== venueEval.side
      ) {
        conf = Math.round(conf * 0.55)
      }
      if (
        h.kind === 'WALL_RELEASE' &&
        venueEval.side &&
        h.side === venueEval.side
      ) {
        conf = Math.min(92, Math.round(conf * 1.12))
      }
      conf = Math.round(conf * venueEval.confidenceMul)
    } else if (venueEval.kind === 'LEAD_CONFIRM' && venueEval.side === h.side) {
      conf = Math.min(92, Math.round(conf * venueEval.confidenceMul))
    }
    return { ...h, confidence: conf }
  }).filter((h) => h.confidence >= 48)

  if (!adjusted.length) return null

  adjusted.sort((a, b) => {
    const aOk = a.allowedInRegime ? 1 : 0
    const bOk = b.allowedInRegime ? 1 : 0
    // Prefer trapped traders slightly when tied
    const aTrap = a.kind === 'TRAPPED_TRADERS' ? 1 : 0
    const bTrap = b.kind === 'TRAPPED_TRADERS' ? 1 : 0
    if (bOk !== aOk) return bOk - aOk
    if (bTrap !== aTrap && Math.abs(b.confidence - a.confidence) < 4) {
      return bTrap - aTrap
    }
    return b.confidence - a.confidence
  })

  const best = applySequenceHistWr(adjusted[0]!, input.symbol)
  const stamped: SequenceHit = {
    ...best,
    spotPerpStatus: spotPerp.status,
    liqUsd: liq?.usd ?? null,
    venueLeadKind: venueEval.kind !== 'NONE' ? venueEval.kind : null,
  }
  if (stamped.confidence >= 55 && stamped.allowedInRegime) {
    announceSequenceSound(stamped.kind, stamped.id, stamped.confidence)
  }
  return stamped
}

function buildFrames(
  input: IngestOrderFlowInput,
  now: number,
  oi: OiSnapshot | null,
  liq: ReturnType<typeof inferLiquidationBurst>
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

  if (liq) out.push(liqToFrame(liq))

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
