/**
 * PREDATOR: LIQUIDATION ECHO
 * Wait for wave-1 liquidation flush → tape fade → post-only limit on echo.
 * Maker entry/exit · no chase · 8s fill timeout · 12s time-stop.
 */

import {
  resolvePredatorHotlist,
  type PredatorBias,
  type PredatorCoin,
  type PredatorTicker,
} from './predatorHotlist'

/** Matches scanner ScanAlert — kept local to avoid circular imports. */
export interface PredatorAlert {
  type: 'MEME'
  title: string
  text: string
  dedupeKey: string
  score: number
  winPct: number
  style: 'SCALP'
  align: 'COUNTER'
  tradePlan: {
    side: 'LONG' | 'SHORT'
    symbol: string
    setup: string
    signalPrice: number
    entryIdeal: number
    zoneLow: number
    zoneHigh: number
    invalidate: number
    sl: number
    tp: number
    target1?: number
    target3?: number
  }
}

const MEXC = 'https://contract.mexc.com'
const RISK_KEY = 'predator:risk_v1'
const BLUE_CHIPS = new Set([
  'BTC_USDT',
  'ETH_USDT',
  'BNB_USDT',
  'SOL_USDT',
  'XRP_USDT',
  'ADA_USDT',
  'AVAX_USDT',
  'LINK_USDT',
  'LTC_USDT',
  'DOT_USDT',
  'BCH_USDT',
  'NEAR_USDT',
  'ATOM_USDT',
  'UNI_USDT',
  'APT_USDT',
  'SUI_USDT',
  'TRX_USDT',
  'TON_USDT',
])

const WAVE1_QUOTE_MIN = 20_000
const WAVE1_WINDOW_MS = 3_000
const FADE_SLEEP_MS = 2_000
const FADE_RATIO = 3
const BID_WALL_MIN = 5_000
const FILL_TIMEOUT_MS = 8_000
const TIME_STOP_MS = 12_000
const TP_PCT = 0.011
const SL_PCT = 0.007
const MAX_SPREAD_PCT = 0.08

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

interface Deal {
  p?: number
  v?: number
  T?: number
  t?: number
  ts?: number
}

interface DepthLevel {
  price: number
  vol: number
}

export interface PredatorRiskState {
  equityUsd: number
  consecutiveLosses: number
  pauseUntil: number
  lastUpdatedAt: number
}

