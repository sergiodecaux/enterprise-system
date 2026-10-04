import type {
  LiquidityMap,
  OrderBookWall,
  WhaleAlert,
  WhaleOrder,
  WhaleWatcherState,
} from '../types'
import type { LiqHeatmapModel } from '../derivatives/liqHeatmap'
import { formatWhaleVolume } from './whaleDetector'

/** Minimal spent-pool shape — reuse chartStory.spent without importing that module. */
interface SpentPools {
  ssl?: { price: number } | null
  bsl?: { price: number } | null
}

export type WhaleSitSide = 'LONG' | 'SHORT'
export type WhaleSitSource = 'WALL' | 'ALERT' | 'MAGNET' | 'OI' | 'LIQ'

export interface WhaleSitCluster {
  id: string
  price: number
  side: WhaleSitSide
  /** «киты лонг здесь» / «киты шорт / стопы здесь» */
  label: string
  /** Compact right-edge mark */
  shortLabel: string
  source: WhaleSitSource
  sourceNote: string
  volumeUsd: number
  distancePct: number
  above: boolean
  /** Already swept — do not hunt */
  spent: boolean
  /** Nearest unused cluster above or below price */
  hunted: boolean
  score: number
}

export interface WhaleSitMap {
  clusters: WhaleSitCluster[]
  nearestBelow: WhaleSitCluster | null
  nearestAbove: WhaleSitCluster | null
  /** One line under the chart */
  huntLine: string
  accumulation: WhaleSitSide | null
  accumulationReason: string | null
}

export interface WhaleSitInput {
  price: number
  whale?: WhaleWatcherState | null
  liquidityMap?: LiquidityMap | null
  liqHeatmap?: LiqHeatmapModel | null
  walls?: OrderBookWall[] | null
  spent?: SpentPools | null
}

const MERGE_PCT = 0.22
const HUNT_MAX_PCT = 5.5
const THROUGH_PAD = 0.0012

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(4)
}

function distPct(price: number, level: number): number {
  if (!(price > 0)) return 0
  return (Math.abs(price - level) / price) * 100
}

function sameBand(a: number, b: number, price: number): boolean {
  if (!(a > 0) || !(b > 0) || !(price > 0)) return false
  const tol = Math.max(price * (MERGE_PCT / 100), Math.abs(a) * 0.0008)
  return Math.abs(a - b) <= tol
}

function sitLabel(side: WhaleSitSide): string {
  return side === 'LONG' ? 'киты лонг здесь' : 'киты шорт / стопы здесь'
}

function sitShort(side: WhaleSitSide): string {
  return side === 'LONG' ? 'лонг' : 'шорт·стопы'
}

function wallSpent(side: WhaleSitSide, level: number, price: number): boolean {
  if (!(price > 0) || !(level > 0)) return false
  if (side === 'LONG') return price < level * (1 - THROUGH_PAD)
  return price > level * (1 + THROUGH_PAD)
}

function poolMatches(
  spent: SpentPools | null | undefined,
  side: WhaleSitSide,
  level: number,
  price: number
): boolean {
  const pool = side === 'LONG' ? spent?.ssl : spent?.bsl
  if (!pool || !(pool.price > 0)) return false
  return sameBand(pool.price, level, price)
}

interface RawSit {
  price: number
  side: WhaleSitSide
  source: WhaleSitSource
  sourceNote: string
  volumeUsd: number
  spent: boolean
  score: number
}

function pushRaw(out: RawSit[], row: RawSit) {
  if (!(row.price > 0) || !Number.isFinite(row.price)) return
  out.push(row)
}

function fromOrder(
  order: WhaleOrder,
  source: WhaleSitSource,
  note: string,
  price: number,
  spent: SpentPools | null | undefined
): RawSit {
  const side: WhaleSitSide = order.side === 'BID' ? 'LONG' : 'SHORT'
  return {
    price: order.price,
    side,
    source,
    sourceNote: note,
    volumeUsd: order.volumeUsd,
    spent:
      wallSpent(side, order.price, price) ||
      poolMatches(spent, side, order.price, price),
    score:
      Math.min(order.volumeUsd / 1_000_000, 8) +
      (order.distancePct <= 1 ? 2.4 : order.distancePct <= 2.5 ? 1.4 : 0.6),
  }
}

