/**
 * Mini-app-style situational map for Elite VANE:
 * HTF strength + multi-factor direction + zone ranking (hold vs break).
 * Runs inside the worker — parallel to chart findTradeZones/directionConsensus.
 */

import type { Candle, Side, VanePath, VaneZoneGeom, ZoneGrade } from './types'

export type ArrowBias = 'UP' | 'DOWN' | 'FLAT'

export interface HtfTrendLite {
  bias: 'BULLISH' | 'BEARISH' | 'RANGING'
  strength: number
  label: 'WEAK' | 'MEDIUM' | 'STRONG'
  primaryTf: '1h' | '4h'
  reasons: string[]
}

export interface DirectionConsensusLite {
  bias: ArrowBias
  confidence: number
  netScore: number
  summary: string
  votes: string[]
}

export interface ZoneRank {
  score: number
  preferPath: VanePath
  holdHint: string
  factors: string[]
}

function closes(c: Candle[]): number[] {
  return c.map((x) => x[4])
}

function swingBias(
  candles: Candle[],
  lookback: number
): { bias: HtfTrendLite['bias']; strength: number; reasons: string[] } {
  const reasons: string[] = []
  if (candles.length < 24) {
    return { bias: 'RANGING', strength: 35, reasons: ['мало свечей'] }
  }
  const slice = candles.slice(-Math.min(lookback, candles.length))
  const px = closes(slice)
  const last = px[px.length - 1]!
  const sma =
    px.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, px.length)
  const mom =
    px.length >= 7 ? ((last - px[px.length - 7]!) / px[px.length - 7]!) * 100 : 0

  // Simple HH/HL vs LH/LL from 3-bar pivots
  const highs: number[] = []
  const lows: number[] = []
  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i]![2]
    const l = slice[i]![3]
    if (
      h >= slice[i - 1]![2] &&
      h >= slice[i - 2]![2] &&
      h >= slice[i + 1]![2] &&
      h >= slice[i + 2]![2]
    ) {
      highs.push(h)
    }
    if (
      l <= slice[i - 1]![3] &&
      l <= slice[i - 2]![3] &&
      l <= slice[i + 1]![3] &&
      l <= slice[i + 2]![3]
    ) {
      lows.push(l)
    }
  }
  const hs = highs.slice(-4)
  const ls = lows.slice(-4)
  let bullLegs = 0
  let bearLegs = 0
  for (let i = 1; i < hs.length; i++) {
    if (hs[i]! > hs[i - 1]!) bullLegs++
    if (hs[i]! < hs[i - 1]!) bearLegs++
  }
  for (let i = 1; i < ls.length; i++) {
    if (ls[i]! > ls[i - 1]!) bullLegs++
    if (ls[i]! < ls[i - 1]!) bearLegs++
  }

  let bias: HtfTrendLite['bias'] = 'RANGING'
  if (bullLegs >= bearLegs + 2 && last >= sma && mom > -0.3) bias = 'BULLISH'
  else if (bearLegs >= bullLegs + 2 && last <= sma && mom < 0.3) bias = 'BEARISH'
  else if (last > sma * 1.008 && mom > 0.6) bias = 'BULLISH'
  else if (last < sma * 0.992 && mom < -0.6) bias = 'BEARISH'

  let strength = 40
  if (bias === 'RANGING') {
    strength = 32 + Math.min(12, Math.abs(bullLegs - bearLegs) * 3)
    reasons.push('range / смешанная структура')
  } else {
    strength = 48 + Math.min(28, Math.max(bullLegs, bearLegs) * 6)
    if (Math.abs(mom) > 1.2) strength += 8
    if (
      (bias === 'BULLISH' && last > sma) ||
      (bias === 'BEARISH' && last < sma)
    ) {
      strength += 6
    }
    reasons.push(
      `${bias === 'BULLISH' ? 'HH/HL' : 'LH/LL'} · mom ${mom >= 0 ? '+' : ''}${mom.toFixed(1)}%`
    )
  }
  return {
    bias,
    strength: Math.min(92, Math.round(strength)),
    reasons,
  }
}

