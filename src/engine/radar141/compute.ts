import type { OhlcvCandle } from '../../api/mexc'
import { calculateAtr } from '../smc'
import { calculateBtcDivergence } from '../smc'
import { detectMarketRegime } from '../regime/marketRegime'
import { buildGlobalFibonacci } from '../zones/globalFibonacci'
import { readFib141Reaction } from '../smc/structureRead'
import { emptyStats, readCoinStats } from './stats'
import type {
  GapCard,
  LiquidityGrade,
  Radar141Row,
  RsLabel,
  TestKind,
  TriggerState,
  VolRegime,
} from './types'

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function swingCountBetween(
  candles: OhlcvCandle[],
  lo: number,
  hi: number
): number {
  if (candles.length < 8 || !(hi > lo)) return 0
  const slice = candles.slice(-40)
  let n = 0
  for (let i = 2; i < slice.length - 2; i++) {
    const p = slice[i][4]
    if (p < lo || p > hi) continue
    const h = slice[i][2]
    const l = slice[i][3]
    const isHigh = h >= slice[i - 1][2] && h >= slice[i + 1][2]
    const isLow = l <= slice[i - 1][3] && l <= slice[i + 1][3]
    if (isHigh || isLow) n += 1
  }
  return n
}

function liquidityGrade(vol24h: number, oi: number | undefined): LiquidityGrade {
  if (vol24h >= 40_000_000 && (oi == null || oi >= 4000)) return 'A'
  if (vol24h >= 12_000_000) return 'B'
  if (vol24h >= 4_000_000) return 'C'
  return 'D'
}

function triggerOf(
  reaction: ReturnType<typeof readFib141Reaction>,
  in141: boolean,
  distAbs: number | null,
  inGap: boolean
): { trigger: TriggerState; label: string } {
  if (in141 || reaction?.state === 'INSIDE') {
    return { trigger: 'INSIDE_141', label: 'внутри 141' }
  }
  if (reaction?.state === 'BREAK' || reaction?.state === 'BOUNCE') {
    return { trigger: 'EXIT_141', label: 'вышла из 141' }
  }
  if (inGap) {
    return { trigger: 'IN_GAP', label: 'влетела в gap' }
  }
  if (
    reaction?.state === 'APPROACHING' ||
    (distAbs != null && distAbs <= 0.8)
  ) {
    return { trigger: 'APPROACH_141', label: 'подходит к 141' }
  }
  return { trigger: 'APPROACH_141', label: 'подходит к 141' }
}

function testKind(
  candles: OhlcvCandle[],
  top: number,
  bottom: number
): { kind: TestKind; minutes: number | null } {
  if (!(top > bottom) || candles.length < 4) {
    return { kind: 'NONE', minutes: null }
  }
  const tfMs = Math.max(
    60_000,
    candles.length > 1 ? candles[candles.length - 1][0] - candles[candles.length - 2][0] : 3_600_000
  )
  let touches = 0
  let firstIdx = -1
  let lastInside = -1
  candles.forEach((c, i) => {
    const hit = c[2] >= bottom && c[3] <= top
    if (hit) {
      touches += 1
      if (firstIdx < 0) firstIdx = i
      lastInside = i
    }
  })
  if (touches === 0) return { kind: 'NONE', minutes: null }
  const minutes =
    lastInside >= 0
      ? Math.round(((candles.length - 1 - (firstIdx < 0 ? lastInside : firstIdx)) * tfMs) / 60_000)
      : null
  if (touches >= 6) return { kind: 'EXHAUSTED', minutes }
  if (touches >= 2) return { kind: 'RETEST', minutes }
  return { kind: 'FIRST', minutes }
}

export function changePct(candles: OhlcvCandle[], bars: number): number {
  if (candles.length < bars + 1) return 0
  const a = candles[candles.length - 1 - bars][4]
  const b = candles[candles.length - 1][4]
  if (!(a > 0)) return 0
  return ((b - a) / a) * 100
}