function collectRaws(input: WhaleSitInput): RawSit[] {
  const price = input.price
  const spent = input.spent ?? null
  const raws: RawSit[] = []
  if (!(price > 0)) return raws

  const whale = input.whale
  if (whale?.strongestSupport) {
    pushRaw(
      raws,
      fromOrder(
        whale.strongestSupport,
        'WALL',
        `стена bid ${formatWhaleVolume(whale.strongestSupport.volumeUsd)}`,
        price,
        spent
      )
    )
  }
  if (whale?.strongestResistance) {
    pushRaw(
      raws,
      fromOrder(
        whale.strongestResistance,
        'WALL',
        `стена ask ${formatWhaleVolume(whale.strongestResistance.volumeUsd)}`,
        price,
        spent
      )
    )
  }

  const seenAlert = new Set<string>()
  const alerts = whale?.alerts ?? []
  for (const alert of alerts) {
    if (!alert.isActive || alert.isExpired) continue
    const key = `${alert.order.side}:${alert.order.price.toFixed(6)}`
    if (seenAlert.has(key)) continue
    seenAlert.add(key)
    const note =
      alert.order.side === 'BID'
        ? `алерт bid ${formatWhaleVolume(alert.order.volumeUsd)}`
        : `алерт ask ${formatWhaleVolume(alert.order.volumeUsd)}`
    pushRaw(raws, fromOrder(alert.order, 'ALERT', note, price, spent))
  }

  const walls = input.walls ?? []
  for (const wall of walls) {
    if (!(wall.price > 0) || !(wall.volume > 0)) continue
    const side: WhaleSitSide = wall.side === 'BID' ? 'LONG' : 'SHORT'
    const volumeUsd = wall.volume * wall.price
    if (volumeUsd < 250_000 && wall.ratio < 2.2) continue
    pushRaw(raws, {
      price: wall.price,
      side,
      source: 'WALL',
      sourceNote:
        wall.side === 'BID'
          ? `стена bid ×${wall.ratio.toFixed(1)}`
          : `стена ask ×${wall.ratio.toFixed(1)}`,
      volumeUsd,
      spent: wallSpent(side, wall.price, price) || poolMatches(spent, side, wall.price, price),
      score: Math.min(wall.ratio, 6) + (volumeUsd >= 1_000_000 ? 1.5 : 0.4),
    })
  }

  const map = input.liquidityMap
  if (map) {
    const magnets = [...map.equalLows, ...map.equalHighs]
    if (map.nearestSSL) magnets.push(map.nearestSSL)
    if (map.nearestBSL) magnets.push(map.nearestBSL)
    const seenMag = new Set<string>()
    for (const lvl of magnets) {
      if (!(lvl.price > 0)) continue
      const key = `${lvl.type}:${lvl.price.toFixed(6)}`
      if (seenMag.has(key)) continue
      seenMag.add(key)
      const side: WhaleSitSide = lvl.type === 'LOW' ? 'LONG' : 'SHORT'
      const inactive = lvl.isActive === false
      const through = wallSpent(side, lvl.price, price)
      const strength =
        lvl.strength === 'STRONG' ? 3.2 : lvl.strength === 'MEDIUM' ? 2.1 : 1.1
      pushRaw(raws, {
        price: lvl.price,
        side,
        source: 'MAGNET',
        sourceNote:
          lvl.type === 'LOW'
            ? `магнит SSL ×${lvl.touches}`
            : `магнит BSL ×${lvl.touches}`,
        volumeUsd: 0,
        spent: inactive || through || poolMatches(spent, side, lvl.price, price),
        score: strength + Math.min(lvl.touches * 0.35, 2) + (lvl.isActive ? 0.8 : 0),
      })
    }
  }

  const heat = input.liqHeatmap
  if (heat) {
    for (const c of heat.longClusters) {
      if (!(c.price > 0) || c.score < 0.34) continue
      pushRaw(raws, {
        price: c.price,
        side: 'LONG',
        source: 'OI',
        sourceNote: `OI лонги ${(c.score * 100).toFixed(0)}%`,
        volumeUsd: 0,
        spent:
          wallSpent('LONG', c.price, price) ||
          poolMatches(spent, 'LONG', c.price, price),
        score: 1.2 + c.score * 2.4,
      })
    }
    for (const c of heat.shortClusters) {
      if (!(c.price > 0) || c.score < 0.34) continue
      pushRaw(raws, {
        price: c.price,
        side: 'SHORT',
        source: 'OI',
        sourceNote: `OI шорты ${(c.score * 100).toFixed(0)}%`,
        volumeUsd: 0,
        spent:
          wallSpent('SHORT', c.price, price) ||
          poolMatches(spent, 'SHORT', c.price, price),
        score: 1.2 + c.score * 2.4,
      })
    }
    if (heat.nearestLongLiq != null && heat.nearestLongLiq > 0) {
      pushRaw(raws, {
        price: heat.nearestLongLiq,
        side: 'LONG',
        source: 'LIQ',
        sourceNote: 'liq лонги / стопы',
        volumeUsd: 0,
        spent:
          wallSpent('LONG', heat.nearestLongLiq, price) ||
          poolMatches(spent, 'LONG', heat.nearestLongLiq, price),
        score: 1.6,
      })
    }
    if (heat.nearestShortLiq != null && heat.nearestShortLiq > 0) {
      pushRaw(raws, {
        price: heat.nearestShortLiq,
        side: 'SHORT',
        source: 'LIQ',
        sourceNote: 'liq шорты / стопы',
        volumeUsd: 0,
        spent:
          wallSpent('SHORT', heat.nearestShortLiq, price) ||
          poolMatches(spent, 'SHORT', heat.nearestShortLiq, price),
        score: 1.6,
      })
    }
  }

  return raws
}

