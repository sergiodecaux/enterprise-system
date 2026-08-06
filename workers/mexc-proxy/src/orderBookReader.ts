/**
 * Dedicated meme order-flow reader.
 *
 * Priority: MM manipulation patterns (absorption / spoof-sweep / cascade),
 * then classic wall release / pressure. Entry is LIMIT_CHASE (maker), not market.
 */

import { detectMmSignal, type MmSignal } from './mmPatterns'

export type BookDirection = 'LONG' | 'SHORT'
export type RawDepthLevel = [number, number, number]

export interface OrderBookSnapshot {
  symbol: string
  at: number
  mid: number
  asks: Array<[number, number]>
  bids: Array<[number, number]>
  obi: number
}

export interface OrderBookEvent {
  ready: boolean
  side: BookDirection | null
  confidence: number
  kind:
    | 'ASK_WALL_REMOVED'
    | 'BID_WALL_REMOVED'
    | 'TRAP_FLIP_LONG'
    | 'TRAP_FLIP_SHORT'
    | 'BID_WALL_SUPPORT'
    | 'ASK_WALL_RESISTANCE'
    | 'BUY_FLOW_IMBALANCE'
    | 'SELL_FLOW_IMBALANCE'
    | 'ABSORPTION_LONG'
    | 'ABSORPTION_SHORT'
    | 'SPOOF_SWEEP_LONG'
    | 'SPOOF_SWEEP_SHORT'
    | 'LIQ_CASCADE_LONG'
    | 'LIQ_CASCADE_SHORT'
    | 'CVD_DIVERGENCE'
    | 'WASH_SKIP'
    | 'CONFLICT'
    | 'NO_EVENT'
  /** LIMIT_CHASE = post-only at best bid/ask; MARKET legacy */
  entryMode: 'MARKET' | 'RETEST' | 'LIMIT_CHASE'
  mmPattern?: string | null
  wallPrice: number | null
  wallDropPct: number
  wallMultiple: number
  flowSharePct: number
  obi: number
  obiChange: number
  priceMoveBps: number
  spreadBps: number
  relocated: boolean
  wallPersisted: boolean
  trap: boolean
  /** Live book risk/reward — preferred over ATR */
  slPrice: number | null
  tpPrice: number | null
  tp1Price: number | null
  notes: string[]
}

export interface OrderBookRead {
  snapshot: OrderBookSnapshot | null
  event: OrderBookEvent
}

interface Level {
  price: number
  vol: number
}

interface Deal {
  p?: number
  v?: number
  T?: number
  t?: number
  ts?: number
}

const emptyEvent = (note: string): OrderBookEvent => ({
  ready: false,
  side: null,
  confidence: 0,
  kind: 'NO_EVENT',
  entryMode: 'LIMIT_CHASE',
  mmPattern: null,
  wallPrice: null,
  wallDropPct: 0,
  wallMultiple: 0,
  flowSharePct: 50,
  obi: 0,
  obiChange: 0,
  priceMoveBps: 0,
  spreadBps: 0,
  relocated: false,
  wallPersisted: false,
  trap: false,
  slPrice: null,
  tpPrice: null,
  tp1Price: null,
  notes: [note],
})

