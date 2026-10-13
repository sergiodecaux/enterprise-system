/**
 * Structure read for the three macro gauges: BTC.D, TOTAL3, OTHERS.
 *
 * These are not MEXC instruments — the daily series are reconstructed market
 * caps (source labelled upstream). We read each one the same way as any chart:
 * trend, position in its recent range (near support / resistance / middle),
 * and the change across the window. From the three we derive a balanced,
 * descriptive alt read (tailwind / headwind for alts) — directional context
 * for entries and bounces, never a probability number on screen.
 */

export type MacroTrend = 'UP' | 'DOWN' | 'RANGE' | 'NA'
export type MacroLocation = 'HIGH' | 'LOW' | 'MID' | 'NA'
export type AltMacroBias = 'TAILWIND' | 'HEADWIND' | 'MIXED' | 'NA'

/** Minimum daily points before a structure read is honest. */
export const MACRO_MIN_SAMPLES = 10
/** Window used for trend / range location. */
export const MACRO_WINDOW = 30
/** Relative change (percent of mean) above which the window is trending. */
export const MACRO_TREND_PCT = 1.2

export interface IndexStructure {
  name: string
  trend: MacroTrend
  location: MacroLocation
  last: number | null
  /** Relative change across the window, percent. */
  changePct: number | null
  /** Position of the last value inside the window range, 0…100. */
  pctInRange: number | null
  samples: number
  line: string
}

export interface MacroStructure {
  btcD: IndexStructure
  total3: IndexStructure
  others: IndexStructure
  /** Balanced alt read derived from the three. */
  bias: AltMacroBias
  /** 0…1 how strong the read is. */
  strength: number
  /** −1…+1 tilt for alt scenario weighting (+ favours alt longs). */
  altTilt: number
  line: string
}

export interface MacroStructureInput {
  btcD?: number[] | null
  total3?: number[] | null
  others?: number[] | null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Least-squares slope expressed as percent of the window mean. */
function slopePct(window: number[]): number {
  const n = window.length
  if (n < 2) return 0
  const mean = window.reduce((a, b) => a + b, 0) / n
  if (!(Math.abs(mean) > 0)) return 0
  const xMean = (n - 1) / 2
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (window[i]! - mean)
    den += (i - xMean) * (i - xMean)
  }
  if (!(den > 0)) return 0
  const slope = num / den
  // Total change across the window as percent of mean.
  return ((slope * (n - 1)) / mean) * 100
}

function arrowOf(trend: MacroTrend): string {
  if (trend === 'UP') return '↑'
  if (trend === 'DOWN') return '↓'
  if (trend === 'RANGE') return '→'
  return '·'
}

function locWord(loc: MacroLocation): string {
  if (loc === 'HIGH') return 'у сопротивления'
  if (loc === 'LOW') return 'у поддержки'
  if (loc === 'MID') return 'в середине'
  return 'н/д'
}

export function readIndexStructure(
  name: string,
  series: number[] | null | undefined
): IndexStructure {
  const clean = (series ?? []).filter((v) => Number.isFinite(v) && v > 0)
  const samples = clean.length
  if (samples < MACRO_MIN_SAMPLES) {
    return {
      name,
      trend: 'NA',
      location: 'NA',
      last: clean.length ? clean[clean.length - 1]! : null,
      changePct: null,
      pctInRange: null,
      samples,
      line: `${name}: мало данных (${samples})`,
    }
  }

  const window = clean.slice(-MACRO_WINDOW)
  const last = window[window.length - 1]!
  const first = window[0]!
  const hi = Math.max(...window)
  const lo = Math.min(...window)
  const span = hi - lo
  const pctInRange = span > 0 ? ((last - lo) / span) * 100 : 50
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0
  const sl = slopePct(window)

  let trend: MacroTrend = 'RANGE'
  if (sl >= MACRO_TREND_PCT && changePct > 0) trend = 'UP'
  else if (sl <= -MACRO_TREND_PCT && changePct < 0) trend = 'DOWN'

  let location: MacroLocation = 'MID'
  if (pctInRange >= 75) location = 'HIGH'
  else if (pctInRange <= 25) location = 'LOW'

  const line = `${name} ${arrowOf(trend)} ${locWord(location)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)`

  return { name, trend, location, last, changePct, pctInRange, samples, line }
}

function trendSignal(s: IndexStructure): number {
  if (s.trend === 'UP') return 1
  if (s.trend === 'DOWN') return -1
  return 0
}

/** Small mean-reversion nudge from where the value sits in its range. */
function locNudge(s: IndexStructure): number {
  if (s.location === 'HIGH') return -0.3
  if (s.location === 'LOW') return 0.3
  return 0
}

/**
 * Balanced alt read. Positive altTilt favours alt longs / bounces.
 * BTC.D is inverted (dominance up drains alts). TOTAL3 and OTHERS add
 * straight — OTHERS (the long tail) carries the risk-appetite signal.
 */
export function deriveMacroStructure(input: MacroStructureInput): MacroStructure {
  const btcD = readIndexStructure('BTC.D', input.btcD)
  const total3 = readIndexStructure('TOTAL3', input.total3)
  const others = readIndexStructure('OTHERS', input.others)

  const have = [btcD, total3, others].filter((s) => s.trend !== 'NA')
  if (have.length === 0) {
    return {
      btcD,
      total3,
      others,
      bias: 'NA',
      strength: 0,
      altTilt: 0,
      line: 'Макро: мало данных по BTC.D / TOTAL3 / OTHERS',
    }
  }

  // BTC.D: dominance up is a headwind for alts, and vice versa.
  const btcDContrib = btcD.trend === 'NA' ? 0 : -(trendSignal(btcD) + locNudge(btcD))
  // TOTAL3: broad alt liquidity.
  const total3Contrib = total3.trend === 'NA' ? 0 : trendSignal(total3) + locNudge(total3)
  // OTHERS: small/mid-cap risk appetite — the clearest risk-on tell.
  const othersContrib = others.trend === 'NA' ? 0 : trendSignal(others) + locNudge(others)

  const altTilt = clamp(
    0.4 * btcDContrib + 0.3 * total3Contrib + 0.35 * othersContrib,
    -1,
    1
  )
  const strength = Math.abs(altTilt)

  let bias: AltMacroBias = 'MIXED'
  if (altTilt >= 0.25) bias = 'TAILWIND'
  else if (altTilt <= -0.25) bias = 'HEADWIND'

  const tail =
    bias === 'TAILWIND'
      ? '→ попутка альтам'
      : bias === 'HEADWIND'
        ? '→ встречка альтам'
        : '→ смешанно'
  const line = `${btcD.name} ${arrowOf(btcD.trend)} · ${total3.name} ${arrowOf(total3.trend)} · ${others.name} ${arrowOf(others.trend)} ${tail}`

  return { btcD, total3, others, bias, strength, altTilt, line }
}
