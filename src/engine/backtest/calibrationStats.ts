import {
  FAMILY_ALPHA,
  HOLDOUT_WEEKS,
  HORIZONS,
  MIN_SAMPLES,
  MIN_UNIQUE_WEEKS,
  WIDE_INTERVAL,
  WILSON_Z,
} from './config'
import { featureVectorOf, groupKey } from './featureVector'
import type {
  CalibrationGroup,
  GroupAxis,
  GroupStatus,
  HoldoutGroup,
  HorizonStats,
  LabeledEvent,
  SymbolSpan,
} from './types'

export function wilsonInterval(
  wins: number,
  n: number,
  z = WILSON_Z
): { lo: number; hi: number; width: number } {
  if (!(n > 0)) return { lo: 0, hi: 1, width: 1 }
  const p = wins / n
  const z2 = z * z
  const den = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / den
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / den
  const lo = Math.max(0, centre - margin)
  const hi = Math.min(1, centre + margin)
  return { lo, hi, width: hi - lo }
}

/** Acklam's inverse normal. Used for the Bonferroni z, not for a fitted threshold. */
export function normsInv(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  let q: number
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(
        (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
      )
    )
  }
  q = p - 0.5
  const r = q * q
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  )
}

/** Two-sided Bonferroni z for m groups. m = 1 reproduces the ordinary 95% interval. */
export function bonferroniZ(comparisons: number, alpha = FAMILY_ALPHA): number {
  const m = Math.max(1, comparisons)
  return normsInv(1 - alpha / (2 * m))
}

export function familyStats(groups: CalibrationGroup[]): { comparisons: number; adjustedZ: number } {
  const comparisons = groups.filter((g) => g.n >= MIN_SAMPLES).length
  return { comparisons, adjustedZ: bonferroniZ(comparisons) }
}

function mean(xs: number[]): number {
  if (!xs.length) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : ((s[m - 1] ?? 0) + s[m]!) / 2
}

function horizonOf(ev: LabeledEvent, h: number) {
  return ev.horizons.find((x) => x.horizon === h) ?? null
}

/** Win is a target hit. Undecided counts in the denominator as a non-win. */
function summarize(
  events: LabeledEvent[]
): Omit<CalibrationGroup, 'key' | 'event' | 'tf' | 'oi' | 'priorSweep' | 'body' | 'htfZone' | 'location'> {
  const n = events.length
  const long = events.map((e) => horizonOf(e, 50)).filter((x) => x != null)
  const wins = long.filter((x) => x!.result === 'hit').length
  const undecided = long.filter((x) => x!.result === 'undecided').length
  const symbols = new Set(events.map((e) => e.symbol))
  const weeks = new Set(events.map((e) => e.weekKey))
  const bySymbol: Record<string, SymbolSpan> = {}
  let firstMs = Number.POSITIVE_INFINITY
  let lastMs = 0
  for (const e of events) {
    firstMs = Math.min(firstMs, e.discoveredMs)
    lastMs = Math.max(lastMs, e.discoveredMs)
    const row = bySymbol[e.symbol]
    if (!row) {
      bySymbol[e.symbol] = { n: 1, firstMs: e.discoveredMs, lastMs: e.discoveredMs }
    } else {
      row.n += 1
      row.firstMs = Math.min(row.firstMs, e.discoveredMs)
      row.lastMs = Math.max(row.lastMs, e.discoveredMs)
    }
  }
  const enough = n >= MIN_SAMPLES
  const winRate = enough ? wins / n : null
  const undecidedShare = enough ? undecided / n : null
  const invalidatedShare =
    winRate != null && undecidedShare != null ? 1 - winRate - undecidedShare : null
  const mfe = enough ? mean(long.map((x) => x!.mfeAtr)) : null
  const mae = enough ? mean(long.map((x) => x!.maeAtr)) : null
  const avgRR = mfe != null && mae != null && mae > 0 ? mfe / mae : null
  const wilson = enough ? wilsonInterval(wins, n) : null
  const significantVsRandom = Boolean(wilson && wilson.lo > 0.5)
  let status: GroupStatus = 'insufficient'
  if (enough && weeks.size < MIN_UNIQUE_WEEKS) status = 'concentrated'
  else if (enough && wilson && wilson.width > WIDE_INTERVAL) status = 'wide'
  else if (enough) status = 'ok'

  const byHorizon: Record<string, HorizonStats> = {}
  for (const h of HORIZONS) {
    const rows = events.map((e) => horizonOf(e, h)).filter((x) => x != null)
    const hn = rows.length
    byHorizon[String(h)] = {
      n: hn,
      hitBeforeInvalidation: enough ? rows.filter((x) => x!.result === 'hit').length / hn : null,
      undecidedShare: enough ? rows.filter((x) => x!.result === 'undecided').length / hn : null,
      avgMfeAtr: enough ? mean(rows.map((x) => x!.mfeAtr)) : null,
      avgMaeAtr: enough ? mean(rows.map((x) => x!.maeAtr)) : null,
    }
  }

  const bars = long.map((x) => x!.barsToTarget).filter((x): x is number => x != null)

  return {
    n,
    uniqueSymbols: symbols.size,
    uniqueWeeks: weeks.size,
    status,
    winRate,
    undecidedShare,
    invalidatedShare,
    avgRR,
    significantVsRandom,
    adjustedLo: null,
    avgMfeAtr: mfe,
    avgMaeAtr: mae,
    medianBarsToTarget: enough ? median(bars) : null,
    wilsonLo: wilson?.lo ?? null,
    wilsonHi: wilson?.hi ?? null,
    wilsonWidth: wilson?.width ?? null,
    window: {
      firstMs: Number.isFinite(firstMs) ? firstMs : 0,
      lastMs,
      bySymbol,
    },
    byHorizon,
  }
}

