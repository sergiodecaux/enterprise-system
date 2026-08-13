/**
 * Meme regimes (not MM phase machine) — where the meme is in its life cycle.
 */

import type { MemeVolumeProfile } from './memeVolumeProfile'

export type MemeRegime =
  | 'LAUNCH'
  | 'FOMO_PEAK'
  | 'DISTRIBUTION'
  | 'FLUSH'
  | 'DEAD_CAT'
  | 'ZOMBIE'
  | 'RELAUNCH'

export interface MemeRegimeState {
  regime: MemeRegime
  age_minutes: number
  peak_distance: number
  volume_decay: number
  participant_exhaustion: number
  reasons: string[]
}

export interface MemeRegimeInput {
  profile: MemeVolumeProfile
  price: number
  obi?: number | null
  chg5mPct?: number | null
  /** Prior regime from KV */
  prevRegime?: MemeRegime | null
  /** Soft liq proxy: large adverse 5m move without needing liq feed */
  flushProxy?: boolean
}

export function detectMemeRegime(input: MemeRegimeInput): MemeRegimeState {
  const p = input.profile
  const ageMins = p.spike_age_minutes
  const volRatio = p.vol_ratio
  const distToPeak = p.peak_distance
  const volume_decay = p.post_spike_decay
  const reasons: string[] = [...p.reasons]
  const chg5 = input.chg5mPct ?? 0
  const obi = input.obi ?? 0
  const prev = input.prevRegime ?? null

  let regime: MemeRegime = 'ZOMBIE'

  // FLUSH: sharp dump
  if (chg5 <= -4 || input.flushProxy) {
    regime = 'FLUSH'
    reasons.push('regime:FLUSH')
  }
  // DEAD_CAT: after flush, weak bounce, dead volume
  else if (
    prev === 'FLUSH' &&
    chg5 > 1 &&
    volRatio < 0.15
  ) {
    regime = 'DEAD_CAT'
    reasons.push('regime:DEAD_CAT')
  }
  // RELAUNCH: age > 30, volume comes back after decay
  else if (
    ageMins > 30 &&
    volRatio > 0.55 &&
    p.spike_detected &&
    (prev === 'ZOMBIE' || prev === 'DISTRIBUTION' || prev === 'DEAD_CAT')
  ) {
    regime = 'RELAUNCH'
    reasons.push('regime:RELAUNCH')
  }
  // LAUNCH: young + volume still hot + already moved
  else if (
    ageMins < 15 &&
    volRatio > 0.55 &&
    p.chg_since_spike_pct > 4 &&
    p.spike_detected
  ) {
    regime = 'LAUNCH'
    reasons.push('regime:LAUNCH')
  }
  // FOMO_PEAK: mid-age, still near high, volume not dead
  else if (
    ageMins >= 10 &&
    ageMins <= 45 &&
    distToPeak < 0.02 &&
    volRatio > 0.35
  ) {
    regime = 'FOMO_PEAK'
    reasons.push('regime:FOMO_PEAK')
  }
  // DISTRIBUTION: near high, volume fading, ask pressure
  else if (
    distToPeak < 0.035 &&
    volRatio < 0.4 &&
    (obi <= -8 || p.decay_rate === 'FAST')
  ) {
    regime = 'DISTRIBUTION'
    reasons.push('regime:DISTRIBUTION')
  }
  // Soft DISTRIBUTION if near peak + decaying even without OBI
  else if (distToPeak < 0.03 && volume_decay >= 0.55 && ageMins >= 12) {
    regime = 'DISTRIBUTION'
    reasons.push('regime:DISTRIBUTION_soft')
  }
  // Soft LAUNCH if young spike still strong
  else if (ageMins < 20 && volRatio > 0.5 && p.spike_detected) {
    regime = 'LAUNCH'
    reasons.push('regime:LAUNCH_soft')
  } else {
    reasons.push('regime:ZOMBIE')
  }

  // Participant exhaustion proxy from volume decay + distance (0-1)
  const participant_exhaustion = Math.min(
    1,
    Math.max(
      0,
      volume_decay * 0.55 +
        (distToPeak < 0.02 ? 0.2 : 0) +
        (obi <= -10 ? 0.15 : 0) +
        (p.decay_rate === 'FAST' ? 0.15 : 0)
    )
  )

  return {
    regime,
    age_minutes: ageMins,
    peak_distance: distToPeak,
    volume_decay,
    participant_exhaustion: Number(participant_exhaustion.toFixed(3)),
    reasons,
  }
}
