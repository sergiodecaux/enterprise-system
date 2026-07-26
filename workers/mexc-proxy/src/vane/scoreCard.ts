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
}

export interface VaneScoreResult {
  score: number
  tier: VaneTier | null
  factors: string[]
  ready: boolean
}

/**
 * 100-point vane ScoreCard.
 * <70 ignore · 70–84 Tier-2 · ≥85 Tier-1
 */
export function buildVaneScoreCard(input: VaneScoreInput): VaneScoreResult {
  const factors: string[] = []
  let score = 0

  if (input.toxicBook) {
    return {
      score: 0,
      tier: null,
      factors: ['toxic book — SKIP'],
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

/** FLAT → flip forbidden; TREND counter-fade → 0.5× size */
export function vaneRegimePolicy(opts: {
  regime: MarketRegime
  path: VanePath
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
    return { ok: true, sizeMult: 0.5, reason: 'тренд: fade 0.5×' }
  }
  return { ok: true, sizeMult: 1 }
}