export function buildGroups(events: LabeledEvent[], axes: readonly GroupAxis[] = []): CalibrationGroup[] {
  const buckets = new Map<string, LabeledEvent[]>()
  for (const e of events) {
    const feat = e.features ?? featureVectorOf(e)
    const key = groupKey(feat, axes)
    const list = buckets.get(key)
    if (list) list.push(e)
    else buckets.set(key, [e])
  }
  const groups: CalibrationGroup[] = []
  for (const [key, list] of buckets) {
    const head = list[0]!
    const feat = head.features ?? featureVectorOf(head)
    groups.push({
      key,
      event: feat.event,
      tf: feat.tf,
      oi: 'unknown',
      priorSweep: feat.priorSweep,
      body: axes.includes('body') ? feat.body : null,
      htfZone: axes.includes('htfZone') ? feat.htfZone : null,
      location: axes.includes('location') ? feat.location : null,
      ...summarize(list),
    })
  }
  groups.sort((a, b) => b.n - a.n)
  const { adjustedZ } = familyStats(groups)
  for (const g of groups) {
    if (g.n < MIN_SAMPLES || g.winRate == null) {
      g.adjustedLo = null
      g.significantVsRandom = false
      continue
    }
    const wins = nearestCount(g.winRate, g.n)
    const adjusted = wilsonInterval(wins, g.n, adjustedZ)
    g.adjustedLo = adjusted.lo
    g.significantVsRandom = adjusted.lo > 0.5
  }
  return groups
}

