/**
 * Dedicated meme order-flow reader.
 *
 * Memes are not waited in TA zones. Signals come from:
 * 1) real wall release (liquidity vacuum),
 * 2) spoof/trap wall pull + aggressive flow flip,
 * 3) persistent book pressure with tape confirmation.
 *
 * SL/TP are taken from the live book, not ATR/HTF geometry.
 */

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
    | 'CONFLICT'
    | 'NO_EVENT'
  /** MARKET = chase the impulse now; RETEST is unused for memes */
  entryMode: 'MARKET' | 'RETEST'
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
  entryMode: 'MARKET',
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

/** Nearest opposing wall used as soft TP; nearest same-side wall as SL cushion. */
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

  if (side === 'LONG') {
    const slWall = strongBids[0]?.price ?? mid * 0.988
    const tp1Wall = strongAsks[0]?.price ?? mid * 1.012
    const tpWall = strongAsks[1]?.price ?? strongAsks[0]?.price ?? mid * 1.028
    return {
      sl: Math.min(slWall, mid * 0.992),
      tp1: Math.max(tp1Wall, mid * 1.008),
      tp: Math.max(tpWall, mid * 1.018),
    }
  }

  const slWall = strongAsks[0]?.price ?? mid * 1.012
  const tp1Wall = strongBids[0]?.price ?? mid * 0.988
  const tpWall = strongBids[1]?.price ?? strongBids[0]?.price ?? mid * 0.972
  return {
    sl: Math.max(slWall, mid * 1.008),
    tp1: Math.min(tp1Wall, mid * 0.992),
    tp: Math.min(tpWall, mid * 0.982),
  }
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
    const longBook = older.obi >= 10 && previous.obi >= 10 && current.obi >= 12
    const shortBook =
      older.obi <= -10 && previous.obi <= -10 && current.obi <= -12
    if (!longBook && !shortBook) {
      return emptyEvent('Стакан: устойчивого направленного дисбаланса нет')
    }
    const side: BookDirection = longBook ? 'LONG' : 'SHORT'
    const flow = dealFlow(deals, current.at)
    const flowShare = side === 'LONG' ? flow.buyShare : 100 - flow.buyShare
    const priceMoveBps =
      ((current.mid - previous.mid) / previous.mid) * 10_000
    const priceNotAgainst =
      side === 'LONG' ? priceMoveBps >= -2 : priceMoveBps <= 2
    const bestAsk = asks[0]?.price ?? current.mid
    const bestBid = bids[0]?.price ?? current.mid
    const spreadBps = ((bestAsk - bestBid) / current.mid) * 10_000
    const flowAligned = flowShare >= 55
    const ready = flowAligned && priceNotAgainst && spreadBps <= 80
    const confidence = Math.min(
      86,
      Math.round(
        64 +
          Math.min(10, Math.abs(current.obi) * 0.25) +
          (flowAligned ? 7 : 0) +
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
  const flowAligned = flowShare >= 55
  const obiAligned = side === 'LONG' ? current.obi >= 10 : current.obi <= -10
  const priceAligned = side === 'LONG' ? priceMoveBps >= -1 : priceMoveBps <= 1
  const bestAsk = asks[0]?.price ?? current.mid
  const bestBid = bids[0]?.price ?? current.mid
  const spreadBps = ((bestAsk - bestBid) / current.mid) * 10_000
  const ready =
    wall.persisted &&
    flowAligned &&
    obiAligned &&
    priceAligned &&
    spreadBps <= 80
  const confidence = Math.min(
    90,
    Math.round(
      58 +
        Math.min(16, (wall.multiple - 3.2) * 3) +
        (flowAligned ? 7 : 0) +
        (obiAligned ? 6 : 0) +
        (priceAligned ? 5 : 0)
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
  if (age < 700 || age > 6 * 60_000) {
    return emptyEvent('Стакан: собираю новую последовательность снимков')
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
  const alignedPrice = side === 'LONG' ? priceMoveBps >= 2 : priceMoveBps <= -2
  const alignedFlow = flowShare >= 55
  const bestAsk = asks[0]?.price ?? current.mid
  const bestBid = bids[0]?.price ?? current.mid
  const spreadBps = ((bestAsk - bestBid) / current.mid) * 10_000

  // Spoof/trap: wall never persisted (appeared then yanked) or relocated nearby.
  // Enter WITH the vacuum — this is the classic meme trap flip.
  const isTrap = !wall.persisted || wall.relocated
  const trapReady =
    isTrap &&
    !wall.relocated &&
    alignedFlow &&
    (alignedPrice || alignedObi) &&
    spreadBps <= 100 &&
    wall.dropPct >= 65

  const confirmations = [alignedFlow, alignedObi, alignedPrice].filter(
    Boolean
  ).length
  const releaseReady =
    wall.persisted &&
    !wall.relocated &&
    spreadBps <= 80 &&
    alignedFlow &&
    confirmations >= 2

  const ready = trapReady || releaseReady
  const confidence = Math.min(
    96,
    Math.round(
      (isTrap ? 56 : 50) +
        Math.min(18, (wall.multiple - 3.2) * 3) +
        Math.min(10, (wall.dropPct - 60) * 0.3) +
        confirmations * 8 +
        (wall.crossed ? 5 : 0) +
        (isTrap && trapReady ? 6 : 0) -
        (wall.relocated ? 20 : 0)
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
  mexcJson: <T>(path: string) => Promise<T | null>
}): Promise<OrderBookRead> {
  let current = await fetchSnapshot(opts)
  if (!current) {
    return { snapshot: null, event: emptyEvent('Стакан: нет depth данных') }
  }
  let older = opts.older ?? null
  let previous = opts.previous ?? null

  if (opts.allowLiveSequence && (!older || !previous)) {
    if (!previous) {
      older = current
      await new Promise((resolve) => setTimeout(resolve, 800))
      previous = await fetchSnapshot(opts)
      if (!previous) {
        return {
          snapshot: current,
          event: emptyEvent('Стакан: второй live-снимок недоступен'),
        }
      }
    } else if (!older) {
      older = previous
      previous = current
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

  const preliminary = analyzeEvent(older, previous, current, [])
  if (preliminary.kind === 'NO_EVENT' || preliminary.kind === 'CONFLICT') {
    return { snapshot: current, event: preliminary }
  }

  // Always load tape for candidate events (including traps / non-persisted).
  const deals = await opts.mexcJson<{ data?: Deal[] }>(
    `/api/v1/contract/deals/${opts.symbol}?limit=100`
  )
  return {
    snapshot: current,
    event: analyzeEvent(older, previous, current, deals?.data ?? []),
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
