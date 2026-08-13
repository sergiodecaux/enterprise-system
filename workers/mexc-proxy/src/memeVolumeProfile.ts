/**
 * Meme volume profile — spike already happened; watch post-spike decay.
 * (Not "quiet price + rising vol" — that is alt pre-move logic.)
 */

export type Candle = [number, number, number, number, number, number]

export type DecayRate = 'FAST' | 'NORMAL' | 'SLOW'

export interface MemeVolumeProfile {
  spike_detected: boolean
  spike_age_minutes: number
  post_spike_decay: number
  decay_rate: DecayRate
  vol_5m: number
  vol_peak_5m: number
  /** vol_5m / vol_peak_5m */
  vol_ratio: number
  chg_since_spike_pct: number
  price_peak: number
  peak_distance: number
  reasons: string[]
}

function sumVol(c: Candle[], from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) {
    const v = c[i]?.[5]
    if (v != null && v > 0) s += v
  }
  return s
}

function maxHigh(c: Candle[], from: number, to: number): number {
  let h = 0
  for (let i = from; i < to; i++) h = Math.max(h, c[i]?.[2] ?? 0)
  return h
}

/**
 * Detect first explosive 5m volume window; measure decay since then.
 */
export function measureMemeVolumeProfile(
  candles1m: Candle[],
  price: number
): MemeVolumeProfile {
  const closed = candles1m.length >= 2 ? candles1m.slice(0, -1) : candles1m
  const reasons: string[] = []
  if (closed.length < 20 || !(price > 0)) {
    return {
      spike_detected: false,
      spike_age_minutes: 0,
      post_spike_decay: 1,
      decay_rate: 'FAST',
      vol_5m: 0,
      vol_peak_5m: 0,
      vol_ratio: 0,
      chg_since_spike_pct: 0,
      price_peak: price,
      peak_distance: 0,
      reasons: ['vol_profile:short_history'],
    }
  }

  // Sliding 5m windows → peak vol + first onset of elevated vol
  const winVols: number[] = []
  for (let end = 5; end <= closed.length; end++) {
    winVols.push(sumVol(closed, end - 5, end))
  }
  let peakVol = 0
  let peakEnd = 5
  for (let i = 0; i < winVols.length; i++) {
    if (winVols[i]! > peakVol) {
      peakVol = winVols[i]!
      peakEnd = i + 5
    }
  }

  const vol_5m = sumVol(closed, Math.max(0, closed.length - 5), closed.length)
  const vol_peak_5m = peakVol > 0 ? peakVol : vol_5m
  const vol_ratio = vol_peak_5m > 0 ? vol_5m / vol_peak_5m : 0

  // Baseline: median of first third of windows
  const early = winVols.slice(0, Math.max(1, Math.floor(winVols.length / 3)))
  const sorted = [...early].sort((a, b) => a - b)
  const baseline =
    sorted.length > 0
      ? sorted[Math.floor(sorted.length / 2)]!
      : vol_peak_5m * 0.25
  const spikeThresh = Math.max(baseline * 2.2, baseline + 1e-9)
  const spike_detected = peakVol >= spikeThresh

  // Age = minutes since FIRST elevated 5m window (onset), not since peak end.
  // Otherwise live tip volume keeps age≈0 → eternal TOO_EARLY.
  let onsetEnd = peakEnd
  if (spike_detected) {
    for (let i = 0; i < winVols.length; i++) {
      if (winVols[i]! >= spikeThresh) {
        onsetEnd = i + 5
        break
      }
    }
  }
  const spike_age_minutes = spike_detected
    ? Math.max(1, closed.length - onsetEnd + 5)
    : Math.min(90, Math.max(10, closed.length))
  const post_spike_decay = 1 - Math.min(1, vol_ratio)

  let decay_rate: DecayRate = 'NORMAL'
  if (spike_age_minutes >= 8 && post_spike_decay >= 0.7) decay_rate = 'FAST'
  else if (vol_ratio >= 0.55) decay_rate = 'SLOW'
  else if (post_spike_decay >= 0.45) decay_rate = 'FAST'

  const spikeStart = Math.max(0, onsetEnd - 5)
  const openSpike = closed[spikeStart]?.[1] ?? price
  const chg_since_spike_pct =
    openSpike > 0 ? ((price - openSpike) / openSpike) * 100 : 0
  const price_peak = maxHigh(closed, Math.max(0, spikeStart), closed.length)
  const peak_distance =
    price_peak > 0 ? (price_peak - price) / price_peak : 0

  if (spike_detected) reasons.push(`spike_age:${spike_age_minutes}m`)
  else reasons.push('no_clear_spike')
  reasons.push(`vol_ratio:${vol_ratio.toFixed(2)}`)
  reasons.push(`decay:${decay_rate}`)

  return {
    spike_detected,
    spike_age_minutes,
    post_spike_decay: Number(post_spike_decay.toFixed(3)),
    decay_rate,
    vol_5m,
    vol_peak_5m,
    vol_ratio: Number(vol_ratio.toFixed(3)),
    chg_since_spike_pct: Number(chg_since_spike_pct.toFixed(2)),
    price_peak,
    peak_distance: Number(peak_distance.toFixed(4)),
    reasons,
  }
}

/** Rank for scan order — prefer active spikes over zombies. */
export function memeVolRankScore(p: MemeVolumeProfile | null): number {
  if (!p?.spike_detected) return 5
  if (p.decay_rate === 'SLOW' && p.spike_age_minutes < 25) return 80
  if (p.decay_rate === 'FAST' && p.peak_distance < 0.03) return 70
  if (p.vol_ratio > 0.35) return 50
  return 20
}
