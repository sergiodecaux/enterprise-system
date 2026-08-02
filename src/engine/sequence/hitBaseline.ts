/**
 * Rolling baseline for hit/aggression USD → Z-score anomaly gate.
 * Warm-up uses samples from the open session; optional seed from 1m volumes.
 */

const MAX_SAMPLES = 480 // ~24h if sampled every 3m; denser in live session
const MIN_SAMPLES_HARD = 24
const MIN_SAMPLES_SOFT = 12
const ANOMALY_Z = 2.5

interface Sample {
  at: number
  usd: number
}

const buses = new Map<string, Sample[]>()

export function recordHitSample(
  symbol: string,
  usd: number,
  now = Date.now()
): void {
  if (!symbol || !(usd > 0) || !Number.isFinite(usd)) return
  const prev = buses.get(symbol) ?? []
  const next = prev.concat([{ at: now, usd }])
  buses.set(
    symbol,
    next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
  )
}

/** Seed from 1m candle quote volumes (vol * close) — bootstrap before live hits. */
export function seedHitBaselineFromCandles(
  symbol: string,
  candles: Array<[number, number, number, number, number, number]>,
  now = Date.now()
): void {
  if (!symbol || candles.length < 10) return
  if ((buses.get(symbol)?.length ?? 0) >= MIN_SAMPLES_HARD) return
  const recent = candles.slice(-120)
  for (const c of recent) {
    const usd = Math.abs(c[4] * c[5])
    if (usd > 0) recordHitSample(symbol, usd, Math.min(c[0], now))
  }
}

export interface HitZScore {
  z: number
  mean: number
  std: number
  samples: number
  /** True when statistically unusual (or soft-pass during warm-up) */
  isAnomaly: boolean
  /** Confidence multiplier 0.55..1.12 */
  confidenceMul: number
  ready: boolean
}

export function getHitZScore(
  symbol: string,
  currentUsd: number,
  now = Date.now()
): HitZScore {
  const all = buses.get(symbol) ?? []
  const cut = now - 24 * 60 * 60_000
  const samples = all.filter((s) => s.at >= cut)
  const n = samples.length

  if (n < 3 || !(currentUsd > 0)) {
    return {
      z: 0,
      mean: currentUsd,
      std: 0,
      samples: n,
      isAnomaly: true, // don't hard-block cold start
      confidenceMul: 0.85,
      ready: false,
    }
  }

  const mean = samples.reduce((s, x) => s + x.usd, 0) / n
  let variance = 0
  for (const s of samples) {
    const d = s.usd - mean
    variance += d * d
  }
  const std = Math.sqrt(variance / Math.max(1, n - 1))
  const z = std > 1e-6 ? (currentUsd - mean) / std : 0

  const ready = n >= MIN_SAMPLES_SOFT
  const hardReady = n >= MIN_SAMPLES_HARD
  const isAnomaly = !hardReady
    ? z >= 1.2 || currentUsd >= mean * 1.8
    : z >= ANOMALY_Z

  let confidenceMul = 1
  if (hardReady) {
    if (z >= 3.5) confidenceMul = 1.12
    else if (z >= ANOMALY_Z) confidenceMul = 1.05
    else if (z >= 1.5) confidenceMul = 0.82
    else confidenceMul = 0.55
  } else if (ready) {
    confidenceMul = z >= 1.5 ? 1 : 0.75
  }

  return { z, mean, std, samples: n, isAnomaly, confidenceMul, ready }
}

/** Hard gate for HIT-driven sequences when baseline is ready. */
export function passesAnomalyGate(
  zInfo: HitZScore | null | undefined,
  opts?: { soft?: boolean }
): boolean {
  if (!zInfo || !zInfo.ready) return true
  if (opts?.soft) return zInfo.z >= 1.2 || zInfo.isAnomaly
  return zInfo.isAnomaly
}
