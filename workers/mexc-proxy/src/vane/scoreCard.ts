import type { MarketRegime } from '../regime'
import {
  MIN_VANE_SCORE,
  TIER1_SCORE,
  type Side,
  type VanePath,
  type VaneTier,
  type ZoneGrade,
} from './types'

export interface VaneScoreInput {
  side: Side
  path: VanePath
  hasHtfZone: boolean
  zoneStrength: number
  zoneTf: '4H' | '1D' | '15m'
  confluence: boolean
  sweepReclaim: boolean
  absorptionOrCvd: boolean
  wallPersistOk: boolean
  zoneGrade: ZoneGrade
  btcAlignScore: number
  dailyAlign: boolean
  regime: MarketRegime
  toxicBook: boolean
  /** Mini-app-style extras */
  directionAlign?: boolean
  directionConfidence?: number
  htfStrength?: number
  zoneRankScore?: number
  holdHintClear?: boolean
}

export interface VaneScoreResult {
  score: number
  tier: VaneTier | null
  factors: string[]
  ready: boolean
}

/**
 * 100-point vane ScoreCard.
 * <55 ignore · 55–74 Tier-2 · ≥75 Tier-1 (rich-context boosts)
 */
export function buildVaneScoreCard(input: VaneScoreInput): VaneScoreResult {
  const factors: string[] = []
  let score = 0

  // HOLD into toxic book = skip; FLIP into weak book is the point
  if (input.toxicBook && input.path === 'HOLD') {
    return {
      score: 0,
      tier: null,
      factors: ['toxic book HOLD — SKIP'],
      ready: false,
    }
  }

  if (input.hasHtfZone && (input.zoneTf === '4H' || input.zoneTf === '1D')) {
    const pts = input.zoneStrength >= 7 ? 20 : input.zoneStrength >= 5 ? 16 : 12
    score += pts
    factors.push(`HTF зона +${pts}`)
  } else if (input.zoneTf === '15m') {
    score += 12
    factors.push('15m internal +12')
  }

  if (input.confluence) {
    score += 15
    factors.push('confluence Fib/FVG/OB +15')
  }

  if (input.sweepReclaim) {
    score += 15
    factors.push('sweep+reclaim +15')
  }

  if (input.absorptionOrCvd) {
    score += 15
    factors.push('CVD/absorption +15')
  }

  if (input.wallPersistOk && input.zoneGrade === 'STRONG') {
    score += 10
    factors.push('persistent wall +10')
  } else if (input.wallPersistOk) {
    score += 5
    factors.push('wall persist soft +5')
  } else if (input.zoneGrade === 'STRONG') {
    score += 4
    factors.push('book STRONG soft +4')
  } else if (input.zoneGrade === 'NEUTRAL' && input.path === 'HOLD') {
    score += 2
    factors.push('book NEUTRAL soft +2')
  }

  score += Math.min(10, Math.max(0, input.btcAlignScore))
  factors.push(`BTC align +${Math.min(10, input.btcAlignScore)}`)

  if (input.dailyAlign) {
    score += 5
    factors.push('Daily trend +5')
  }

  // Regime-compatible path
  const ranging =
    input.regime === 'RANGING' || input.regime === 'VOLATILE_CHOP'
  const trending =
    input.regime === 'TRENDING_STRONG' || input.regime === 'TRENDING_WEAK'
  if (ranging && input.path === 'HOLD') {
    score += 10
    factors.push('regime flat→fade +10')
  } else if (trending && input.path === 'FLIP') {
    score += 10
    factors.push('regime trend→flip +10')
  } else if (trending && input.path === 'HOLD') {
    score += 5
    factors.push('regime trend fade soft +5')
  } else if (ranging && input.path === 'FLIP') {
    score += 0
    factors.push('regime flat blocks flip weight')
  }

  // Rich context (mini-app parity)
  if (input.directionAlign && (input.directionConfidence ?? 0) >= 45) {
    const pts = Math.min(12, 6 + Math.round((input.directionConfidence ?? 0) / 20))
    score += pts
    factors.push(`направление +${pts}`)
  }
  if ((input.htfStrength ?? 0) >= 60) {
    score += 6
    factors.push(`HTF strength ${input.htfStrength} +6`)
  } else if ((input.htfStrength ?? 0) >= 48) {
    score += 3
    factors.push(`HTF strength ${input.htfStrength} +3`)
  }
  if ((input.zoneRankScore ?? 0) >= 70) {
    score += 6
    factors.push(`zone rank ${input.zoneRankScore} +6`)
  } else if ((input.zoneRankScore ?? 0) >= 55) {
    score += 3
    factors.push(`zone rank ${input.zoneRankScore} +3`)
  }
  if (input.holdHintClear) {
    score += 4
    factors.push('сценарий удерж/цель +4')
  }

  score = Math.min(100, Math.round(score))
  let tier: VaneTier | null = null
  if (score >= TIER1_SCORE) tier = 'TIER1'
  else if (score >= MIN_VANE_SCORE) tier = 'TIER2'

  return {
    score,
    tier,
    factors,
    ready: tier != null,
  }
}

/** FLAT → flip forbidden; TREND counter-fade → 0.75× size (was 0.5) */
export function vaneRegimePolicy(opts: {
  regime: MarketRegime
  path: VanePath
  /** When direction strongly aligns with HOLD, allow full size even in trend */
  directionAlign?: boolean
}): { ok: boolean; sizeMult: number; reason?: string } {
  const ranging =
    opts.regime === 'RANGING' || opts.regime === 'VOLATILE_CHOP'
  const trending =
    opts.regime === 'TRENDING_STRONG' || opts.regime === 'TRENDING_WEAK'

  if (ranging && opts.path === 'FLIP') {
    return {
      ok: false,
      sizeMult: 0,
      reason: 'флэт: S/R Flip запрещён (пила)',
    }
  }
  if (trending && opts.path === 'HOLD') {
    if (opts.directionAlign) {
      return { ok: true, sizeMult: 1, reason: 'тренд+направление: full' }
    }
    return { ok: true, sizeMult: 0.75, reason: 'тренд: fade 0.75×' }
  }
  return { ok: true, sizeMult: 1 }
}