export function holdoutReport(
  train: CalibrationGroup[],
  holdoutEvents: LabeledEvent[],
  axes: readonly GroupAxis[] = []
): HoldoutGroup[] {
  const trainByKey = new Map(train.map((g) => [g.key, g]))
  const buckets = new Map<string, LabeledEvent[]>()
  for (const e of holdoutEvents) {
    const feat = e.features ?? featureVectorOf(e)
    const key = groupKey(feat, axes)
    const list = buckets.get(key)
    if (list) list.push(e)
    else buckets.set(key, [e])
  }
  const rows: HoldoutGroup[] = []
  const seen = new Set<string>()
  const push = (key: string, list: LabeledEvent[]) => {
    const long = list.map((e) => horizonOf(e, 50)).filter((x) => x != null)
    const wins = long.filter((x) => x!.result === 'hit').length
    const undecided = long.filter((x) => x!.result === 'undecided').length
    rows.push(finishHoldout(key, list.length, wins, undecided, trainByKey.get(key)))
  }
  for (const g of train) {
    seen.add(g.key)
    push(g.key, buckets.get(g.key) ?? [])
  }
  for (const [key, list] of buckets) {
    if (seen.has(key)) continue
    push(key, list)
  }
  rows.sort((a, b) => b.n - a.n)
  return rows
}

export function holdoutWeeks(): number {
  return HOLDOUT_WEEKS
}

function nearestCount(rate: number | null | undefined, n: number): number {
  if (rate == null || n <= 0) return 0
  const raw = rate * n
  const rounded = Math.round(raw)
  if (Math.abs(raw - rounded) > 1e-6) {
    throw new Error(`rate ${rate} * ${n} is not an integer count`)
  }
  return rounded
}

function finishHoldout(
  key: string,
  n: number,
  wins: number,
  undecided: number,
  train: CalibrationGroup | undefined
): HoldoutGroup {
  const winRate = n > 0 ? wins / n : null
  const undecidedShare = n > 0 ? undecided / n : null
  const invalidatedShare =
    winRate != null && undecidedShare != null ? 1 - winRate - undecidedShare : null
  const wilson = n > 0 ? wilsonInterval(wins, n) : null
  const significantVsRandom = Boolean(wilson && wilson.lo > 0.5)
  const trainWin = train?.winRate ?? null
  const overfit =
    train?.status === 'ok' &&
    trainWin != null &&
    winRate != null &&
    n >= 10 &&
    trainWin - winRate >= 0.08
  const survives = Boolean(
    train?.status === 'ok' &&
      train.significantVsRandom &&
      significantVsRandom &&
      n >= 10 &&
      train.avgRR != null &&
      train.avgRR > 1 &&
      !overfit
  )
  return {
    key,
    n,
    winRate,
    undecidedShare,
    invalidatedShare,
    wilsonLo: wilson?.lo ?? null,
    wilsonHi: wilson?.hi ?? null,
    significantVsRandom,
    trainWinRate: trainWin,
    trainAvgRR: train?.avgRR ?? null,
    trainSignificant: train?.significantVsRandom ?? false,
    overfit,
    survives,
  }
}

/** Fill the phase-1.5 fields from aggregates already stored on a group. */
export function annotateGroup(group: CalibrationGroup): CalibrationGroup {
  const win = group.winRate
  const und = group.undecidedShare
  const invalidatedShare =
    win != null && und != null ? 1 - win - und : group.invalidatedShare ?? null
  const mfe = group.avgMfeAtr
  const mae = group.avgMaeAtr
  const avgRR = mfe != null && mae != null && mae > 0 ? mfe / mae : null
  const significantVsRandom = Boolean(group.wilsonLo != null && group.wilsonLo > 0.5)
  return {
    ...group,
    body: group.body ?? null,
    htfZone: group.htfZone ?? null,
    location: group.location ?? null,
    adjustedLo: group.adjustedLo ?? null,
    invalidatedShare,
    avgRR,
    significantVsRandom,
  }
}

export function annotateHoldout(
  train: CalibrationGroup[],
  holdout: Array<Pick<HoldoutGroup, 'key' | 'n' | 'winRate' | 'undecidedShare'>>
): HoldoutGroup[] {
  const byKey = new Map(holdout.map((h) => [h.key, h]))
  return train.map((g) => {
    const h = byKey.get(g.key)
    const n = h?.n ?? 0
    const wins = nearestCount(h?.winRate, n)
    const undecided = nearestCount(h?.undecidedShare, n)
    return finishHoldout(g.key, n, wins, undecided, g)
  })
}
