/**
 * Find nearest LONG/SHORT liquidity zones (SSL/BSL + Fib reaction)
 * and turn them into watchable ConditionalSetups for jewel entries.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { Time } from 'lightweight-charts'
import type { LiquidityZone } from '../indicators/types'
import type {
  CoinSignal,
  LiquidityMap,
  MmIntentSnapshot,
} from '../types'
import { buildLiquidityMap } from '../smc'
import { buildGlobalFibonacci } from './globalFibonacci'
import type { ConditionalSetup, SetupPrecondition } from '../setups/types'
import { buildConditionalSetups } from '../setups/buildConditionalSetups'
import type { PriceForecast } from '../prediction/types'

export interface FoundTradeZone {
  id: string
  source: 'SSL' | 'BSL' | 'FIB' | 'OTE'
  side: 'LONG' | 'SHORT'
  top: number
  bottom: number
  mid: number
  label: string
  strength: number
  distancePct: number
  target: number
  invalidation: number
  limitEntry: number
  chartZone: LiquidityZone
}

export interface FindTradeZonesResult {
  zones: FoundTradeZone[]
  chartZones: LiquidityZone[]
  setups: ConditionalSetup[]
  liquidityMap: LiquidityMap
  nearestLong: FoundTradeZone | null
  nearestShort: FoundTradeZone | null
  jewelReady: ConditionalSetup[]
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function band(price: number, pct = 0.0035): { top: number; bottom: number } {
  return {
    top: price * (1 + pct),
    bottom: price * (1 - pct),
  }
}

function toChartZone(
  id: string,
  type: LiquidityZone['type'],
  side: 'BULLISH' | 'BEARISH',
  top: number,
  bottom: number,
  startTime: Time,
  endTime: Time,
  label: string,
  strength: number
): LiquidityZone {
  return {
    id,
    type,
    side,
    top,
    bottom,
    startTime,
    endTime,
    label,
    strength,
  }
}

function statusFromPre(pre: SetupPrecondition[]): ConditionalSetup['status'] {
  if (pre.some((p) => p.status === 'FAILED')) return 'INVALIDATED'
  if (pre.length && pre.every((p) => p.status === 'MET')) return 'READY'
  if (pre.some((p) => p.status === 'MET')) return 'ARMED'
  return 'HYPOTHESIS'
}

function zoneToSetup(
  z: FoundTradeZone,
  price: number,
  signal: CoinSignal | null,
  bookImbalance: number | null
): ConditionalSetup {
  const inZone =
    price >= z.bottom * 0.998 && price <= z.top * 1.002
  const bookOk =
    bookImbalance == null
      ? 'PENDING'
      : (z.side === 'LONG' && bookImbalance >= 12) ||
          (z.side === 'SHORT' && bookImbalance <= -12)
        ? 'MET'
        : (z.side === 'LONG' && bookImbalance <= -20) ||
            (z.side === 'SHORT' && bookImbalance >= 20)
          ? 'FAILED'
          : 'PENDING'

  const pre: SetupPrecondition[] = [
    {
      id: 'touch',
      label: `Цена в зоне ${z.bottom.toPrecision(5)}–${z.top.toPrecision(5)}`,
      status: inZone ? 'MET' : 'PENDING',
    },
    {
      id: 'book',
      label:
        z.side === 'LONG'
          ? 'Стакан за LONG (OBI ≥ +12%)'
          : 'Стакан за SHORT (OBI ≤ −12%)',
      status: bookOk,
    },
    {
      id: 'confirm',
      label: 'Реакция / reclaim / absorption',
      status:
        signal?.absorption?.detected ||
        signal?.ltfChoCH?.detected ||
        (signal?.surgicalEntry && signal.surgicalEntry.status === 'READY')
          ? 'MET'
          : 'PENDING',
    },
  ]

  const kind =
    z.source === 'SSL'
      ? 'BOUNCE_SSL'
      : z.source === 'BSL'
        ? 'BOUNCE_BSL'
        : 'SURGICAL'

  return {
    id: z.id,
    kind,
    side: z.side,
    title: `💎 ${z.label}`,
    probability: Math.min(
      78,
      42 + z.strength * 4 + (inZone ? 8 : 0) + (bookOk === 'MET' ? 10 : 0)
    ),
    preconditions: pre,
    entryZone: { top: z.top, bottom: z.bottom },
    limitEntry: z.limitEntry,
    target: z.target,
    invalidation: z.invalidation,
    triggerSummary: `${z.side} от зоны ${z.source}: лимит ${z.limitEntry.toPrecision(6)}, TP ${z.target.toPrecision(6)}, SL ${z.invalidation.toPrecision(6)}`,
    reasoning: [
      `Источник: ${z.source}`,
      `Дистанция ${z.distancePct.toFixed(2)}%`,
      'Слежение: зона + стакан + реакция → ювелирный вход в бот',
    ],
    status: statusFromPre(pre),
    symbol: signal?.symbol,
    internalSymbol: signal?.internalSymbol,
    createdAt: Date.now(),
  }
}

/**
 * Rank nearest actionable liquidity zones above/below price.
 */