export function buildRadar141Row(input: {
  internalSymbol: string
  displayName: string
  price: number
  change24h: number
  volume24h: number
  openInterest?: number
  candles1h: OhlcvCandle[]
  candles4h: OhlcvCandle[]
  candles1d: OhlcvCandle[]
  btc1h: OhlcvCandle[]
  marketChange1d: number
  newsRisk: boolean
  newsNote: string | null
  prevTrigger?: TriggerState | null
}): Radar141Row {
  const {
    internalSymbol,
    displayName,
    price,
    change24h,
    volume24h,
    openInterest,
    candles1h,
    candles4h,
    candles1d,
    btc1h,
    marketChange1d,
    newsRisk,
    newsNote,
    prevTrigger,
  } = input

  const atr = calculateAtr(candles1h, 14) ?? price * 0.008
  const atrPct = price > 0 ? (atr / price) * 100 : 0
  const regime = detectMarketRegime(candles1h, candles4h)

  const fib4h = buildGlobalFibonacci(candles4h, price)
  const fib1d = buildGlobalFibonacci(candles1d, price)
  const fib = fib4h ?? fib1d
  const reaction = readFib141Reaction(candles1h, fib)

  const p141 = fib?.price141 ?? null
  const p161 = fib?.price161 ?? null
  const zone = fib?.zone141
  const zTop = zone ? Math.max(zone.top, zone.bottom) : p141
  const zBot = zone ? Math.min(zone.top, zone.bottom) : p141

  const dist141Pct =
    p141 != null && p141 > 0 ? ((price - p141) / p141) * 100 : null
  const dist141Atr =
    dist141Pct != null && atrPct > 0 ? dist141Pct / atrPct : null

  const impulse = fib?.impulse ?? 'UP'
  const nextMagnet = p161
  let gapLo = 0
  let gapHi = 0
  let gapSide: 'UP' | 'DOWN' = 'UP'
  if (p141 != null && nextMagnet != null) {
    if (impulse === 'UP') {
      gapLo = Math.min(p141, nextMagnet)
      gapHi = Math.max(p141, nextMagnet)
      gapSide = 'UP'
    } else {
      gapLo = Math.min(p141, nextMagnet)
      gapHi = Math.max(p141, nextMagnet)
      gapSide = 'DOWN'
    }
  } else if (p141 != null) {
    const span = Math.max(atr * 8, price * 0.03)
    if (price <= p141) {
      gapLo = price
      gapHi = p141
      gapSide = 'UP'
    } else {
      gapLo = p141
      gapHi = price
      gapSide = 'DOWN'
    }
    if (gapHi - gapLo < span * 0.2) {
      gapLo = p141
      gapHi = p141 + (impulse === 'UP' ? span : -span)
      if (gapHi < gapLo) [gapLo, gapHi] = [gapHi, gapLo]
    }
  }

  const gapPct = gapHi > gapLo && price > 0 ? ((gapHi - gapLo) / price) * 100 : 0
  const gapAtr = atrPct > 0 ? gapPct / atrPct : 0
  const clutter = swingCountBetween(candles1h, gapLo, gapHi)
  const freePathScore = clamp(100 - clutter * 12, 8, 100)

  const in141 =
    Boolean(fib?.in141) ||
    (zTop != null && zBot != null && price <= zTop && price >= zBot)
  const inGap =
    !in141 &&
    gapHi > gapLo &&
    price > gapLo &&
    price < gapHi &&
    (dist141Pct == null || Math.abs(dist141Pct) > 0.15)

  const { trigger, label: triggerLabel } = triggerOf(
    reaction,
    in141,
    dist141Pct != null ? Math.abs(dist141Pct) : null,
    inGap
  )

  const rs1d = calculateBtcDivergence(btc1h, candles1h, 24)
  const rs4h = calculateBtcDivergence(btc1h, candles1h, 4)
  const alt1d = changePct(candles1h, Math.min(24, candles1h.length - 1))
  const rsMarket = alt1d - marketChange1d

  let rsLabel: RsLabel = 'NEUTRAL'
  if (rs1d.relativeStrength >= 2.2 || rsMarket >= 1.8) rsLabel = 'STRONG'
  if (rs1d.relativeStrength <= -2.2 || rsMarket <= -1.8) rsLabel = 'WEAK'

  const d1chg = changePct(candles1d, Math.min(5, candles1d.length - 1))
  const h4chg = changePct(candles4h, Math.min(6, candles4h.length - 1))
  const h1chg = changePct(candles1h, Math.min(8, candles1h.length - 1))
  const dir = (n: number) => (n > 0.15 ? 1 : n < -0.15 ? -1 : 0)
  const trendAlign = dir(d1chg) !== 0 && dir(d1chg) === dir(h4chg) && dir(h4chg) === dir(h1chg)
  const htfBias: 'LONG' | 'SHORT' | 'FLAT' =
    dir(d1chg) > 0 && dir(h4chg) >= 0
      ? 'LONG'
      : dir(d1chg) < 0 && dir(h4chg) <= 0
        ? 'SHORT'
        : 'FLAT'

  const grade = liquidityGrade(volume24h, openInterest)
  const liquidityOk = grade === 'A' || grade === 'B'
  const volRegime: VolRegime =
    regime === 'VOLATILE_CHOP'
      ? 'CHOP'
      : atrPct < 0.28 || gapAtr < 1.2
        ? 'THIN'
        : 'OK'

  const preferredSide: 'LONG' | 'SHORT' | null =
    gapSide === 'UP' && rsLabel !== 'WEAK'
      ? 'LONG'
      : gapSide === 'DOWN' && rsLabel !== 'STRONG'
        ? 'SHORT'
        : rsLabel === 'STRONG'
          ? 'LONG'
          : rsLabel === 'WEAK'
            ? 'SHORT'
            : fib?.entryBias ?? null

  const liqPts = grade === 'A' ? 100 : grade === 'B' ? 72 : grade === 'C' ? 42 : 18
  const rsPts =
    preferredSide === 'LONG'
      ? clamp(50 + rs1d.relativeStrength * 6 + (rsLabel === 'STRONG' ? 12 : 0), 0, 100)
      : clamp(50 - rs1d.relativeStrength * 6 + (rsLabel === 'WEAK' ? 12 : 0), 0, 100)
  const gapPts = clamp(gapPct * 12 + freePathScore * 0.35 + Math.min(gapAtr, 6) * 4, 0, 100)
  const volPts = clamp(
    (volRegime === 'OK' ? 70 : volRegime === 'THIN' ? 28 : 18) + (trendAlign ? 22 : 0),
    0,
    100
  )
  const opportunityScore = Math.round(
    gapPts * 0.3 + liqPts * 0.25 + rsPts * 0.25 + volPts * 0.2
  )
  const expectedTravel = gapPct * (liquidityOk ? 1 : 0.55) * (freePathScore / 100)

  const flyProb = clamp(
    28 +
      gapAtr * 6 +
      (liquidityOk ? 12 : -8) +
      (volRegime === 'OK' ? 10 : -10) +
      (trendAlign ? 8 : 0) +
      (rsLabel === 'STRONG' && preferredSide === 'LONG' ? 10 : 0) +
      (rsLabel === 'WEAK' && preferredSide === 'SHORT' ? 10 : 0) -
      clutter * 4,
    12,
    86
  )

  const tf = fib4h ? '4ч' : '1д'
  const gap: GapCard | null =
    gapPct > 0.4
      ? {
          side: gapSide,
          upper: {
            price: gapHi,
            label: gapSide === 'UP' ? '161 / цель' : '141',
            tf,
          },
          lower: {
            price: gapLo,
            label: gapSide === 'UP' ? '141' : '161 / цель',
            tf,
          },
          gapPct,
          gapAtr,
          clutter,
          freePathScore,
          flyProb,
          plan: {
            retest:
              preferredSide === 'SHORT'
                ? `Ждать ретест верхней границы ${gapHi.toFixed(price >= 100 ? 2 : 5)} и закреп под ней`
                : `Ждать ретест нижней границы ${gapLo.toFixed(price >= 100 ? 2 : 5)} и закреп над ней`,
            breakout:
              preferredSide === 'SHORT'
                ? 'Шорт после слома и закрепа ниже 141, не ловить середину пропасти'
                : 'Лонг после выхода и закрепа выше 141, не ловить середину пропасти',
            invalidation:
              preferredSide === 'SHORT'
                ? `Час закроется выше 141 (${(p141 ?? gapHi).toFixed(price >= 100 ? 2 : 5)})`
                : `Час закроется ниже 141 (${(p141 ?? gapLo).toFixed(price >= 100 ? 2 : 5)})`,
          },
        }
      : null

  const zoneTop = zTop ?? p141 ?? price
  const zoneBot = zBot ?? p141 ?? price
  const tests = testKind(candles1h, zoneTop, zoneBot)

  const stats = readCoinStats(internalSymbol)
  if (prevTrigger === 'INSIDE_141' && trigger === 'APPROACH_141') {
    /* false exit tracked in hook */
  }

  const scoreWhy = `Score ${opportunityScore}: gap ${gapPct.toFixed(1)}%, RS ${rsLabel.toLowerCase()}, liquidity ${grade}`

  return {
    symbol: displayName,
    internalSymbol,
    displayName,
    price,
    change24h,
    dist141Pct,
    dist141Atr,
    gapPct,
    gapAtr,
    freePathScore,
    liquidityGrade: grade,
    liquidityOk,
    volume24h,
    atrPct,
    volRegime,
    trigger,
    triggerLabel,
    rsBtc1d: rs1d.relativeStrength,
    rsBtc4h: rs4h.relativeStrength,
    rsMarket,
    rsLabel,
    trendAlign,
    htfBias,
    opportunityScore,
    scoreWhy,
    preferredSide,
    expectedTravel,
    gap,
    minutesInZone: tests.minutes,
    testKind: tests.kind,
    newsRisk,
    newsNote,
    stats: stats.flights ? stats : emptyStats(),
    updatedAt: Date.now(),
  }
}

