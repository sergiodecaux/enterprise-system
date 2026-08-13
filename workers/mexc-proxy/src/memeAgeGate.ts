/**
 * When a meme is even tradeable — chaos / launch / distribution / zombie.
 */

import type { MemeRegime } from './memeRegimeDetector'
import type { MemeVolumeProfile } from './memeVolumeProfile'

export type MemeSignalType = 'PEAK_SHORT' | 'PUMP_CONTINUE' | 'DUMP_CONTINUATION'

export interface MemeAgeGateResult {
  tradeable: boolean
  allowed_signals: MemeSignalType[]
  reason: string
}

export function memeAgeGate(opts: {
  age_minutes: number
  vol_ratio: number
  profile: MemeVolumeProfile
  regime: MemeRegime
  /** vol was low before current spike (relaunch) */
  vol_decay_was_low?: boolean
}): MemeAgeGateResult {
  const age = opts.age_minutes
  const vol_decay = 1 - Math.min(1, Math.max(0, opts.vol_ratio))
  const vol_ratio = opts.vol_ratio

  // First 8 minutes — chaos
  if (age < 8) {
    return {
      tradeable: false,
      allowed_signals: [],
      reason: 'TOO_EARLY: chaos phase',
    }
  }

  // RELAUNCH — second wind, LONG only
  if (
    opts.regime === 'RELAUNCH' ||
    (age > 30 &&
      opts.profile.vol_5m > opts.profile.vol_peak_5m * 0.55 &&
      Boolean(opts.vol_decay_was_low))
  ) {
    return {
      tradeable: true,
      allowed_signals: ['PUMP_CONTINUE'],
      reason: 'RELAUNCH: second wind',
    }
  }

  // Zombie — old + dead volume
  if (age > 60 && vol_ratio < 0.12) {
    return {
      tradeable: false,
      allowed_signals: [],
      reason: 'ZOMBIE: no edge',
    }
  }

  // 8–20m + volume still strong — LONG only
  if (age < 20 && vol_ratio > 0.5) {
    return {
      tradeable: true,
      allowed_signals: ['PUMP_CONTINUE'],
      reason: 'LAUNCH_PHASE: only long allowed',
    }
  }

  // Distribution window — both (and dump cont on dump day handled separately)
  if (age >= 15 && vol_ratio < 0.45) {
    return {
      tradeable: true,
      allowed_signals: ['PEAK_SHORT', 'PUMP_CONTINUE', 'DUMP_CONTINUATION'],
      reason: 'DISTRIBUTION_WINDOW',
    }
  }

  // Mid window with mixed volume
  if (age >= 12 && age <= 50) {
    return {
      tradeable: true,
      allowed_signals: ['PEAK_SHORT', 'PUMP_CONTINUE'],
      reason: 'MID_WINDOW: both with filters',
    }
  }

  // Flush / dead cat — allow dump continuation shorts only
  if (opts.regime === 'FLUSH' || opts.regime === 'DEAD_CAT') {
    return {
      tradeable: true,
      allowed_signals: ['DUMP_CONTINUATION'],
      reason: 'FLUSH_WINDOW: continuation short only',
    }
  }

  return {
    tradeable: false,
    allowed_signals: [],
    reason: 'NO_WINDOW',
  }
}

export function ageAllows(
  gate: MemeAgeGateResult,
  signal: MemeSignalType
): boolean {
  return gate.tradeable && gate.allowed_signals.includes(signal)
}