/** Lightweight 1H+4H strength — chart analogue of computeHtfTrendStrength */
export function computeHtfTrendLite(
  candles1h: Candle[],
  candles4h: Candle[]
): HtfTrendLite {
  const s1 = swingBias(candles1h, 48)
  const s4 = swingBias(candles4h, 60)
  const strength = Math.round(s4.strength * 0.62 + s1.strength * 0.38)
  let bias: HtfTrendLite['bias'] = 'RANGING'
  if (s4.bias === s1.bias && s4.bias !== 'RANGING') bias = s4.bias
  else if (s4.bias !== 'RANGING' && s4.strength >= s1.strength) bias = s4.bias
  else if (s1.bias !== 'RANGING' && s1.strength > s4.strength + 8) bias = s1.bias
  else if (s4.bias !== 'RANGING') bias = s4.bias

  const label: HtfTrendLite['label'] =
    strength >= 72 ? 'STRONG' : strength >= 52 ? 'MEDIUM' : 'WEAK'
  return {
    bias,
    strength,
    label,
    primaryTf: s4.strength >= s1.strength ? '4h' : '1h',
    reasons: [
      `4H ${s4.bias} ${s4.strength}`,
      `1H ${s1.bias} ${s1.strength}`,
      ...s4.reasons.slice(0, 1),
    ],
  }
}

function pushVote(
  votes: string[],
  label: string,
  side: ArrowBias,
  weight: number,
  acc: { up: number; down: number }
) {
  if (side === 'FLAT' || weight <= 0) return
  if (side === 'UP') acc.up += weight
  else acc.down += weight
  votes.push(`${label}:${side}×${weight.toFixed(1)}`)
}

/**
 * Multi-factor direction — chart analogue of computeDirectionConsensus
 * (without news/MM/fib; uses HTF + regime + book + zone map).
 */
export function computeVaneDirection(opts: {
  htf: HtfTrendLite
  bias4h: 'BULL' | 'BEAR' | 'FLAT'
  bias1d: 'BULL' | 'BEAR' | 'FLAT'
  regime: string
  bookGrade: ZoneGrade
  bookSide: Side
  nearestLongDist: number | null
  nearestShortDist: number | null
}): DirectionConsensusLite {
  const votes: string[] = []
  const acc = { up: 0, down: 0 }

  if (opts.htf.bias === 'BULLISH') {
    pushVote(votes, 'HTF', 'UP', 1.4 * Math.min(1, opts.htf.strength / 80), acc)
  } else if (opts.htf.bias === 'BEARISH') {
    pushVote(votes, 'HTF', 'DOWN', 1.4 * Math.min(1, opts.htf.strength / 80), acc)
  }

  if (opts.bias4h === 'BULL') pushVote(votes, '4H', 'UP', 1.1, acc)
  if (opts.bias4h === 'BEAR') pushVote(votes, '4H', 'DOWN', 1.1, acc)
  if (opts.bias1d === 'BULL') pushVote(votes, '1D', 'UP', 0.9, acc)
  if (opts.bias1d === 'BEAR') pushVote(votes, '1D', 'DOWN', 0.9, acc)

  if (opts.regime === 'TRENDING_STRONG' || opts.regime === 'TRENDING_WEAK') {
    if (opts.bias4h === 'BULL') pushVote(votes, 'regime', 'UP', 0.8, acc)
    if (opts.bias4h === 'BEAR') pushVote(votes, 'regime', 'DOWN', 0.8, acc)
  }

  // Live book: STRONG on long zone → UP pressure near support
  if (opts.bookGrade === 'STRONG') {
    pushVote(
      votes,
      'book',
      opts.bookSide === 'LONG' ? 'UP' : 'DOWN',
      1.2,
      acc
    )
  } else if (opts.bookGrade === 'WEAK') {
    pushVote(
      votes,
      'book',
      opts.bookSide === 'LONG' ? 'DOWN' : 'UP',
      1.0,
      acc
    )
  }

  // Near SSL vs BSL magnet
  if (
    opts.nearestLongDist != null &&
    (opts.nearestShortDist == null ||
      opts.nearestLongDist <= opts.nearestShortDist)
  ) {
    if (opts.nearestLongDist <= 2.5) pushVote(votes, 'SSL', 'UP', 0.7, acc)
  }
  if (
    opts.nearestShortDist != null &&
    (opts.nearestLongDist == null ||
      opts.nearestShortDist < (opts.nearestLongDist ?? 99))
  ) {
    if (opts.nearestShortDist <= 2.5) pushVote(votes, 'BSL', 'DOWN', 0.7, acc)
  }

  const net = acc.up - acc.down
  const tot = acc.up + acc.down
  const bias: ArrowBias =
    tot < 0.4 ? 'FLAT' : net > 0.35 ? 'UP' : net < -0.35 ? 'DOWN' : 'FLAT'
  const confidence =
    tot <= 0 ? 0 : Math.min(92, Math.round((Math.abs(net) / tot) * 100))

  const arrow = bias === 'UP' ? '↑' : bias === 'DOWN' ? '↓' : '→'
  return {
    bias,
    confidence,
    netScore: tot > 0 ? net / tot : 0,
    summary: `${arrow} ${bias} ${confidence}% · HTF ${opts.htf.label} ${opts.htf.strength}`,
    votes,
  }
}