export function findTradeZones(input: {
  candles: OhlcvCandle[]
  candles1d?: OhlcvCandle[]
  symbol: string
  flatSymbol: string
  price: number
  signal?: CoinSignal | null
  mmIntent?: MmIntentSnapshot | null
  forecast?: PriceForecast | null
  liquidityMap?: LiquidityMap | null
  bookImbalance?: number | null
}): FindTradeZonesResult {
  const price = input.price
  const emptyMap: LiquidityMap = {
    symbol: input.symbol,
    timeframe: '1h',
    equalHighs: [],
    equalLows: [],
    nearestBSL: null,
    nearestSSL: null,
    liquidityBoost: 0,
    computedAt: Date.now(),
  }

  if (!(price > 0) || input.candles.length < 20) {
    return {
      zones: [],
      chartZones: [],
      setups: [],
      liquidityMap: emptyMap,
      nearestLong: null,
      nearestShort: null,
      jewelReady: [],
    }
  }

  const map =
    input.liquidityMap ??
    buildLiquidityMap(input.candles, price, input.symbol, 'chart')

  const fibSrc =
    input.candles.length >= 40
      ? input.candles
      : input.candles1d && input.candles1d.length >= 40
        ? input.candles1d
        : input.candles
  const fib = buildGlobalFibonacci(fibSrc, price)

  const lastTs = (input.candles[input.candles.length - 1]?.[0] ?? Date.now()) / 1000
  const startTime = (lastTs - 3600 * 48) as Time
  const endTime = (lastTs + 3600 * 12) as Time

  const found: FoundTradeZone[] = []

  // SSL → LONG zones (below price preferred; include nearest even if slightly above)
  const ssls = [...map.equalLows]
    .filter((l) => l.isActive && l.strength !== 'WEAK')
    .sort(
      (a, b) =>
        Math.abs(a.price - price) - Math.abs(b.price - price)
    )
    .slice(0, 3)

  for (const ssl of ssls) {
    const { top, bottom } = band(ssl.price, 0.004)
    const id = uid('zone_ssl')
    const strength =
      ssl.strength === 'STRONG' ? 9 : ssl.strength === 'MEDIUM' ? 7 : 5
    const target = map.nearestBSL?.price ?? price * 1.012
    const inv = ssl.price * 0.992
    const cz = toChartZone(
      id,
      'SSL',
      'BULLISH',
      top,
      bottom,
      startTime,
      endTime,
      `LONG · SSL ×${ssl.touches}`,
      strength
    )
    found.push({
      id,
      source: 'SSL',
      side: 'LONG',
      top,
      bottom,
      mid: ssl.price,
      label: `SSL ×${ssl.touches} (${ssl.strength})`,
      strength,
      distancePct: ((ssl.price - price) / price) * 100,
      target,
      invalidation: inv,
      limitEntry: ssl.price * 1.0015,
      chartZone: cz,
    })
  }

  // BSL → SHORT zones
  const bsls = [...map.equalHighs]
    .filter((l) => l.isActive && l.strength !== 'WEAK')
    .sort(
      (a, b) =>
        Math.abs(a.price - price) - Math.abs(b.price - price)
    )
    .slice(0, 3)

  for (const bsl of bsls) {
    const { top, bottom } = band(bsl.price, 0.004)
    const id = uid('zone_bsl')
    const strength =
      bsl.strength === 'STRONG' ? 9 : bsl.strength === 'MEDIUM' ? 7 : 5
    const target = map.nearestSSL?.price ?? price * 0.988
    const inv = bsl.price * 1.008
    const cz = toChartZone(
      id,
      'BSL',
      'BEARISH',
      top,
      bottom,
      startTime,
      endTime,
      `SHORT · BSL ×${bsl.touches}`,
      strength
    )
    found.push({
      id,
      source: 'BSL',
      side: 'SHORT',
      top,
      bottom,
      mid: bsl.price,
      label: `BSL ×${bsl.touches} (${bsl.strength})`,
      strength,
      distancePct: ((bsl.price - price) / price) * 100,
      target,
      invalidation: inv,
      limitEntry: bsl.price * 0.9985,
      chartZone: cz,
    })
  }

  // Fib reaction bands near price
  if (fib?.chartZones?.length) {
    for (const fz of fib.chartZones.slice(0, 4)) {
      const mid = (fz.top + fz.bottom) / 2
      const dist = Math.abs((mid - price) / price) * 100
      if (dist > 4.5) continue
      const side: 'LONG' | 'SHORT' =
        fz.side === 'BEARISH' || mid > price ? 'SHORT' : 'LONG'
      const id = uid('zone_fib')
      const strength = fz.strength ?? 7
      const target =
        side === 'LONG'
          ? map.nearestBSL?.price ?? mid * 1.015
          : map.nearestSSL?.price ?? mid * 0.985
      const inv =
        side === 'LONG' ? fz.bottom * 0.994 : fz.top * 1.006
      const chartZone: LiquidityZone = {
        ...fz,
        id,
        type: fz.type === 'OTE' ? 'OTE' : 'FIBONACCI',
        label:
          side === 'LONG'
            ? `LONG · Fib ${fz.label ?? ''}`.trim()
            : `SHORT · Fib ${fz.label ?? ''}`.trim(),
        strength,
      }
      found.push({
        id,
        source: fz.type === 'OTE' ? 'OTE' : 'FIB',
        side,
        top: fz.top,
        bottom: fz.bottom,
        mid,
        label: chartZone.label ?? 'Fib',
        strength,
        distancePct: ((mid - price) / price) * 100,
        target,
        invalidation: inv,
        limitEntry: side === 'LONG' ? mid * 1.001 : mid * 0.999,
        chartZone,
      })
    }
  }

  // Prefer nearest below for LONG, nearest above for SHORT, then by strength
  const longs = found
    .filter((z) => z.side === 'LONG')
    .sort((a, b) => {
      const da = Math.abs(a.distancePct)
      const db = Math.abs(b.distancePct)
      return da - db || b.strength - a.strength
    })
  const shorts = found
    .filter((z) => z.side === 'SHORT')
    .sort((a, b) => {
      const da = Math.abs(a.distancePct)
      const db = Math.abs(b.distancePct)
      return da - db || b.strength - a.strength
    })

  const zones = [...longs.slice(0, 2), ...shorts.slice(0, 2)]
  const chartZones = zones.map((z) => z.chartZone)

  const zoneSetups = zones.map((z) =>
    zoneToSetup(z, price, input.signal ?? null, input.bookImbalance ?? null)
  )

  let extra: ConditionalSetup[] = []
  if (input.signal) {
    extra = buildConditionalSetups({
      signal: input.signal,
      forecast: input.forecast ?? null,
      liquidityMap: map,
      mmIntent: input.mmIntent ?? null,
      htfTrend: input.signal.htfTrend,
      price,
    }).filter(
      (s) =>
        s.kind === 'BOUNCE_SSL' ||
        s.kind === 'BOUNCE_BSL' ||
        s.kind === 'SURGICAL' ||
        s.kind === 'MM_HUNT'
    )
  }

  // Dedupe by side+rough entry
  const setups = [...zoneSetups]
  for (const s of extra) {
    const dup = setups.some(
      (x) =>
        x.side === s.side &&
        Math.abs(x.limitEntry - s.limitEntry) / s.limitEntry < 0.002
    )
    if (!dup) setups.push(s)
  }

  const jewelReady = setups.filter((s) => s.status === 'READY')

  return {
    zones,
    chartZones,
    setups,
    liquidityMap: map,
    nearestLong: longs[0] ?? null,
    nearestShort: shorts[0] ?? null,
    jewelReady,
  }
}

