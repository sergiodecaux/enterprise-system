/**
 * Market-maker manipulation patterns for thin meme books ($200k–$1M).
 * Goal: join the MM move, not fade the spoof wall.
 */

export type MmSide = 'LONG' | 'SHORT'

export type MmPattern =
  | 'ABSORPTION'
  | 'SPOOF_SWEEP'
  | 'LIQ_CASCADE'
  | 'CVD_DIVERGENCE'

export interface MmDeal {
  p?: number
  v?: number
  /** 1 = taker buy, 2 = taker sell (MEXC) */
  T?: number
  t?: number
  ts?: number
}

export interface MmBookSnap {
  at: number
  mid: number
  asks: Array<[number, number]>
  bids: Array<[number, number]>
}

export interface MmSignal {
  ready: boolean
  side: MmSide
  pattern: MmPattern
  confidence: number
  /** Post-only limit at best bid (LONG) / best ask (SHORT) */
  limitPrice: number
  slPrice: number
  tpPrice: number
  tp1Price: number
  absorptionIndex: number
  cvd: number
  sellQuote30s: number
  buyQuote30s: number
  priceMoveBps: number
  bidDepthDropPct: number
  askDepthDropPct: number
  wallMultiple: number
  notes: string[]
}

export interface WashResult {
  wash: boolean
  sameSizeShare: number
  insideSpreadShare: number
  reason: string
}

const TAPE_MS = 45_000
const SL_PCT = 0.008
const TP_PCT = 0.02
const TP1_PCT = 0.015

function dealTs(d: MmDeal): number {
  return Number(d.t ?? d.ts ?? 0)
}