const SOURCE_RANK: Record<WhaleSitSource, number> = {
  WALL: 5,
  ALERT: 4,
  MAGNET: 3,
  OI: 2,
  LIQ: 1,
}

function mergeRaws(raws: RawSit[], price: number): WhaleSitCluster[] {
  const groups: RawSit[][] = []
  for (const row of raws) {
    const hit = groups.find(
      (g) => g[0].side === row.side && sameBand(g[0].price, row.price, price)
    )
    if (hit) hit.push(row)
    else groups.push([row])
  }

  return groups.map((g, i) => {
    g.sort((a, b) => {
      if (SOURCE_RANK[b.source] !== SOURCE_RANK[a.source]) {
        return SOURCE_RANK[b.source] - SOURCE_RANK[a.source]
      }
      return b.score - a.score
    })
    const head = g[0]
    const volumeUsd = g.reduce((s, r) => Math.max(s, r.volumeUsd), 0)
    const score = g.reduce((s, r) => s + r.score, 0)
    const spent = g.some((r) => r.spent)
    const notes = [...new Set(g.map((r) => r.sourceNote))].slice(0, 2)
    const mid =
      g.reduce((s, r) => s + r.price * Math.max(r.score, 0.2), 0) /
      g.reduce((s, r) => s + Math.max(r.score, 0.2), 0)
    const above = mid > price
    return {
      id: `${head.side}_${mid.toFixed(6)}_${i}`,
      price: mid,
      side: head.side,
      label: sitLabel(head.side),
      shortLabel: sitShort(head.side),
      source: head.source,
      sourceNote: notes.join(' · '),
      volumeUsd,
      distancePct: distPct(price, mid),
      above,
      spent,
      hunted: false,
      score,
    }
  })
}

function pickHunt(
  live: WhaleSitCluster[],
  above: boolean
): WhaleSitCluster | null {
  const pool = live
    .filter((c) => c.above === above && c.distancePct <= HUNT_MAX_PCT)
    .sort((a, b) => {
      const da = a.distancePct + (a.score > 3 ? 0 : 0.15)
      const db = b.distancePct + (b.score > 3 ? 0 : 0.15)
      if (Math.abs(da - db) > 0.08) return da - db
      return b.score - a.score
    })
  return pool[0] ?? null
}

/**
 * Cheap tag from whaleWatcher only — no extra IO.
 * Large resting bid vs ask near price = киты набирают лонг/шорт.
 */
