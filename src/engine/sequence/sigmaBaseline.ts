/**
 * Rolling Z-score baselines for process anomalies (HIT / DELTA / WALL).
 * Signal confidence is demoted when the move is just "normal" noise.
 */

export type SigmaMetric = 'HIT' | 'DELTA' | 'WALL'

const MAX_SAMPLES = 480
const MIN_SAMPLES_HARD = 24
const MIN_SAMPLES_SOFT = 12
const ANOMALY_Z = 2.5

interface Sample {
  at: number
  usd: number
}

const buses = new Map<string, Sample[]>()

function key(symbol: string, metric: SigmaMetric): string {
  return `${symbol}::${metric}`
}

export function recordSigmaSample(
  symbol: string,
  metric: SigmaMetric,
  usd: number,
  now = Date.now()
): void {
  if (!symbol || !(usd > 0) || !Number.isFinite(usd)) return
  const k = key(symbol, metric)
  const prev = buses.get(k) ?? []
  const next = prev.concat([{ at: now, usd }])
  buses.set(
    k,
    next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
  )
}

/** @deprecated use recordSigmaSample(symbol, 'HIT', …) */
export function recordHitSample(
  symbol: string,
  usd: number,
  now = Date.now()
): void {
  recordSigmaSample(symbol, 'HIT', usd, now)
}

/** Seed HIT baseline from 1m candle quote volumes. */
export function seedHitBaselineFromCandles(
  symbol: string,
  candles: Array<[number, number, number, number, number, number]>,
  now = Date.now()
): void {
  if (!symbol || candles.length < 10) return
  if ((buses.get(key(symbol, 'HIT'))?.length ?? 0) >= MIN_SAMPLES_HARD) return
  const recent = candles.slice(-120)
  for (const c of recent) {
    const usd = Math.abs(c[4] * c[5])
    if (usd > 0) recordSigmaSample(symbol, 'HIT', usd, Math.min(c[0], now))
  }
}

export interface SigmaZScore {
  z: number
  mean: number
  std: number
  samples: number
  isAnomaly: boolean
  /** 0.55..1.12 */
  confidenceMul: number
  ready: boolean
  metric: SigmaMetric
}

export type HitZScore = Omit<SigmaZScore, 'metric'>

function computeZ(
  symbol: string,
  metric: SigmaMetric,
  currentUsd: number,
  now: number
): SigmaZScore {
  const all = buses.get(key(symbol, metric)) ?? []
  const cut = now - 24 * 60 * 60_000
  const samples = all.filter((s) => s.at >= cut)
  const n = samples.length

  if (n < 3 || !(currentUsd > 0)) {
    return {
      z: 0,
      mean: currentUsd,
      std: 0,
      samples: n,
      isAnomaly: true,
      confidenceMul: 0.85,
      ready: false,
      metric,
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

  return { z, mean, std, samples: n, isAnomaly, confidenceMul, ready, metric }
}

export function getSigmaZScore(
  symbol: string,
  metric: SigmaMetric,
  currentUsd: number,
  now = Date.now()
): SigmaZScore {
  return computeZ(symbol, metric, currentUsd, now)
}

export function getHitZScore(
  symbol: string,
  currentUsd: number,
  now = Date.now()
): HitZScore {
  const { metric: _m, ...rest } = computeZ(symbol, 'HIT', currentUsd, now)
  return rest
}

/** Blend HIT + DELTA + WALL multipliers (geometric mean of ready ones). */
export function blendSigmaMuls(
  parts: Array<SigmaZScore | HitZScore | null | undefined>
): { mul: number; anyReady: boolean; anyAnomaly: boolean } {
  const ready = parts.filter((p): p is SigmaZScore | HitZScore =>
    Boolean(p && p.ready)
  )
  if (!ready.length) return { mul: 1, anyReady: false, anyAnomaly: true }
  let prod = 1
  for (const p of ready) prod *= p.confidenceMul
  const mul = Math.pow(prod, 1 / ready.length)
  return {
    mul: Math.max(0.5, Math.min(1.15, mul)),
    anyReady: true,
    anyAnomaly: ready.some((p) => p.isAnomaly),
  }
}

export function passesAnomalyGate(
  zInfo: HitZScore | SigmaZScore | null | undefined,
  opts?: { soft?: boolean }
): boolean {
  if (!zInfo || !zInfo.ready) return true
  if (opts?.soft) return zInfo.z >= 1.2 || zInfo.isAnomaly
  return zInfo.isAnomaly
}