interface EchoSignal {
  symbol: string
  side: 'LONG' | 'SHORT'
  bias: PredatorBias
  limitPrice: number
  sl: number
  tp: number
  wave1Quote: number
  fadeQuote: number
  wallNotional: number
  spreadPct: number
  confidence: number
  notes: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function dealTs(d: Deal): number {
  return Number(d.t ?? d.ts ?? 0)
}

function quoteInWindow(
  deals: Deal[],
  now: number,
  windowMs: number,
  side: 'BUY' | 'SELL'
): number {
  let q = 0
  for (const d of deals) {
    const ts = dealTs(d)
    if (ts > 0 && now - ts > windowMs) continue
    const px = Number(d.p ?? 0)
    const vol = Number(d.v ?? 0)
    if (!(px > 0 && vol > 0)) continue
    if (side === 'BUY' && d.T === 1) q += px * vol
    if (side === 'SELL' && d.T === 2) q += px * vol
  }
  return q
}

function parseLevels(
  rows: Array<[number, number, number]> | undefined,
  side: 'ASK' | 'BID'
): DepthLevel[] {
  const levels = (rows ?? [])
    .slice(0, 15)
    .map((r) => ({ price: Number(r[0]), vol: Number(r[1] ?? 0) }))
    .filter((l) => l.price > 0 && l.vol > 0)
  return levels.sort((a, b) =>
    side === 'ASK' ? a.price - b.price : b.price - a.price
  )
}

async function fetchDeals(symbol: string): Promise<Deal[]> {
  const json = await mexcJson<{ data?: Deal[] }>(
    `/api/v1/contract/deals/${symbol}?limit=100`
  )
  return json?.data ?? []
}

async function fetchDepth(symbol: string): Promise<{
  mid: number
  bid: number
  ask: number
  bids: DepthLevel[]
  asks: DepthLevel[]
  spreadPct: number
} | null> {
  const json = await mexcJson<{
    data?: {
      asks?: Array<[number, number, number]>
      bids?: Array<[number, number, number]>
    }
  }>(`/api/v1/contract/depth/${symbol}?limit=20`)
  const asks = parseLevels(json?.data?.asks, 'ASK')
  const bids = parseLevels(json?.data?.bids, 'BID')
  const bid = bids[0]?.price ?? 0
  const ask = asks[0]?.price ?? 0
  if (!(bid > 0 && ask > 0)) return null
  const mid = (bid + ask) / 2
  return {
    mid,
    bid,
    ask,
    bids,
    asks,
    spreadPct: ((ask - bid) / mid) * 100,
  }
}

function nearWallNotional(
  levels: DepthLevel[],
  mid: number,
  side: 'BID' | 'ASK'
): { notional: number; price: number } {
  let best = { notional: 0, price: levels[0]?.price ?? mid }
  for (const l of levels.slice(0, 6)) {
    const dist = Math.abs(l.price - mid) / mid
    if (dist > 0.004) continue
    const n = l.price * l.vol
    if (n > best.notional) best = { notional: n, price: l.price }
  }
  return best
}

export async function loadPredatorRisk(
  kv?: KvLike
): Promise<PredatorRiskState> {
  const fallback: PredatorRiskState = {
    equityUsd: 50,
    consecutiveLosses: 0,
    pauseUntil: 0,
    lastUpdatedAt: Date.now(),
  }
  if (!kv) return fallback
  try {
    const raw = await kv.get(RISK_KEY)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as PredatorRiskState) }
  } catch {
    return fallback
  }
}

export async function savePredatorRisk(
  kv: KvLike | undefined,
  state: PredatorRiskState
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(RISK_KEY, JSON.stringify(state))
  } catch {
    /* quota */
  }
}

/** Margin = 10% equity; halved after 2 losses. Position notional = margin * 10. */
export function predatorPositionSizing(risk: PredatorRiskState): {
  marginUsd: number
  notionalUsd: number
  paused: boolean
  reason: string
} {
  const now = Date.now()
  if (risk.pauseUntil > now) {
    return {
      marginUsd: 0,
      notionalUsd: 0,
      paused: true,
      reason: `Circuit breaker: пауза до ${new Date(risk.pauseUntil).toISOString()}`,
    }
  }
  let unit = Math.max(2, risk.equityUsd * 0.1)
  if (risk.consecutiveLosses >= 2) unit *= 0.5
  return {
    marginUsd: Number(unit.toFixed(2)),
    notionalUsd: Number((unit * 10).toFixed(2)),
    paused: false,
    reason: `Unit 10% equity=$${risk.equityUsd.toFixed(0)} → margin $${unit.toFixed(2)} (10x)`,
  }
}

export function applyPredatorOutcome(
  risk: PredatorRiskState,
  pnlUsd: number,
  isLoss: boolean
): PredatorRiskState {
  const equityUsd = Math.max(2, risk.equityUsd + pnlUsd)
  let consecutiveLosses = isLoss ? risk.consecutiveLosses + 1 : 0
  let pauseUntil = risk.pauseUntil
  if (consecutiveLosses >= 3) {
    pauseUntil = Date.now() + 3 * 60 * 60_000
    consecutiveLosses = 0
  }
  return {
    equityUsd,
    consecutiveLosses,
    pauseUntil,
    lastUpdatedAt: Date.now(),
  }
}