function depthNotional(levels: Array<[number, number]>, n = 10): number {
  return levels
    .slice(0, n)
    .reduce((sum, [p, v]) => sum + Number(p) * Number(v), 0)
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function stdev(values: number[]): number {
  if (values.length < 3) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const varSum =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(varSum)
}

function tapeWindow(deals: MmDeal[], now: number, windowMs = TAPE_MS): MmDeal[] {
  return deals.filter((d) => {
    const ts = dealTs(d)
    if (!(ts > 0)) return true
    return now - ts <= windowMs
  })
}

function quoteFlow(
  deals: MmDeal[],
  now: number
): { buyQ: number; sellQ: number; cvd: number; buyShare: number } {
  let buyQ = 0
  let sellQ = 0
  for (const d of tapeWindow(deals, now)) {
    const px = Number(d.p ?? 0)
    const vol = Number(d.v ?? 0)
    if (!(px > 0 && vol > 0)) continue
    const q = px * vol
    if (d.T === 1) buyQ += q
    else if (d.T === 2) sellQ += q
  }
  const total = buyQ + sellQ
  return {
    buyQ,
    sellQ,
    cvd: buyQ - sellQ,
    buyShare: total > 0 ? (buyQ / total) * 100 : 50,
  }
}

/** Wash / circular volume: same size buckets + inside-spread prints. */
export function detectWashTrading(
  deals: MmDeal[],
  mid: number,
  bestBid: number,
  bestAsk: number,
  now = Date.now()
): WashResult {
  const rows = tapeWindow(deals, now, 90_000)
    .map((d) => ({
      v: Number(d.v ?? 0),
      p: Number(d.p ?? 0),
      ts: dealTs(d),
    }))
    .filter((d) => d.v > 0 && d.p > 0)
  if (rows.length < 18) {
    return {
      wash: false,
      sameSizeShare: 0,
      insideSpreadShare: 0,
      reason: 'мало сделок для wash-фильтра',
    }
  }

  // Bucket sizes to 2 significant digits
  const buckets = new Map<string, number>()
  for (const r of rows) {
    const key = r.v.toPrecision(2)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const topBucket = Math.max(...buckets.values())
  const sameSizeShare = topBucket / rows.length

  const spread = Math.max(0, bestAsk - bestBid)
  const inside =
    spread > 0
      ? rows.filter((r) => r.p > bestBid && r.p < bestAsk).length / rows.length
      : 0

  const sizes = rows.map((r) => r.v)
  const cv = mid > 0 ? stdev(sizes) / (median(sizes) || 1) : 1

  // Regular micro-intervals
  const ts = rows.map((r) => r.ts).filter((t) => t > 0).sort((a, b) => a - b)
  let regular = 0
  if (ts.length >= 10) {
    const gaps: number[] = []
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!)
    const medGap = median(gaps)
    if (medGap > 0 && medGap < 400) {
      regular =
        gaps.filter((g) => Math.abs(g - medGap) / medGap < 0.35).length /
        gaps.length
    }
  }

  const wash =
    (sameSizeShare >= 0.8 && cv < 0.25) ||
    (sameSizeShare >= 0.7 && inside >= 0.35) ||
    (regular >= 0.7 && sameSizeShare >= 0.55)

  return {
    wash,
    sameSizeShare: Number((sameSizeShare * 100).toFixed(1)),
    insideSpreadShare: Number((inside * 100).toFixed(1)),
    reason: wash
      ? `Wash/крутилка: ${((sameSizeShare) * 100).toFixed(0)}% одинаковый размер, inside-spread ${((inside) * 100).toFixed(0)}%`
      : 'лента живая',
  }
}

function scalpLevels(side: MmSide, limit: number): {
  sl: number
  tp: number
  tp1: number
} {
  if (side === 'LONG') {
    return {
      sl: limit * (1 - SL_PCT),
      tp1: limit * (1 + TP1_PCT),
      tp: limit * (1 + TP_PCT),
    }
  }
  return {
    sl: limit * (1 + SL_PCT),
    tp1: limit * (1 - TP1_PCT),
    tp: limit * (1 - TP_PCT),
  }
}

function bestBidAsk(snap: MmBookSnap): { bid: number; ask: number } {
  const bid = snap.bids[0]?.[0] ?? snap.mid * 0.999
  const ask = snap.asks[0]?.[0] ?? snap.mid * 1.001
  return { bid, ask }
}

/**
 * Pattern 1 + CVD: aggressive sell (buy) tape absorbed — price barely moves.
 */
function detectAbsorption(
  previous: MmBookSnap,
  current: MmBookSnap,
  deals: MmDeal[],
  dayBias: 'PUMP' | 'DUMP' | null
): MmSignal | null {
  const flow = quoteFlow(deals, current.at)
  const priceMoveBps =
    ((current.mid - previous.mid) / Math.max(previous.mid, 1e-12)) * 10_000
  const absMove = Math.abs(priceMoveBps)

  // LONG absorption: heavy sells, price flat/up
  // Threshold eased: lab monitor saw 0 ABS hits @ $12k/30s on thin memes.
  const sellAbs =
    flow.sellQ >= 7_000 &&
    absMove <= 12 &&
    priceMoveBps >= -8 &&
    flow.sellQ > flow.buyQ * 1.15
  // SHORT absorption: heavy buys, price flat/down
  const buyAbs =
    flow.buyQ >= 7_000 &&
    absMove <= 12 &&
    priceMoveBps <= 8 &&
    flow.buyQ > flow.sellQ * 1.15

  const absorptionIndex =
    absMove < 0.5
      ? Math.max(flow.sellQ, flow.buyQ) / 0.5
      : Math.max(flow.sellQ, flow.buyQ) / absMove

  if (sellAbs && dayBias !== 'DUMP') {
    const { bid } = bestBidAsk(current)
    const levels = scalpLevels('LONG', bid)
    const conf = Math.min(
      96,
      Math.round(78 + Math.min(14, absorptionIndex / 8000) + (priceMoveBps >= 0 ? 4 : 0))
    )
    return {
      ready: conf >= 82 && absorptionIndex >= 1600,
      side: 'LONG',
      pattern: absMove <= 5 ? 'ABSORPTION' : 'CVD_DIVERGENCE',
      confidence: conf,
      limitPrice: bid,
      ...levels,
      slPrice: levels.sl,
      tpPrice: levels.tp,
      tp1Price: levels.tp1,
      absorptionIndex: Number(absorptionIndex.toFixed(0)),
      cvd: Number(flow.cvd.toFixed(0)),
      sellQuote30s: Number(flow.sellQ.toFixed(0)),
      buyQuote30s: Number(flow.buyQ.toFixed(0)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      bidDepthDropPct: 0,
      askDepthDropPct: 0,
      wallMultiple: 0,
      notes: [
        `Поглощение LONG: sell tape $${(flow.sellQ / 1000).toFixed(1)}k, цена ${priceMoveBps.toFixed(1)} bps`,
        `Absorption Index ${absorptionIndex.toFixed(0)} · CVD ${flow.cvd.toFixed(0)}`,
        `Limit-chase @ Best Bid ${bid}`,
      ],
    }
  }

  if (buyAbs && dayBias !== 'PUMP') {
    const { ask } = bestBidAsk(current)
    const levels = scalpLevels('SHORT', ask)
    const conf = Math.min(
      96,
      Math.round(78 + Math.min(14, absorptionIndex / 8000) + (priceMoveBps <= 0 ? 4 : 0))
    )
    return {
      ready: conf >= 82 && absorptionIndex >= 1600,
      side: 'SHORT',
      pattern: absMove <= 5 ? 'ABSORPTION' : 'CVD_DIVERGENCE',
      confidence: conf,
      limitPrice: ask,
      ...levels,
      slPrice: levels.sl,
      tpPrice: levels.tp,
      tp1Price: levels.tp1,
      absorptionIndex: Number(absorptionIndex.toFixed(0)),
      cvd: Number(flow.cvd.toFixed(0)),
      sellQuote30s: Number(flow.sellQ.toFixed(0)),
      buyQuote30s: Number(flow.buyQ.toFixed(0)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      bidDepthDropPct: 0,
      askDepthDropPct: 0,
      wallMultiple: 0,
      notes: [
        `Поглощение SHORT: buy tape $${(flow.buyQ / 1000).toFixed(1)}k, цена ${priceMoveBps.toFixed(1)} bps`,
        `Absorption Index ${absorptionIndex.toFixed(0)} · CVD ${flow.cvd.toFixed(0)}`,
        `Limit-chase @ Best Ask ${ask}`,
      ],
    }
  }

  return null
}

/**
 * Pattern 2: spoof wall (5–10×) triggers panic tape, then cancels unfilled → fade the spoof.
 */
function detectSpoofSweep(
  previous: MmBookSnap,
  current: MmBookSnap,
  deals: MmDeal[],
  dayBias: 'PUMP' | 'DUMP' | null
): MmSignal | null {
  const prevAsks = previous.asks.map(([p, v]) => ({ p, v }))
  const prevBids = previous.bids.map(([p, v]) => ({ p, v }))
  const curAsks = current.asks.map(([p, v]) => ({ p, v }))
  const curBids = current.bids.map(([p, v]) => ({ p, v }))
  const medAsk = median(prevAsks.map((l) => l.v)) || 1
  const medBid = median(prevBids.map((l) => l.v)) || 1

  const flow = quoteFlow(deals, current.at)
  const priceMoveBps =
    ((current.mid - previous.mid) / Math.max(previous.mid, 1e-12)) * 10_000

  // Spoof ASK (scare sellers) → cancel → LONG
  let bestAskSpoof: { price: number; multiple: number; drop: number } | null =
    null
  for (const before of prevAsks) {
    if (before.p < previous.mid) continue
    if ((before.p - previous.mid) / previous.mid > 0.012) continue
    const multiple = before.v / medAsk
    if (multiple < 5) continue
    const still = curAsks.find(
      (l) => Math.abs(l.p - before.p) / current.mid < 0.0004
    )
    const rem = still?.v ?? 0
    const drop = (before.v - rem) / before.v
    if (drop < 0.7) continue
    // Not swept: mid never traded through the wall
    const crossed = current.mid >= before.p * 0.9995
    if (crossed) continue
    if (!bestAskSpoof || multiple > bestAskSpoof.multiple) {
      bestAskSpoof = { price: before.p, multiple, drop }
    }
  }

  if (
    bestAskSpoof &&
    flow.sellQ >= 8_000 &&
    dayBias !== 'DUMP' &&
    priceMoveBps > -15
  ) {
    const { bid } = bestBidAsk(current)
    const levels = scalpLevels('LONG', bid)
    return {
      ready: true,
      side: 'LONG',
      pattern: 'SPOOF_SWEEP',
      confidence: Math.min(95, Math.round(82 + Math.min(12, bestAskSpoof.multiple))),
      limitPrice: bid,
      slPrice: levels.sl,
      tpPrice: levels.tp,
      tp1Price: levels.tp1,
      absorptionIndex: 0,
      cvd: Number(flow.cvd.toFixed(0)),
      sellQuote30s: Number(flow.sellQ.toFixed(0)),
      buyQuote30s: Number(flow.buyQ.toFixed(0)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      bidDepthDropPct: 0,
      askDepthDropPct: Number((bestAskSpoof.drop * 100).toFixed(1)),
      wallMultiple: Number(bestAskSpoof.multiple.toFixed(2)),
      notes: [
        `Spoof-and-sweep LONG: ASK-стена ×${bestAskSpoof.multiple.toFixed(1)} снята ${(bestAskSpoof.drop * 100).toFixed(0)}% без прохода цены`,
        `Паника в ленте: sell $${(flow.sellQ / 1000).toFixed(1)}k — ММ собрал лимитом`,
        `Limit-chase @ Best Bid ${bid}`,
      ],
    }
  }

  // Spoof BID (fake support) → cancel → SHORT
  let bestBidSpoof: { price: number; multiple: number; drop: number } | null =
    null
  for (const before of prevBids) {
    if (before.p > previous.mid) continue
    if ((previous.mid - before.p) / previous.mid > 0.012) continue
    const multiple = before.v / medBid
    if (multiple < 5) continue
    const still = curBids.find(
      (l) => Math.abs(l.p - before.p) / current.mid < 0.0004
    )
    const rem = still?.v ?? 0
    const drop = (before.v - rem) / before.v
    if (drop < 0.7) continue
    const crossed = current.mid <= before.p * 1.0005
    if (crossed) continue
    if (!bestBidSpoof || multiple > bestBidSpoof.multiple) {
      bestBidSpoof = { price: before.p, multiple, drop }
    }
  }

  if (
    bestBidSpoof &&
    flow.buyQ >= 8_000 &&
    dayBias !== 'PUMP' &&
    priceMoveBps < 15
  ) {
    const { ask } = bestBidAsk(current)
    const levels = scalpLevels('SHORT', ask)
    return {
      ready: true,
      side: 'SHORT',
      pattern: 'SPOOF_SWEEP',
      confidence: Math.min(95, Math.round(82 + Math.min(12, bestBidSpoof.multiple))),
      limitPrice: ask,
      slPrice: levels.sl,
      tpPrice: levels.tp,
      tp1Price: levels.tp1,
      absorptionIndex: 0,
      cvd: Number(flow.cvd.toFixed(0)),
      sellQuote30s: Number(flow.sellQ.toFixed(0)),
      buyQuote30s: Number(flow.buyQ.toFixed(0)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      bidDepthDropPct: Number((bestBidSpoof.drop * 100).toFixed(1)),
      askDepthDropPct: 0,
      wallMultiple: Number(bestBidSpoof.multiple.toFixed(2)),
      notes: [
        `Spoof-and-sweep SHORT: BID-стена ×${bestBidSpoof.multiple.toFixed(1)} снята без прохода`,
        `Ложный спрос собран — Limit-chase @ Best Ask ${ask}`,
      ],
    }
  }

  return null
}

/**
 * Pattern 4: bid vacuum under pumped coin + micro sell impulse → cascade SHORT.
 */
function detectLiqCascade(
  previous: MmBookSnap,
  current: MmBookSnap,
  deals: MmDeal[],
  chg24hPct: number,
  dayBias: 'PUMP' | 'DUMP' | null
): MmSignal | null {
  const prevBidDepth = depthNotional(previous.bids, 12)
  const curBidDepth = depthNotional(current.bids, 12)
  const prevAskDepth = depthNotional(previous.asks, 12)
  const curAskDepth = depthNotional(current.asks, 12)
  const bidDrop =
    prevBidDepth > 0 ? ((prevBidDepth - curBidDepth) / prevBidDepth) * 100 : 0
  const askDrop =
    prevAskDepth > 0 ? ((prevAskDepth - curAskDepth) / prevAskDepth) * 100 : 0

  const flow = quoteFlow(deals, current.at)
  const priceMoveBps =
    ((current.mid - previous.mid) / Math.max(previous.mid, 1e-12)) * 10_000

  // SHORT cascade on pumped coin
  if (
    (chg24hPct >= 18 || dayBias === 'PUMP') &&
    bidDrop >= 55 &&
    flow.sellQ >= 6_000 &&
    flow.sellQ > flow.buyQ &&
    priceMoveBps <= 2
  ) {
    const { ask } = bestBidAsk(current)
    const levels = scalpLevels('SHORT', ask)
    return {
      ready: true,
      side: 'SHORT',
      pattern: 'LIQ_CASCADE',
      confidence: Math.min(96, Math.round(80 + Math.min(14, bidDrop / 6))),
      limitPrice: ask,
      slPrice: levels.sl,
      tpPrice: levels.tp,
      tp1Price: levels.tp1,
      absorptionIndex: 0,
      cvd: Number(flow.cvd.toFixed(0)),
      sellQuote30s: Number(flow.sellQ.toFixed(0)),
      buyQuote30s: Number(flow.buyQ.toFixed(0)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      bidDepthDropPct: Number(bidDrop.toFixed(1)),
      askDepthDropPct: Number(askDrop.toFixed(1)),
      wallMultiple: 0,
      notes: [
        `Каскад SHORT: биды просели −${bidDrop.toFixed(0)}% при дневном +${chg24hPct.toFixed(0)}%`,
        `Микро-sell $${(flow.sellQ / 1000).toFixed(1)}k — вакуум под лоями`,
        `Limit-chase @ Best Ask ${ask} · TP ~2% / SL ~0.8%`,
      ],
    }
  }

  // LONG cascade on dumped coin (ask vacuum)
  if (
    (chg24hPct <= -18 || dayBias === 'DUMP') &&
    askDrop >= 55 &&
    flow.buyQ >= 6_000 &&
    flow.buyQ > flow.sellQ &&
    priceMoveBps >= -2
  ) {
    const { bid } = bestBidAsk(current)
    const levels = scalpLevels('LONG', bid)
    return {
      ready: true,
      side: 'LONG',
      pattern: 'LIQ_CASCADE',
      confidence: Math.min(96, Math.round(80 + Math.min(14, askDrop / 6))),
      limitPrice: bid,
      slPrice: levels.sl,
      tpPrice: levels.tp,
      tp1Price: levels.tp1,
      absorptionIndex: 0,
      cvd: Number(flow.cvd.toFixed(0)),
      sellQuote30s: Number(flow.sellQ.toFixed(0)),
      buyQuote30s: Number(flow.buyQ.toFixed(0)),
      priceMoveBps: Number(priceMoveBps.toFixed(1)),
      bidDepthDropPct: Number(bidDrop.toFixed(1)),
      askDepthDropPct: Number(askDrop.toFixed(1)),
      wallMultiple: 0,
      notes: [
        `Каскад LONG: аски просели −${askDrop.toFixed(0)}% при дневном ${chg24hPct.toFixed(0)}%`,
        `Limit-chase @ Best Bid ${bid}`,
      ],
    }
  }

  return null
}

/**
 * OI velocity gate (cron ≈ 2m sample — best available in Worker).
 * LONG blocked when price↑ + OI↓ (MM unload / short squeeze exit).
 */
export function oiVelocityGate(
  side: MmSide,
  priceMoveBps: number,
  oiChangePct: number | null
): { allow: boolean; reason: string } {
  if (oiChangePct == null) {
    return { allow: true, reason: 'OI velocity: нет ряда — мягкий пропуск' }
  }
  if (side === 'LONG') {
    if (priceMoveBps > 5 && oiChangePct < -1.2) {
      return {
        allow: false,
        reason: `OI↓ ${oiChangePct.toFixed(1)}% при цене↑ — разгрузка ММ, лонг запрещён`,
      }
    }
    if (priceMoveBps < -8 && oiChangePct < -2) {
      return {
        allow: false,
        reason: `OI↓ на ноже — жду стабилизации перед лонгом`,
      }
    }
  }
  if (side === 'SHORT') {
    if (priceMoveBps < -5 && oiChangePct < -1.2) {
      return {
        allow: false,
        reason: `OI↓ на дампе — каскад уже отыгран, шорт поздно`,
      }
    }
  }
  return {
    allow: true,
    reason:
      priceMoveBps > 0 && oiChangePct > 0.5 && side === 'LONG'
        ? `OI↑ ${oiChangePct.toFixed(1)}% + цена↑ — живые лонги`
        : `OI velocity ok (${oiChangePct.toFixed(1)}%)`,
  }
}

export function detectMmSignal(opts: {
  previous: MmBookSnap
  current: MmBookSnap
  deals: MmDeal[]
  dayBias: 'PUMP' | 'DUMP' | null
  chg24hPct: number
  oiChangePct?: number | null
}): { wash: WashResult; signal: MmSignal | null; oiBlock: string | null } {
  const { bid, ask } = bestBidAsk(opts.current)
  const wash = detectWashTrading(
    opts.deals,
    opts.current.mid,
    bid,
    ask,
    opts.current.at
  )
  if (wash.wash) {
    return { wash, signal: null, oiBlock: null }
  }

  const ranked = [
    detectSpoofSweep(opts.previous, opts.current, opts.deals, opts.dayBias),
    detectAbsorption(opts.previous, opts.current, opts.deals, opts.dayBias),
    detectLiqCascade(
      opts.previous,
      opts.current,
      opts.deals,
      opts.chg24hPct,
      opts.dayBias
    ),
  ]
    .filter((s): s is MmSignal => Boolean(s?.ready))
    .sort((a, b) => b.confidence - a.confidence)

  const best = ranked[0] ?? null
  if (!best) return { wash, signal: null, oiBlock: null }

  const oi = oiVelocityGate(
    best.side,
    best.priceMoveBps,
    opts.oiChangePct ?? null
  )
  if (!oi.allow) {
    return { wash, signal: null, oiBlock: oi.reason }
  }
  best.notes = [...best.notes, oi.reason]
  return { wash, signal: best, oiBlock: null }
}