export function rowPassesFilters(
  row: Radar141Row,
  f: {
    topLiquidityOnly: boolean
    minGapPct: number
    minGapAtr: number
    maxDist141Pct: number
    minAtrPct: number
    excludeNewsRisk: boolean
  }
): boolean {
  if (f.topLiquidityOnly && !row.liquidityOk) return false
  if (row.gapPct + 1e-9 < f.minGapPct) return false
  if (row.gapAtr + 1e-9 < f.minGapAtr) return false
  if (
    row.dist141Pct != null &&
    Math.abs(row.dist141Pct) > f.maxDist141Pct
  ) {
    return false
  }
  if (row.atrPct + 1e-9 < f.minAtrPct) return false
  if (f.excludeNewsRisk && row.newsRisk) return false
  return true
}

export function sortByExpectedTravel(rows: Radar141Row[]): Radar141Row[] {
  return [...rows].sort((a, b) => {
    if (b.expectedTravel !== a.expectedTravel) {
      return b.expectedTravel - a.expectedTravel
    }
    return b.opportunityScore - a.opportunityScore
  })
}

export function isWatchNear141(row: Radar141Row): boolean {
  if (row.trigger === 'INSIDE_141' || row.trigger === 'APPROACH_141') return true
  return row.dist141Pct != null && Math.abs(row.dist141Pct) <= 0.8
}