async function detectEchoOnCoin(
  coin: PredatorCoin
): Promise<EchoSignal | null> {
  const depth = await fetchDepth(coin.symbol)
  if (!depth || depth.spreadPct > MAX_SPREAD_PCT) return null

  const now = Date.now()
  const deals1 = await fetchDeals(coin.symbol)

  const longEcho = coin.bias === 'LONG_ECHO'
  const waveSide = longEcho ? 'SELL' : 'BUY'
  const wave1 = quoteInWindow(deals1, now, WAVE1_WINDOW_MS, waveSide)
  if (wave1 < WAVE1_QUOTE_MIN) return null

  // Wave 1 dump/rip vs mid — approximate -1.5%..-2.5% flush via recent deal extremes
  const recentPx = deals1
    .filter((d) => {
      const ts = dealTs(d)
      return !(ts > 0) || now - ts <= 8_000
    })
    .map((d) => Number(d.p ?? 0))
    .filter((p) => p > 0)
  if (recentPx.length < 3) return null
  const extreme = longEcho ? Math.min(...recentPx) : Math.max(...recentPx)
  const flushPct = ((extreme - depth.mid) / depth.mid) * 100
  if (longEcho && flushPct > -1.2) return null
  if (!longEcho && flushPct < 1.2) return null

  // Wait for fade (2s)
  await sleep(FADE_SLEEP_MS)
  const deals2 = await fetchDeals(coin.symbol)
  const now2 = Date.now()
  const fadeVol = quoteInWindow(deals2, now2, 2_000, waveSide)
  if (fadeVol > wave1 / FADE_RATIO) return null

  const depth2 = await fetchDepth(coin.symbol)
  if (!depth2 || depth2.spreadPct > MAX_SPREAD_PCT) return null

  const wall = longEcho
    ? nearWallNotional(depth2.bids, depth2.mid, 'BID')
    : nearWallNotional(depth2.asks, depth2.mid, 'ASK')
  if (wall.notional < BID_WALL_MIN) return null

  const side: 'LONG' | 'SHORT' = longEcho ? 'LONG' : 'SHORT'
  // Post-only at best bid (long) / best ask (short) — or 1 tick into wall
  const limitPrice = longEcho
    ? Math.max(depth2.bid, wall.price)
    : Math.min(depth2.ask, wall.price)
  const sl = longEcho ? limitPrice * (1 - SL_PCT) : limitPrice * (1 + SL_PCT)
  const tp = longEcho ? limitPrice * (1 + TP_PCT) : limitPrice * (1 - TP_PCT)

  // Strict fill timeout: poll 8s — paper fill if last trades at/through limit
  let filled = false
  const fillDeadline = Date.now() + FILL_TIMEOUT_MS
  while (Date.now() < fillDeadline) {
    await sleep(1000)
    const tick = await mexcJson<{
      data?: { lastPrice?: number; fairPrice?: number }
    }>(`/api/v1/contract/ticker/${coin.symbol}`)
    const last = Number(
      tick?.data?.lastPrice ?? tick?.data?.fairPrice ?? 0
    )
    if (!(last > 0)) continue
    if (longEcho && last <= limitPrice * 1.0015) {
      filled = true
      break
    }
    if (!longEcho && last >= limitPrice * 0.9985) {
      filled = true
      break
    }
  }
  if (!filled) return null

  const conf = Math.min(
    96,
    Math.round(
      82 +
        Math.min(8, wave1 / 20_000) +
        (wall.notional >= 10_000 ? 4 : 0) +
        (fadeVol < wave1 / 4 ? 2 : 0)
    )
  )

  return {
    symbol: coin.symbol,
    side,
    bias: coin.bias,
    limitPrice,
    sl,
    tp,
    wave1Quote: wave1,
    fadeQuote: fadeVol,
    wallNotional: wall.notional,
    spreadPct: depth2.spreadPct,
    confidence: conf,
    notes: [
      `PREDATOR Liquidation Echo · ${side}`,
      `Wave1 ${waveSide} $${(wave1 / 1000).toFixed(1)}k / 3s → fade $${(fadeVol / 1000).toFixed(1)}k`,
      `Заслонка $${(wall.notional / 1000).toFixed(1)}k · spread ${depth2.spreadPct.toFixed(3)}%`,
      `Post-Only @ ${limitPrice} · TP +${(TP_PCT * 100).toFixed(1)}% · SL −${(SL_PCT * 100).toFixed(1)}%`,
      `Fill timeout 8s ok · time-stop 12s maker exit`,
    ],
  }
}