/**
 * Re-score zone setups against live price / book / signal.
 */
export function refreshZoneSetups(
  setups: ConditionalSetup[],
  price: number,
  bookImbalance: number | null,
  signal: CoinSignal | null
): ConditionalSetup[] {
  return setups.map((s) => {
    const inZone =
      price >= s.entryZone.bottom * 0.998 &&
      price <= s.entryZone.top * 1.002
    const bookOk =
      bookImbalance == null
        ? 'PENDING'
        : (s.side === 'LONG' && bookImbalance >= 12) ||
            (s.side === 'SHORT' && bookImbalance <= -12)
          ? 'MET'
          : (s.side === 'LONG' && bookImbalance <= -20) ||
              (s.side === 'SHORT' && bookImbalance >= 20)
            ? 'FAILED'
            : 'PENDING'
    const confirm =
      signal?.absorption?.detected ||
      signal?.ltfChoCH?.detected ||
      signal?.surgicalEntry?.status === 'READY'
        ? 'MET'
        : 'PENDING'

    const pre: SetupPrecondition[] = s.preconditions.map((p) => {
      if (p.id === 'touch' || p.id === 'zone') {
        return { ...p, status: inZone ? 'MET' : 'PENDING' }
      }
      if (p.id === 'book') {
        return { ...p, status: bookOk }
      }
      if (p.id === 'confirm' || p.id === 'reject') {
        return {
          ...p,
          status: confirm === 'MET' ? 'MET' : p.status === 'MET' ? 'MET' : 'PENDING',
        }
      }
      return p
    })

    // Ensure book precondition exists for zone setups
    if (!pre.some((p) => p.id === 'book')) {
      pre.push({
        id: 'book',
        label: 'Стакан за сторону',
        status: bookOk,
      })
    }

    const status = statusFromPre(pre)
    const probability = Math.min(
      82,
      s.probability +
        (inZone ? 6 : 0) +
        (bookOk === 'MET' ? 8 : 0) +
        (confirm === 'MET' ? 8 : 0)
    )

    return { ...s, preconditions: pre, status, probability }
  })
}
