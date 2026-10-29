import type { TrackedWall, WallEvent } from '../types'

export interface SpoofAlert {
  detected: boolean
  side: 'BID' | 'ASK' | null
  price: number
  volumeUsdApprox: number
  lifetimeMs: number
  approachPct: number
  label: string
  emoji: string
  /** Confidence should not rise from this wall */
  ignoreForConfidence: boolean
}

/**
 * Polling (REST/WS snapshots) has 1–2 s jitter. A 2 s hard cap would miss
 * most real spoofs and label normal latency as "long-lived". Allow 5 s, but
 * only near the touch — a far wall disappearing is just a quote change.
 */
const SPOOF_MAX_AGE_MS = 5_000
const APPROACH_PCT = 0.35
const MIN_WALL_USD = 50_000

export interface SpoofContext {
  /** Average USD size of the first 10 book levels */
  avgTop10Usd?: number | null
  /** 24h quote volume in USD */
  advUsd?: number | null
}

function dynamicWallFloorUsd(ctx: SpoofContext = {}): number {
  const top10 = ctx.avgTop10Usd != null && ctx.avgTop10Usd > 0 ? ctx.avgTop10Usd : 0
  const advPerMin =
    ctx.advUsd != null && ctx.advUsd > 0 ? ctx.advUsd / 1440 : 0
  const candidates = [MIN_WALL_USD]
  if (top10 > 0) candidates.push(top10 * 5)
  if (advPerMin > 0) candidates.push(advPerMin * 0.02)
  // The smallest meaningful anchor wins: alts/metals must not need $500k.
  return Math.max(MIN_WALL_USD, Math.min(...candidates.filter((n) => n > 0)))
}

/**
 * Спуфинг: крупная стена появилась и исчезла при подходе цены.
 * Вызывать когда стена пропала без EATEN (объём не съеден лентой).
 */
export function detectSpoofFromDisappear(params: {
  wall: TrackedWall
  disappearedAt: number
  midPrice: number
  /** Approx USD: price * volume (contracts may need multiplier — best-effort) */
  volumeUsd: number
  context?: SpoofContext
}): SpoofAlert | null {
  const lifetimeMs = params.disappearedAt - params.wall.firstSeen
  if (lifetimeMs > SPOOF_MAX_AGE_MS) return null

  const minWallUsd = dynamicWallFloorUsd(params.context)
  if (params.volumeUsd < minWallUsd) return null

  const approachPct =
    (Math.abs(params.midPrice - params.wall.price) / params.midPrice) * 100
  // Far walls are allowed to be repriced; only touch/near-touch disappearance
  // is information about intent.
  if (approachPct > APPROACH_PCT * 3) return null

  const nearApproach = approachPct <= APPROACH_PCT
  if (!nearApproach && lifetimeMs > 2_500) return null

  return {
    detected: true,
    side: params.wall.side,
    price: params.wall.price,
    volumeUsdApprox: params.volumeUsd,
    lifetimeMs,
    approachPct,
    emoji: '',
    label: `SPOOFING: ${params.wall.side} wall $${(params.volumeUsd / 1000).toFixed(0)}k исчезла за ${(lifetimeMs / 1000).toFixed(1)}с (порог $${(minWallUsd / 1000).toFixed(0)}k)`,
    ignoreForConfidence: true,
  }
}

/**
 * Стена «убегает» от цены (переставляется дальше) — ММ хочет движение в её сторону.
 */
export function detectFleeingWall(params: {
  previousPrice: number
  currentPrice: number
  midPrice: number
  side: 'BID' | 'ASK'
}): boolean {
  const { previousPrice, currentPrice, midPrice, side } = params
  if (side === 'ASK') {
    // Ask wall moves higher as price rises toward it
    return currentPrice > previousPrice && midPrice > previousPrice * 0.999
  }
  // Bid wall moves lower as price falls toward it
  return currentPrice < previousPrice && midPrice < previousPrice * 1.001
}

/**
 * Реальная стена ММ: живёт долго И объём снижается (absorption), не исчезает
 * целиком. There is no upper bound: eating 80% and still holding is peak
 * absorption, not a fake wall.
 */
export function isRealMmWall(wall: TrackedWall, now = Date.now()): boolean {
  const age = now - wall.firstSeen
  if (age < 10_000) return false
  const eaten =
    wall.initialVolume > 0
      ? (wall.initialVolume - wall.currentVolume) / wall.initialVolume
      : 0
  return wall.isActive && wall.currentVolume > 0 && eaten > 0.05
}

export function spoofEventsFromWallUpdate(
  newEvents: WallEvent[],
  midPrice: number | null,
  context: SpoofContext = {}
): SpoofAlert[] {
  if (midPrice == null || midPrice <= 0) return []
  const alerts: SpoofAlert[] = []

  for (const ev of newEvents) {
    if (ev.type !== 'SPOOFED') continue
    const volumeUsd = ev.wall.price * ev.wall.currentVolume
    const alert = detectSpoofFromDisappear({
      wall: ev.wall,
      disappearedAt: ev.timestamp,
      midPrice,
      volumeUsd,
      context,
    })
    if (alert) alerts.push(alert)
  }
  return alerts
}