function mmToEvent(signal: MmSignal, mid: number, asks: Level[], bids: Level[]): OrderBookEvent {
  const bestAsk = asks[0]?.price ?? mid
  const bestBid = bids[0]?.price ?? mid
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000
  const kind =
    signal.pattern === 'SPOOF_SWEEP'
      ? signal.side === 'LONG'
        ? 'SPOOF_SWEEP_LONG'
        : 'SPOOF_SWEEP_SHORT'
      : signal.pattern === 'LIQ_CASCADE'
        ? signal.side === 'LONG'
          ? 'LIQ_CASCADE_LONG'
          : 'LIQ_CASCADE_SHORT'
        : signal.pattern === 'CVD_DIVERGENCE'
          ? 'CVD_DIVERGENCE'
          : signal.side === 'LONG'
            ? 'ABSORPTION_LONG'
            : 'ABSORPTION_SHORT'
  const flowShare =
    signal.side === 'LONG'
      ? signal.buyQuote30s + signal.sellQuote30s > 0
        ? (signal.sellQuote30s / (signal.buyQuote30s + signal.sellQuote30s)) * 100
        : 50
      : signal.buyQuote30s + signal.sellQuote30s > 0
        ? (signal.buyQuote30s / (signal.buyQuote30s + signal.sellQuote30s)) * 100
        : 50
  // For absorption LONG, "aggressive against" is sells — report sell share as confirmation metric
  const confirmShare =
    signal.pattern === 'ABSORPTION' || signal.pattern === 'CVD_DIVERGENCE'
      ? signal.side === 'LONG'
        ? (signal.sellQuote30s /
            Math.max(1, signal.sellQuote30s + signal.buyQuote30s)) *
          100
        : (signal.buyQuote30s /
            Math.max(1, signal.sellQuote30s + signal.buyQuote30s)) *
          100
      : signal.side === 'LONG'
        ? 100 -
          (signal.sellQuote30s /
            Math.max(1, signal.sellQuote30s + signal.buyQuote30s)) *
            100
        : (signal.sellQuote30s /
            Math.max(1, signal.sellQuote30s + signal.buyQuote30s)) *
          100
  return {
    ready: signal.ready,
    side: signal.side,
    confidence: signal.confidence,
    kind,
    entryMode: 'LIMIT_CHASE',
    mmPattern: signal.pattern,
    wallPrice: signal.limitPrice,
    wallDropPct:
      signal.side === 'LONG' ? signal.askDepthDropPct : signal.bidDepthDropPct,
    wallMultiple: signal.wallMultiple,
    flowSharePct: Number((confirmShare || flowShare).toFixed(1)),
    obi: 0,
    obiChange: 0,
    priceMoveBps: signal.priceMoveBps,
    spreadBps: Number(spreadBps.toFixed(1)),
    relocated: false,
    wallPersisted: false,
    trap: signal.pattern === 'SPOOF_SWEEP',
    slPrice: signal.slPrice,
    tpPrice: signal.tpPrice,
    tp1Price: signal.tp1Price,
    notes: signal.notes,
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function parseLevels(
  rows: RawDepthLevel[] | undefined,
  side: 'ASK' | 'BID'
): Level[] {
  const levels = (rows ?? [])
    .slice(0, 20)
    .map((row) => ({ price: Number(row[0]), vol: Number(row[1] ?? 0) }))
    .filter((level) => level.price > 0 && level.vol > 0)
  return levels.sort((a, b) =>
    side === 'ASK' ? a.price - b.price : b.price - a.price
  )
}

function imbalance(asks: Level[], bids: Level[]): number {
  const ask = asks.reduce((sum, level) => sum + level.vol, 0)
  const bid = bids.reduce((sum, level) => sum + level.vol, 0)
  return ask + bid > 0 ? ((bid - ask) / (bid + ask)) * 100 : 0
}

/** Retail noise on asks: $5–10 sells that bait shorts (not real walls). */
export interface CrowdBookMetrics {
  crowdAskLevels: number
  crowdAskUsd: number
  realAskUsd: number
  crowdAskShare: number
  /** Many tiny asks + thin real ask = shorts get lured */
  shortBaitAsks: boolean
  /** Real buy support vs crowd noise */
  bidSupportUsd: number
}

const CROWD_USD_LO = 1
const CROWD_USD_HI = 10
const REAL_LEVEL_USD = 120

export function analyzeCrowdBook(
  snap: OrderBookSnapshot | null | undefined
): CrowdBookMetrics {
  if (!snap?.asks?.length) {
    return {
      crowdAskLevels: 0,
      crowdAskUsd: 0,
      realAskUsd: 0,
      crowdAskShare: 0,
      shortBaitAsks: false,
      bidSupportUsd: 0,
    }
  }
  const nearAsks = snap.asks.slice(0, 15)
  let crowdAskLevels = 0
  let crowdAskUsd = 0
  let realAskUsd = 0
  for (const [price, vol] of nearAsks) {
    const usd = price * vol
    if (!(usd > 0)) continue
    if (usd >= CROWD_USD_LO && usd <= CROWD_USD_HI) {
      crowdAskLevels++
      crowdAskUsd += usd
    } else if (usd >= REAL_LEVEL_USD) {
      realAskUsd += usd
    }
  }
  const crowdAskShare =
    nearAsks.length > 0 ? crowdAskLevels / nearAsks.length : 0
  let bidSupportUsd = 0
  for (const [price, vol] of (snap.bids ?? []).slice(0, 8)) {
    const usd = price * vol
    if (usd >= REAL_LEVEL_USD) bidSupportUsd += usd
  }
  // Trap for shorts: ≥3 tiny $1–10 ask clips OR ≥30% of near asks are retail-sized
  const shortBaitAsks =
    (crowdAskLevels >= 3 || crowdAskShare >= 0.3) &&
    realAskUsd < Math.max(350, crowdAskUsd * 10)
  return {
    crowdAskLevels,
    crowdAskUsd: Number(crowdAskUsd.toFixed(1)),
    realAskUsd: Number(realAskUsd.toFixed(1)),
    crowdAskShare: Number(crowdAskShare.toFixed(2)),
    shortBaitAsks,
    bidSupportUsd: Number(bidSupportUsd.toFixed(1)),
  }
}

function nearestVolume(
  levels: Level[],
  price: number,
  mid: number,
  tolerance = 0.00025
): number {
  return levels
    .filter((level) => Math.abs(level.price - price) / mid <= tolerance)
    .reduce((sum, level) => sum + level.vol, 0)
}

/**
 * Book SL/TP with hard floors. Near-touch walls made 0.05% stops and
 * exploded R-multiples on noise — never allow SL closer than 1.4%.
 */
function bookLevels(
  side: BookDirection,
  mid: number,
  asks: Level[],
  bids: Level[]
): { sl: number; tp1: number; tp: number } {
  const medAsk = median(asks.map((l) => l.vol)) || 1
  const medBid = median(bids.map((l) => l.vol)) || 1
  const strongAsks = asks.filter((l) => l.vol >= medAsk * 2.2 && l.price > mid)
  const strongBids = bids.filter((l) => l.vol >= medBid * 2.2 && l.price < mid)
  const minRisk = 0.014
  const maxRisk = 0.028

  if (side === 'LONG') {
    // Prefer the 2nd support wall — first is often spoof noise under mid.
    const slWall = strongBids[1]?.price ?? strongBids[0]?.price ?? mid * (1 - minRisk)
    let sl = Math.min(slWall, mid * (1 - minRisk))
    if ((mid - sl) / mid < minRisk) sl = mid * (1 - minRisk)
    if ((mid - sl) / mid > maxRisk) sl = mid * (1 - maxRisk)
    const tp1Wall = strongAsks[0]?.price ?? mid * 1.016
    const tpWall = strongAsks[1]?.price ?? strongAsks[0]?.price ?? mid * 1.032
    let tp1 = Math.max(tp1Wall, mid * 1.012)
    let tp = Math.max(tpWall, mid * 1.024)
    // Keep RR ≥ 1.5 vs risk
    const risk = mid - sl
    if (tp1 - mid < risk * 1.2) tp1 = mid + risk * 1.2
    if (tp - mid < risk * 1.8) tp = mid + risk * 1.8
    return { sl, tp1, tp }
  }

  const slWall = strongAsks[1]?.price ?? strongAsks[0]?.price ?? mid * (1 + minRisk)
  let sl = Math.max(slWall, mid * (1 + minRisk))
  if ((sl - mid) / mid < minRisk) sl = mid * (1 + minRisk)
  if ((sl - mid) / mid > maxRisk) sl = mid * (1 + maxRisk)
  const tp1Wall = strongBids[0]?.price ?? mid * 0.984
  const tpWall = strongBids[1]?.price ?? strongBids[0]?.price ?? mid * 0.968
  let tp1 = Math.min(tp1Wall, mid * 0.988)
  let tp = Math.min(tpWall, mid * 0.976)
  const risk = sl - mid
  if (mid - tp1 < risk * 1.2) tp1 = mid - risk * 1.2
  if (mid - tp < risk * 1.8) tp = mid - risk * 1.8
  return { sl, tp1, tp }
}

interface RemovedWall {
  side: 'ASK' | 'BID'
  price: number
  dropPct: number
  multiple: number
  relocated: boolean
  crossed: boolean
  persisted: boolean
}

interface PersistentWall {
  side: 'ASK' | 'BID'
  price: number
  multiple: number
  persisted: boolean
}

function strongestPersistentWall(
  older: Level[],
  previous: Level[],
  current: Level[],
  side: 'ASK' | 'BID',
  mid: number
): PersistentWall | null {
  const med = median(previous.map((level) => level.vol)) || 1
  let best: PersistentWall | null = null
  for (const level of previous) {
    const multiple = level.vol / med
    if (multiple < 3.2 || Math.abs(level.price - mid) / mid > 0.008) continue
    const currentVolume = nearestVolume(current, level.price, mid, 0.001)
    if (currentVolume < level.vol * 0.5) continue
    const olderVolume = nearestVolume(older, level.price, mid, 0.001)
    const candidate = {
      side,
      price: level.price,
      multiple,
      persisted: olderVolume >= level.vol * 0.4,
    }
    if (!best || candidate.multiple > best.multiple) best = candidate
  }
  return best
}

function strongestRemovedWall(
  previous: Level[],
  current: Level[],
  side: 'ASK' | 'BID',
  previousMid: number,
  currentMid: number,
  older: Level[] = []
): RemovedWall | null {
  const med = median(previous.map((level) => level.vol)) || 1
  let best: RemovedWall | null = null

  for (const before of previous) {
    const distance = Math.abs(before.price - previousMid) / previousMid
    const multiple = before.vol / med
    if (distance > 0.008 || multiple < 3.2) continue

    const remaining = nearestVolume(current, before.price, currentMid)
    const dropPct = Math.max(0, (before.vol - remaining) / before.vol) * 100
    if (dropPct < 60) continue

    const relocated = current.some(
      (level) =>
        Math.abs(level.price - before.price) / currentMid > 0.00025 &&
        Math.abs(level.price - before.price) / currentMid <= 0.0018 &&
        level.vol >= before.vol * 0.55
    )
    const crossed =
      side === 'ASK'
        ? (current[0]?.price ?? currentMid) > before.price
        : (current[0]?.price ?? currentMid) < before.price
    const olderVolume = nearestVolume(older, before.price, previousMid)
    const candidate = {
      side,
      price: before.price,
      dropPct,
      multiple,
      relocated,
      crossed,
      persisted: olderVolume >= before.vol * 0.45,
    }
    if (
      !best ||
      candidate.multiple * candidate.dropPct >
        best.multiple * best.dropPct
    ) {
      best = candidate
    }
  }
  return best
}

function dealFlow(deals: Deal[], now: number): {
  buyVol: number
  sellVol: number
  buyShare: number
} {
  let buyVol = 0
  let sellVol = 0
  for (const deal of deals) {
    const timestamp = Number(deal.t ?? deal.ts ?? 0)
    if (timestamp > 0 && now - timestamp > 150_000) continue
    const vol = Number(deal.v ?? 0)
    if (!(vol > 0)) continue
    if (deal.T === 1) buyVol += vol
    else if (deal.T === 2) sellVol += vol
  }
  const total = buyVol + sellVol
  return {
    buyVol,
    sellVol,
    buyShare: total > 0 ? (buyVol / total) * 100 : 50,
  }
}

function withLevels(
  event: OrderBookEvent,
  mid: number,
  asks: Level[],
  bids: Level[]
): OrderBookEvent {
  if (!event.side) return event
  const levels = bookLevels(event.side, mid, asks, bids)
  return {
    ...event,
    slPrice: levels.sl,
    tp1Price: levels.tp1,
    tpPrice: levels.tp,
  }
}

function analyzePersistentPressure(
  older: OrderBookSnapshot | null,
  previous: OrderBookSnapshot,
  current: OrderBookSnapshot,
  deals: Deal[]
): OrderBookEvent {
  if (!older) return emptyEvent('Стакан: жду третий снимок стены')
  const olderAsks = older.asks.map(([price, vol]) => ({ price, vol }))
  const olderBids = older.bids.map(([price, vol]) => ({ price, vol }))
  const prevAsks = previous.asks.map(([price, vol]) => ({ price, vol }))
  const prevBids = previous.bids.map(([price, vol]) => ({ price, vol }))
  const asks = current.asks.map(([price, vol]) => ({ price, vol }))
  const bids = current.bids.map(([price, vol]) => ({ price, vol }))
  const askWall = strongestPersistentWall(
    olderAsks,
    prevAsks,
    asks,
    'ASK',
    current.mid
  )
  const bidWall = strongestPersistentWall(
    olderBids,
    prevBids,
    bids,
    'BID',
    current.mid
  )
  if (!askWall && !bidWall) {
    // Pre-impulse only: OBI must be BUILDING across three snapshots, not flat noise.
    const buildingLong =
      older.obi >= 8 &&
      previous.obi > older.obi + 3 &&
      current.obi > previous.obi + 3 &&
      current.obi >= 22
    const buildingShort =
      older.obi <= -8 &&
      previous.obi < older.obi - 3 &&
      current.obi < previous.obi - 3 &&
      current.obi <= -22
    if (!buildingLong && !buildingShort) {
      return emptyEvent(
        'Стакан: нет нарастающего дисбаланса (жду pre-impulse, не каждый тик)'
      )
    }
    const side: BookDirection = buildingLong ? 'LONG' : 'SHORT'
    const flow = dealFlow(deals, current.at)
    const flowShare = side === 'LONG' ? flow.buyShare : 100 - flow.buyShare
    const priceMoveBps =
      ((current.mid - previous.mid) / previous.mid) * 10_000
    const priceNotAgainst =
      side === 'LONG' ? priceMoveBps >= -1 : priceMoveBps <= 1
    const bestAsk = asks[0]?.price ?? current.mid
    const bestBid = bids[0]?.price ?? current.mid
    const spreadBps = ((bestAsk - bestBid) / current.mid) * 10_000
    const flowAligned = flowShare >= 60
    const ready = flowAligned && priceNotAgainst && spreadBps <= 60
    const confidence = Math.min(
      88,
      Math.round(
        68 +
          Math.min(12, Math.abs(current.obi) * 0.22) +
          (flowAligned ? 8 : 0) +
          (priceNotAgainst ? 4 : 0)
      )
    )
    return withLevels(
      {
        ready,
        side,
        confidence,
        kind: side === 'LONG' ? 'BUY_FLOW_IMBALANCE' : 'SELL_FLOW_IMBALANCE',
        entryMode: 'MARKET',
        wallPrice: side === 'LONG' ? bestBid : bestAsk,
        wallDropPct: 0,
        wallMultiple: 0,
        flowSharePct: Number(flowShare.toFixed(1)),
        obi: Number(current.obi.toFixed(1)),
        obiChange: Number((current.obi - previous.obi).toFixed(1)),
        priceMoveBps: Number(priceMoveBps.toFixed(1)),
        spreadBps: Number(spreadBps.toFixed(1)),
        relocated: false,
        wallPersisted: true,
        trap: false,
        slPrice: null,
        tpPrice: null,
        tp1Price: null,
        notes: [
          `OBI устойчив: ${older.obi.toFixed(0)}% → ${previous.obi.toFixed(0)}% → ${current.obi.toFixed(0)}%`,
          `Агрессивный поток за ${side}: ${flowShare.toFixed(0)}%`,
          `Импульсный вход по рынку — без ожидания TA-зоны`,
        ],
      },
      current.mid,
      asks,
      bids
    )
  }
  if (
    askWall &&
    bidWall &&
    Math.max(askWall.multiple, bidWall.multiple) /
      Math.max(1, Math.min(askWall.multiple, bidWall.multiple)) <
      1.3
  ) {
    return {
      ...emptyEvent('Стакан сбалансирован крупными стенами с двух сторон'),
      kind: 'CONFLICT',
    }
  }

  const wall =
    !askWall ||
    (bidWall && bidWall.multiple > askWall.multiple)
      ? bidWall
      : askWall
  if (!wall) return emptyEvent('Стакан: направленного давления нет')
  const side: BookDirection = wall.side === 'BID' ? 'LONG' : 'SHORT'
  const flow = dealFlow(deals, current.at)
  const flowShare = side === 'LONG' ? flow.buyShare : 100 - flow.buyShare
  const obiChange = current.obi - previous.obi
  const priceMoveBps =
    ((current.mid - previous.mid) / previous.mid) * 10_000
  const flowAligned = flowShare >= 58
  const obiAligned = side === 'LONG' ? current.obi >= 14 : current.obi <= -14
  const priceAligned = side === 'LONG' ? priceMoveBps >= 0 : priceMoveBps <= 0
  const building =
    side === 'LONG'
      ? previous.obi < current.obi && older != null && older.obi <= previous.obi
      : previous.obi > current.obi && older != null && older.obi >= previous.obi
  const bestAsk = asks[0]?.price ?? current.mid
  const bestBid = bids[0]?.price ?? current.mid
  const spreadBps = ((bestAsk - bestBid) / current.mid) * 10_000
  const ready =
    wall.persisted &&
    wall.multiple >= 4 &&
    flowAligned &&
    obiAligned &&
    priceAligned &&
    building &&
    spreadBps <= 60
  const confidence = Math.min(
    90,
    Math.round(
      60 +
        Math.min(16, (wall.multiple - 3.2) * 3) +
        (flowAligned ? 7 : 0) +
        (obiAligned ? 6 : 0) +
        (building ? 6 : 0)
    )
  )
  const label = wall.side === 'BID' ? 'BID-поддержка' : 'ASK-сопротивление'
  return withLevels(
    {
      ready,
      side,
      confidence,
      kind: side === 'LONG' ? 'BID_WALL_SUPPORT' : 'ASK_WALL_RESISTANCE',
      entryMode: 'MARKET',
      wallPrice: wall.price,
      wallDropPct: 0,
      wallMultiple: Number(wall.multiple.toFixed(2)),
      flowSharePct: Number(flowShare.toFixed(1)),
      obi: Number(current.obi.toFixed(1)),
      obiChange: Number(obiChange.toFixed(1)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      spreadBps: Number(spreadBps.toFixed(1)),
      relocated: false,
      wallPersisted: wall.persisted,
      trap: false,
      slPrice: null,
      tpPrice: null,
      tp1Price: null,
      notes: [
        `${label} @ ${wall.price} держится (×${wall.multiple.toFixed(1)})`,
        `Поток за ${side}: ${flowShare.toFixed(0)}% · OBI ${current.obi.toFixed(0)}%`,
        `Цель/стоп считаю по ближайшим стенам стакана`,
      ],
    },
    current.mid,
    asks,
    bids
  )
}

function analyzeEvent(
  older: OrderBookSnapshot | null,
  previous: OrderBookSnapshot,
  current: OrderBookSnapshot,
  deals: Deal[]
): OrderBookEvent {
  const age = current.at - previous.at
  // Too fresh = noise. Too stale = sequence broke (cron miss / cold isolate).
  // Callers rebuild a live 3-snap when stale; here we only reject noise.
  if (age < 700) {
    return emptyEvent('Стакан: снимки слишком близко — жду следующий тик')
  }
  if (age > 8 * 60_000) {
    return emptyEvent('Стакан: последовательность устарела — пересобираю')
  }

  const prevAsks = previous.asks.map(([price, vol]) => ({ price, vol }))
  const prevBids = previous.bids.map(([price, vol]) => ({ price, vol }))
  const olderAsks = (older?.asks ?? []).map(([price, vol]) => ({ price, vol }))
  const olderBids = (older?.bids ?? []).map(([price, vol]) => ({ price, vol }))
  const asks = current.asks.map(([price, vol]) => ({ price, vol }))
  const bids = current.bids.map(([price, vol]) => ({ price, vol }))
  const askWall = strongestRemovedWall(
    prevAsks,
    asks,
    'ASK',
    previous.mid,
    current.mid,
    olderAsks
  )
  const bidWall = strongestRemovedWall(
    prevBids,
    bids,
    'BID',
    previous.mid,
    current.mid,
    olderBids
  )

  if (askWall && bidWall) {
    const askStrength = askWall.multiple * askWall.dropPct
    const bidStrength = bidWall.multiple * bidWall.dropPct
    if (
      Math.max(askStrength, bidStrength) /
        Math.max(1, Math.min(askStrength, bidStrength)) <
      1.35
    ) {
      return {
        ...emptyEvent('Стакан конфликтный: одновременно сняли BID и ASK стены'),
        kind: 'CONFLICT',
      }
    }
  }

  const wall =
    !bidWall ||
    (askWall &&
      askWall.multiple * askWall.dropPct >
        bidWall.multiple * bidWall.dropPct)
      ? askWall
      : bidWall
  if (!wall) {
    return analyzePersistentPressure(older, previous, current, deals)
  }

  // Vacuum direction: pull ASK → LONG, pull BID → SHORT
  const side: BookDirection = wall.side === 'ASK' ? 'LONG' : 'SHORT'
  const flow = dealFlow(deals, current.at)
  const flowShare = side === 'LONG' ? flow.buyShare : 100 - flow.buyShare
  const obiChange = current.obi - previous.obi
  const alignedObi =
    side === 'LONG'
      ? obiChange >= 6 || current.obi >= 12
      : obiChange <= -6 || current.obi <= -12
  const priceMoveBps =
    ((current.mid - previous.mid) / previous.mid) * 10_000
  // Follow-through — slightly eased vs v19 (8bps/64%/3conf was too rare on 2m cron).
  const alignedPrice = side === 'LONG' ? priceMoveBps >= 5 : priceMoveBps <= -5
  const alignedFlow = flowShare >= 58
  const bestAsk = asks[0]?.price ?? current.mid
  const bestBid = bids[0]?.price ?? current.mid
  const spreadBps = ((bestAsk - bestBid) / current.mid) * 10_000

  // Trap = spoof wall yanked WITHOUT relocation. Relocated walls are noise — skip.
  // Require price already moving through the vacuum (not every vanish).
  const isTrap = !wall.persisted && !wall.relocated
  const trapReady =
    isTrap &&
    wall.multiple >= 4.5 &&
    wall.dropPct >= 75 &&
    wall.crossed &&
    alignedFlow &&
    alignedPrice &&
    alignedObi &&
    spreadBps <= 55

  const confirmations = [alignedFlow, alignedObi, alignedPrice].filter(
    Boolean
  ).length
  const releaseReady =
    wall.persisted &&
    !wall.relocated &&
    wall.multiple >= 3.5 &&
    wall.dropPct >= 60 &&
    wall.crossed &&
    spreadBps <= 55 &&
    alignedFlow &&
    confirmations >= 2

  const ready = trapReady || releaseReady
  const confidence = Math.min(
    96,
    Math.round(
      (isTrap ? 62 : 58) +
        Math.min(18, (wall.multiple - 3.2) * 3) +
        Math.min(10, (wall.dropPct - 70) * 0.35) +
        confirmations * 7 +
        (wall.crossed ? 6 : 0)
    )
  )
  const wallLabel = wall.side === 'ASK' ? 'ASK-продавца' : 'BID-покупателя'
  const flowLabel = side === 'LONG' ? 'покупок' : 'продаж'
  const kind = isTrap
    ? side === 'LONG'
      ? 'TRAP_FLIP_LONG'
      : 'TRAP_FLIP_SHORT'
    : side === 'LONG'
      ? 'ASK_WALL_REMOVED'
      : 'BID_WALL_REMOVED'

  return withLevels(
    {
      ready,
      side,
      confidence,
      kind,
      entryMode: 'MARKET',
      wallPrice: wall.price,
      wallDropPct: Number(wall.dropPct.toFixed(1)),
      wallMultiple: Number(wall.multiple.toFixed(2)),
      flowSharePct: Number(flowShare.toFixed(1)),
      obi: Number(current.obi.toFixed(1)),
      obiChange: Number(obiChange.toFixed(1)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      spreadBps: Number(spreadBps.toFixed(1)),
      relocated: wall.relocated,
      wallPersisted: wall.persisted,
      trap: isTrap,
      slPrice: null,
      tpPrice: null,
      tp1Price: null,
      notes: [
        isTrap
          ? `ловушка: ${wallLabel} @ ${wall.price} снята ${(wall.dropPct).toFixed(0)}% без удержания — переворот в ${side}`
          : `${wallLabel} @ ${wall.price} снята на ${wall.dropPct.toFixed(0)}% (×${wall.multiple.toFixed(1)})`,
        wall.crossed
          ? 'Цена проходит вакуум — вход по рынку'
          : 'Вакуум открыт — вход по рынку без ожидания зоны',
        `Агрессивный поток ${flowLabel}: ${flowShare.toFixed(0)}% · OBI ${previous.obi.toFixed(0)}→${current.obi.toFixed(0)}%`,
        `SL/TP беру из ближайших стен стакана, не из ATR`,
      ],
    },
    current.mid,
    asks,
    bids
  )
}

async function fetchSnapshot(opts: {
  symbol: string
  mexcJson: <T>(path: string) => Promise<T | null>
}): Promise<OrderBookSnapshot | null> {
  const depth = await opts.mexcJson<{
    data?: { asks?: RawDepthLevel[]; bids?: RawDepthLevel[] }
  }>(`/api/v1/contract/depth/${opts.symbol}?limit=20`)
  const asks = parseLevels(depth?.data?.asks, 'ASK')
  const bids = parseLevels(depth?.data?.bids, 'BID')
  if (!asks.length || !bids.length) return null
  const mid = ((asks[0]?.price ?? 0) + (bids[0]?.price ?? 0)) / 2
  if (!(mid > 0)) return null
  return {
    symbol: opts.symbol,
    at: Date.now(),
    mid,
    asks: asks.map((level) => [level.price, level.vol]),
    bids: bids.map((level) => [level.price, level.vol]),
    obi: imbalance(asks, bids),
  }
}

export async function readOrderBookEvent(opts: {
  symbol: string
  previous?: OrderBookSnapshot | null
  older?: OrderBookSnapshot | null
  allowLiveSequence?: boolean
  /** Day bias from hotlist — MM patterns trade WITH the puppet */
  dayBias?: 'PUMP' | 'DUMP' | null
  chg24hPct?: number
  oiChangePct?: number | null
  mexcJson: <T>(path: string) => Promise<T | null>
}): Promise<OrderBookRead> {
  let current = await fetchSnapshot(opts)
  if (!current) {
    return { snapshot: null, event: emptyEvent('Стакан: нет depth данных') }
  }
  let older = opts.older ?? null
  let previous = opts.previous ?? null

  const prevAge = previous ? current.at - previous.at : Number.POSITIVE_INFINITY
  const sequenceStale = !previous || !older || prevAge > 8 * 60_000
  // Rebuild live 3-snap when KV/cache sequence is missing or stale — otherwise
  // cold cron isolates stay silent for hours waiting for a valid chain.
  if (opts.allowLiveSequence && sequenceStale) {
    older = current
    await new Promise((resolve) => setTimeout(resolve, 800))
    previous = await fetchSnapshot(opts)
    if (!previous) {
      return {
        snapshot: current,
        event: emptyEvent('Стакан: второй live-снимок недоступен'),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
    const latest = await fetchSnapshot(opts)
    if (latest) current = latest
  }

  if (!previous) {
    return {
      snapshot: current,
      event: emptyEvent('Стакан: первый снимок, жду подтверждение'),
    }
  }

  // Tape always loaded — absorption / wash need deals even without wall event.
  const dealsJson = await opts.mexcJson<{ data?: Deal[] }>(
    `/api/v1/contract/deals/${opts.symbol}?limit=100`
  )
  const deals = dealsJson?.data ?? []
  const asks = current.asks.map(([price, vol]) => ({ price, vol }))
  const bids = current.bids.map(([price, vol]) => ({ price, vol }))

  const mm = detectMmSignal({
    previous,
    current,
    deals,
    dayBias: opts.dayBias ?? null,
    chg24hPct: opts.chg24hPct ?? 0,
    oiChangePct: opts.oiChangePct ?? null,
  })
  if (mm.wash.wash) {
    return {
      snapshot: current,
      event: {
        ...emptyEvent(mm.wash.reason),
        kind: 'WASH_SKIP',
        notes: [mm.wash.reason, 'Монета пропущена — нет реального дисбаланса'],
      },
    }
  }
  // Spoof/liq are journal-dead (0% WR) but were ranked FIRST and blocked
  // classic wall-release on the same tick → silent cron for hours.
  const mmUsable =
    mm.signal &&
    mm.signal.pattern !== 'SPOOF_SWEEP' &&
    mm.signal.pattern !== 'LIQ_CASCADE'
      ? mm.signal
      : null
  if (mmUsable) {
    return {
      snapshot: current,
      event: mmToEvent(mmUsable, current.mid, asks, bids),
    }
  }
  if (mm.oiBlock && !mm.signal) {
    return {
      snapshot: current,
      event: emptyEvent(mm.oiBlock),
    }
  }

  // Fallback: classic vacuum / pressure (still LIMIT_CHASE levels).
  const classic = analyzeEvent(older, previous, current, deals)
  if (!classic.ready || !classic.side) {
    return { snapshot: current, event: classic }
  }
  // Trap flip toxic in journal — skip trap, but if this is a real release
  // (persisted wall gone) keep it; trap-only ticks fall through empty.
  if (classic.trap) {
    return {
      snapshot: current,
      event: emptyEvent(
        'Trap flip отключён — жду wall-release / absorption (не spoof)'
      ),
    }
  }
  const limit =
    classic.side === 'LONG'
      ? bids[0]?.price ?? current.mid
      : asks[0]?.price ?? current.mid
  const sl =
    classic.side === 'LONG' ? limit * 0.992 : limit * 1.008
  const tp =
    classic.side === 'LONG' ? limit * 1.02 : limit * 0.98
  const tp1 =
    classic.side === 'LONG' ? limit * 1.015 : limit * 0.985
  return {
    snapshot: current,
    event: {
      ...classic,
      entryMode: 'LIMIT_CHASE',
      wallPrice: limit,
      slPrice: sl,
      tpPrice: tp,
      tp1Price: tp1,
      notes: [...classic.notes, `Limit-chase @ ${limit}`],
    },
  }
}

/** Live exit helper for open meme paper trades. */
export function bookExitSignal(opts: {
  side: BookDirection
  bookImb: number | null
  buyShare: number
  move1mPct: number
}): { exit: boolean; reason: string } {
  const againstBook =
    opts.bookImb != null &&
    (opts.side === 'LONG' ? opts.bookImb <= -18 : opts.bookImb >= 18)
  const againstFlow =
    opts.side === 'LONG' ? opts.buyShare <= 40 : opts.buyShare >= 60
  const againstTape =
    opts.side === 'LONG' ? opts.move1mPct <= -0.45 : opts.move1mPct >= 0.45
  if (againstBook && againstFlow) {
    return {
      exit: true,
      reason: 'Стакан и поток развернулись против позиции — выхожу',
    }
  }
  if (againstBook && againstTape) {
    return {
      exit: true,
      reason: 'OBI против + 1м против — мем-импульс сломан',
    }
  }
  return { exit: false, reason: '' }
}