export function inferWhaleAccumulation(
  whale: WhaleWatcherState | null | undefined
): { side: WhaleSitSide; reason: string } | null {
  if (!whale) return null
  const bid = whale.strongestSupport
  const ask = whale.strongestResistance
  const bidUsd = bid?.volumeUsd ?? 0
  const askUsd = ask?.volumeUsd ?? 0
  const nearBid = bid && bid.distancePct <= 3
  const nearAsk = ask && ask.distancePct <= 3

  const alerts = whale.alerts.filter((a: WhaleAlert) => a.isActive && !a.isExpired)
  const bidAlerts = alerts.filter((a) => a.order.side === 'BID').length
  const askAlerts = alerts.filter((a) => a.order.side === 'ASK').length

  if (nearBid && bidUsd >= 1_000_000 && (bidUsd >= askUsd * 1.45 || !nearAsk)) {
    return {
      side: 'LONG',
      reason: `киты набирают лонг · ${formatWhaleVolume(bidUsd)}`,
    }
  }
  if (nearAsk && askUsd >= 1_000_000 && (askUsd >= bidUsd * 1.45 || !nearBid)) {
    return {
      side: 'SHORT',
      reason: `киты набирают шорт · ${formatWhaleVolume(askUsd)}`,
    }
  }
  if (bidAlerts >= 2 && bidAlerts > askAlerts && nearBid) {
    return { side: 'LONG', reason: 'киты набирают лонг' }
  }
  if (askAlerts >= 2 && askAlerts > bidAlerts && nearAsk) {
    return { side: 'SHORT', reason: 'киты набирают шорт' }
  }
  return null
}

function huntLineOf(
  below: WhaleSitCluster | null,
  above: WhaleSitCluster | null,
  acc: { side: WhaleSitSide; reason: string } | null
): string {
  const bits: string[] = []
  if (below) {
    const vol = below.volumeUsd >= 250_000 ? ` ${formatWhaleVolume(below.volumeUsd)}` : ''
    bits.push(
      `${below.label} ${fmtPx(below.price)} ↓${below.distancePct.toFixed(2)}%${vol}`
    )
  }
  if (above) {
    const vol = above.volumeUsd >= 250_000 ? ` ${formatWhaleVolume(above.volumeUsd)}` : ''
    bits.push(
      `${above.label} ${fmtPx(above.price)} ↑${above.distancePct.toFixed(2)}%${vol}`
    )
  }
  if (!bits.length) {
    return acc ? acc.reason : 'Киты: кластеров рядом нет'
  }
  const accBit = acc ? ` · ${acc.reason}` : ''
  return `Киты: ${bits.join('  ·  ')}${accBit}`
}

/**
 * Where large players are likely sitting — walls, magnets, whale alerts, OI bands.
 * Reuses spent-liquidity / isActive so hunted levels are still unused.
 */
export function buildWhaleSitMap(input: WhaleSitInput): WhaleSitMap {
  const price = input.price
  const acc = inferWhaleAccumulation(input.whale)
  if (!(price > 0)) {
    return {
      clusters: [],
      nearestBelow: null,
      nearestAbove: null,
      huntLine: acc ? acc.reason : '',
      accumulation: acc?.side ?? null,
      accumulationReason: acc?.reason ?? null,
    }
  }

  const merged = mergeRaws(collectRaws(input), price)
    .filter((c) => c.distancePct <= 8)
    .sort((a, b) => a.distancePct - b.distancePct)

  const live = merged.filter((c) => !c.spent)
  const below = pickHunt(live, false)
  const above = pickHunt(live, true)
  const huntedIds = new Set(
    [below, above].filter((c): c is WhaleSitCluster => c != null).map((c) => c.id)
  )

  const clusters = merged.map((c) => ({
    ...c,
    hunted: huntedIds.has(c.id),
  }))

  return {
    clusters,
    nearestBelow: below ? { ...below, hunted: true } : null,
    nearestAbove: above ? { ...above, hunted: true } : null,
    huntLine: huntLineOf(
      below ? { ...below, hunted: true } : null,
      above ? { ...above, hunted: true } : null,
      acc
    ),
    accumulation: acc?.side ?? null,
    accumulationReason: acc?.reason ?? null,
  }
}

export function formatSitVolume(usd: number): string {
  return formatWhaleVolume(usd)
}