export function directionAligns(bias: ArrowBias, side: Side): boolean {
  if (bias === 'FLAT') return true // neutral — don't block
  if (side === 'LONG') return bias === 'UP'
  return bias === 'DOWN'
}

export function directionConflicts(bias: ArrowBias, side: Side): boolean {
  if (bias === 'FLAT') return false
  if (side === 'LONG') return bias === 'DOWN'
  return bias === 'UP'
}

/** Rank zone like mini-app win% heuristic + pick HOLD vs FLIP preference */
export function rankZoneCandidate(opts: {
  side: Side
  zone: VaneZoneGeom
  price: number
  isInternal: boolean
  oppositeLiq: number | null
  direction: DirectionConsensusLite
  bookGrade: ZoneGrade
  phase: 'FAR' | 'APPROACH' | 'TOUCH'
}): ZoneRank {
  const factors: string[] = []
  let score = 40
  const distPct =
    (Math.abs(opts.zone.mid - opts.price) / opts.price) * 100

  score += Math.min(18, opts.zone.strength * 2)
  factors.push(`str ${opts.zone.strength}`)
  if (opts.zone.touches >= 3) {
    score += 10
    factors.push(`touches ${opts.zone.touches}`)
  } else if (opts.zone.touches >= 2) {
    score += 6
  }

  if (!opts.isInternal) {
    score += opts.zone.tf === '1D' ? 12 : 8
    factors.push(`HTF ${opts.zone.tf}`)
  } else {
    score += 3
  }

  // Closer = better (but TOUCH already best)
  score += Math.max(0, 12 - distPct * 3)
  if (opts.phase === 'TOUCH') score += 10
  else if (opts.phase === 'APPROACH') score += 5

  const aligns = directionAligns(opts.direction.bias, opts.side)
  const conflicts = directionConflicts(opts.direction.bias, opts.side)
  if (aligns && opts.direction.bias !== 'FLAT') {
    score += 8 + Math.round(opts.direction.confidence / 20)
    factors.push('направление с зоной')
  } else if (conflicts && opts.direction.confidence >= 55) {
    score -= 12
    factors.push('направление против зоны')
  }

  // Target quality (opposite liq)
  if (opts.oppositeLiq != null && opts.oppositeLiq > 0) {
    const tpPct =
      opts.side === 'LONG'
        ? ((opts.oppositeLiq - opts.price) / opts.price) * 100
        : ((opts.price - opts.oppositeLiq) / opts.price) * 100
    if (tpPct >= 1.2 && tpPct <= 4.5) {
      score += 8
      factors.push(`цель ${tpPct.toFixed(1)}%`)
    }
  }

  // Prefer path: hold if book not WEAK and direction ok; else flip lean
  let preferPath: VanePath = 'HOLD'
  let holdHint = 'удерж'
  if (opts.bookGrade === 'WEAK' || (conflicts && opts.direction.confidence >= 60)) {
    preferPath = 'FLIP'
    holdHint = 'слом → flip'
  } else if (opts.bookGrade === 'STRONG' && aligns) {
    holdHint = 'крепление · цель от зоны'
  } else if (opts.bookGrade === 'NEUTRAL' && opts.zone.touches >= 2) {
    holdHint = 'вероятный отскок'
  }

  if (preferPath === 'HOLD' && aligns) score += 5

  return {
    score: Math.round(score),
    preferPath,
    holdHint,
    factors,
  }
}