function toScanAlert(
  sig: EchoSignal,
  sizing: { marginUsd: number; notionalUsd: number; reason: string }
): PredatorAlert {
  const band = sig.limitPrice * 0.0005
  const name = sig.symbol.replace('_USDT', '/USDT')
  return {
    type: 'MEME',
    title: `🦈 PREDATOR ${sig.side} ${name}`,
    text: [
      ...sig.notes,
      sizing.reason,
      `Маржа ~$${sizing.marginUsd} · нотионал ~$${sizing.notionalUsd} (10x)`,
    ].join('\n'),
    dedupeKey: `predator:echo:${sig.symbol}:${sig.side}:${Math.round(sig.limitPrice * 1e8)}`,
    score: sig.confidence,
    winPct: Math.min(72, 55 + (sig.confidence - 80)),
    style: 'SCALP',
    align: 'COUNTER',
    tradePlan: {
      side: sig.side,
      symbol: sig.symbol,
      setup: 'LIQUIDATION_ECHO',
      signalPrice: sig.limitPrice,
      entryIdeal: sig.limitPrice,
      zoneLow: sig.limitPrice - band,
      zoneHigh: sig.limitPrice + band,
      invalidate:
        sig.side === 'LONG'
          ? sig.limitPrice * 1.008
          : sig.limitPrice * 0.992,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp,
      target3:
        sig.side === 'LONG'
          ? sig.limitPrice * 1.013
          : sig.limitPrice * 0.987,
    },
  }
}

/**
 * Full predator cycle: hotlist → echo detection (with sleeps) → ≤1 alert.
 */
export async function runLiquidationEchoScan(opts: {
  kv?: KvLike
  pinSymbols?: string[]
}): Promise<{
  alerts: PredatorAlert[]
  hotlist: Awaited<ReturnType<typeof resolvePredatorHotlist>>
  risk: PredatorRiskState
  skipped: string
}> {
  const tickersJson = await mexcJson<{ data?: PredatorTicker[] }>(
    '/api/v1/contract/ticker'
  )
  const tickers = (tickersJson?.data ?? []).map((r) => ({
    symbol: String(r.symbol ?? ''),
    lastPrice: r.lastPrice,
    riseFallRate: r.riseFallRate,
    amount24: r.amount24,
    volume24: r.volume24,
    holdVol: r.holdVol,
    bid1: r.bid1,
    ask1: r.ask1,
  }))

  const tradable = new Set(
    tickers.filter((t) => t.symbol.endsWith('_USDT')).map((t) => t.symbol)
  )
  const hotlist = await resolvePredatorHotlist(opts.kv, tickers, {
    blueChips: BLUE_CHIPS,
    tradable,
    pinSymbols: opts.pinSymbols,
  })
  const risk = await loadPredatorRisk(opts.kv)
  const sizing = predatorPositionSizing(risk)
  if (sizing.paused) {
    return {
      alerts: [],
      hotlist,
      risk,
      skipped: sizing.reason,
    }
  }
  if (!hotlist.entries.length) {
    return {
      alerts: [],
      hotlist,
      risk,
      skipped: hotlist.reason,
    }
  }

  // Scan coins sequentially — wave detection needs sleeps; max 5.
  for (const coin of hotlist.entries) {
    try {
      const sig = await detectEchoOnCoin(coin)
      if (!sig || sig.confidence < 84) continue
      return {
        alerts: [toScanAlert(sig, sizing)],
        hotlist,
        risk,
        skipped: '',
      }
    } catch (err) {
      console.error('[predator] coin failed', coin.symbol, err)
    }
  }

  return {
    alerts: [],
    hotlist,
    risk,
    skipped: 'нет эха ликвидаций на hotlist',
  }
}

/** Time-stop helper for open LIQUIDATION_ECHO papers (<12s impulse). */
export function predatorTimeStopDue(
  openedAt: number | null,
  now = Date.now()
): boolean {
  if (!openedAt) return false
  return now - openedAt >= TIME_STOP_MS
}

export const PREDATOR_CONST = {
  TP_PCT,
  SL_PCT,
  FILL_TIMEOUT_MS,
  TIME_STOP_MS,
} as const
