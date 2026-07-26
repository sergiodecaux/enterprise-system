/**
 * MEME order-flow scanner — causality lab 2026-07-26.
 *
 * Findings (1h live book/tape on hot pumps/dumps):
 * - Liquidation echo almost never fires on memes.
 * - Thin book is the trading universe (every impulse had THIN_BOOK).
 * - Wide spread → avoid market chase.
 * - PUMP + sell-tape without absorption = MM unload (do NOT chase LONG).
 * - DUMP + buy-tape = cover/accumulate into dump (do NOT reverse LONG).
 * - Edge: ABSORPTION / SPOOF_SWEEP / wall-remove WITH day bias, limit-chase.
 */

import type { ScanAlert } from './scanner'
import {
  resolveHotMemeWatchlist,
  biasForSymbol,
  type HotMemeWatchlist,
} from './hotMemeWatchlist'
import {
  readOrderBookEvent,
  type OrderBookEvent,
  type OrderBookSnapshot,
} from './orderBookReader'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v2'
const MAX_SCAN = 6
const MAX_ALERTS = 1
const MIN_CONF = 84
const MAX_SPREAD_BPS = 40
const MAX_SPREAD_BPS_STRONG = 55
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

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

interface Ticker {
  symbol: string
  lastPrice?: number | string
  riseFallRate?: number | string
  amount24?: number | string
  volume24?: number | string
  holdVol?: number | string
  bid1?: number | string
  ask1?: number | string
}

type BookState = Record<
  string,
  { previous?: OrderBookSnapshot | null; older?: OrderBookSnapshot | null }
>

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EnterpriseMemeFlow/2.0',
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function loadBookState(kv?: KvLike): Promise<BookState> {
  if (!kv) return {}
  try {
    const raw = await kv.get(BOOK_STATE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as BookState
  } catch {
    return {}
  }
}

async function saveBookState(kv: KvLike | undefined, state: BookState) {
  if (!kv) return
  // Keep only recent symbols
  const keys = Object.keys(state)
  if (keys.length > 40) {
    for (const k of keys.slice(0, keys.length - 40)) delete state[k]
  }
  try {
    await kv.put(BOOK_STATE_KEY, JSON.stringify(state))
  } catch {
    /* quota */
  }
}

function quoteVol(t: Ticker): number {
  const a = Number(t.amount24 ?? 0)
  if (a > 0) return a
  const p = Number(t.lastPrice ?? 0)
  const v = Number(t.volume24 ?? 0)
  return p > 0 && v > 0 ? p * v : 0
}

function isMmKind(kind: OrderBookEvent['kind']): boolean {
  return (
    kind.startsWith('ABSORPTION') ||
    kind.startsWith('SPOOF_SWEEP') ||
    kind.startsWith('LIQ_CASCADE') ||
    kind === 'CVD_DIVERGENCE' ||
    kind === 'ASK_WALL_REMOVED' ||
    kind === 'BID_WALL_REMOVED'
  )
}

/**
 * Lab gates: reject unload chase / dump-cover longs / wash / absurd spreads.
 */
export function allowMemeFlowEvent(
  event: OrderBookEvent,
  dayBias: 'PUMP' | 'DUMP' | null
): { ok: boolean; reason: string } {
  if (!event.ready || !event.side) {
    return { ok: false, reason: event.notes[0] || 'not_ready' }
  }
  if (event.kind === 'WASH_SKIP') {
    return { ok: false, reason: 'wash' }
  }
  if (event.confidence < MIN_CONF) {
    return { ok: false, reason: `conf<${MIN_CONF}` }
  }
  if (event.spreadBps > MAX_SPREAD_BPS_STRONG) {
    return { ok: false, reason: `spread ${event.spreadBps}bps` }
  }
  if (event.spreadBps > MAX_SPREAD_BPS && event.confidence < 90) {
    return { ok: false, reason: `wide_spread ${event.spreadBps}bps` }
  }

  const isCascade = event.kind.startsWith('LIQ_CASCADE')
  const isAbs =
    event.kind.startsWith('ABSORPTION') || event.kind === 'CVD_DIVERGENCE'
  const isSpoof = event.kind.startsWith('SPOOF_SWEEP')
  const isWall =
    event.kind === 'ASK_WALL_REMOVED' || event.kind === 'BID_WALL_REMOVED'

  if (!isMmKind(event.kind) && !isWall) {
    return { ok: false, reason: `kind ${event.kind}` }
  }

  // Trade WITH the day puppet unless cascade fade.
  if (!isCascade) {
    if (dayBias === 'PUMP' && event.side !== 'LONG') {
      return { ok: false, reason: 'against_pump_day' }
    }
    if (dayBias === 'DUMP' && event.side !== 'SHORT') {
      return { ok: false, reason: 'against_dump_day' }
    }
  }

  // Lab: PUMP + sell-tape without absorption = late unload — no chase LONG
  // Absorption LONG *requires* sell tape (being absorbed) — keep it.
  if (
    dayBias === 'PUMP' &&
    event.side === 'LONG' &&
    !isAbs &&
    !isSpoof &&
    !isWall &&
    event.flowSharePct >= 60
  ) {
    // For non-absorption, high "against" share on long path is unload risk
    return { ok: false, reason: 'pump_unload_chase' }
  }

  // Wall side must match: ASK gone → LONG, BID gone → SHORT
  if (event.kind === 'ASK_WALL_REMOVED' && event.side !== 'LONG') {
    return { ok: false, reason: 'ask_gone_not_long' }
  }
  if (event.kind === 'BID_WALL_REMOVED' && event.side !== 'SHORT') {
    return { ok: false, reason: 'bid_gone_not_short' }
  }

  if (event.trap && !isSpoof) {
    return { ok: false, reason: 'trap_disabled' }
  }

  return { ok: true, reason: 'ok' }
}

function toAlert(
  symbol: string,
  event: OrderBookEvent,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const side = event.side!
  const setup = (
    event.mmPattern ||
    (event.kind === 'ASK_WALL_REMOVED' || event.kind === 'BID_WALL_REMOVED'
      ? 'BOOK_RELEASE'
      : event.kind.replace(/_LONG$|_SHORT$/, ''))
  ).slice(0, 32)
  const limit = event.wallPrice ?? 0
  const sl = event.slPrice ?? (side === 'LONG' ? limit * 0.992 : limit * 1.008)
  const tp = event.tpPrice ?? (side === 'LONG' ? limit * 1.02 : limit * 0.98)
  const tp1 =
    event.tp1Price ?? (side === 'LONG' ? limit * 1.015 : limit * 0.985)
  const band = Math.max(limit * 0.0008, 1e-8)
  const dayTag =
    dayBias === 'PUMP' ? 'дневной памп' : dayBias === 'DUMP' ? 'дневной дамп' : 'hot'
  const name = symbol.replace('_USDT', '/USDT')

  return {
    type: 'MEME',
    title: `🦈 MEME ${side} ${name} · ${setup}`,
    text: [
      `${dayTag} ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · ${setup}`,
      `Limit-chase (maker) @ ${limit}`,
      `SL ${sl} (~0.8%) · TP1 ${tp1} · TP ${tp} (~2%)`,
      `spread ${event.spreadBps.toFixed(0)}bps · conf ${event.confidence}`,
      ...event.notes.slice(0, 4),
      'Lab: thin book · join MM · no liq-echo wait',
    ].join('\n'),
    dedupeKey: `cron:mof:${setup.toLowerCase()}:${symbol}:${side}:${Math.round(limit * 1e6)}`,
    score: event.confidence,
    winPct: Math.min(72, 52 + (event.confidence - 80)),
    style: 'SCALP',
    align: event.kind.startsWith('LIQ_CASCADE') ? 'COUNTER' : 'WITH_TREND',
    tradePlan: {
      side,
      symbol,
      setup,
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: side === 'LONG' ? limit - band : limit,
      zoneHigh: side === 'LONG' ? limit : limit + band,
      invalidate: side === 'LONG' ? limit * 1.008 : limit * 0.992,
      sl,
      tp,
      target1: tp1,
      target3: side === 'LONG' ? limit * 1.028 : limit * 0.972,
    },
  }
}

export async function runMemeOrderFlowScan(opts: {
  kv?: KvLike
  pinSymbols?: string[]
}): Promise<{
  alerts: ScanAlert[]
  watchlist: HotMemeWatchlist
  skipped: string
  scanned: number
  rejects: Array<{ symbol: string; reason: string }>
}> {
  const tickersJson = await mexcJson<{ data?: Ticker[] }>(
    '/api/v1/contract/ticker'
  )
  const tickers = (tickersJson?.data ?? []).map((t) => ({
    symbol: String(t.symbol ?? ''),
    lastPrice: t.lastPrice,
    riseFallRate: t.riseFallRate,
    amount24: t.amount24,
    volume24: t.volume24,
    holdVol: t.holdVol,
    bid1: t.bid1,
    ask1: t.ask1,
  }))
  const tradable = new Set(
    tickers.filter((t) => t.symbol.endsWith('_USDT')).map((t) => t.symbol)
  )
  const watchlist = await resolveHotMemeWatchlist(opts.kv, tickers, {
    blueChips: BLUE_CHIPS,
    tradable,
    pinSymbols: opts.pinSymbols,
  })

  if (!watchlist.entries.length) {
    return {
      alerts: [],
      watchlist,
      skipped: watchlist.reason || 'empty_hotlist',
      scanned: 0,
      rejects: [],
    }
  }

  // Prefer thinner books (lab: thin = every impulse). Cap scan count for CPU.
  const ranked = [...watchlist.entries].sort((a, b) => {
    const thinA = a.quoteVolUsd >= 200_000 && a.quoteVolUsd <= 5_000_000 ? 1 : 0
    const thinB = b.quoteVolUsd >= 200_000 && b.quoteVolUsd <= 5_000_000 ? 1 : 0
    return thinB - thinA || b.score - a.score
  })
  const batch = ranked.slice(0, MAX_SCAN)
  const state = await loadBookState(opts.kv)
  const rejects: Array<{ symbol: string; reason: string }> = []
  const alerts: ScanAlert[] = []

  for (const coin of batch) {
    const prev = state[coin.symbol]?.previous ?? null
    const older = state[coin.symbol]?.older ?? null
    const read = await readOrderBookEvent({
      symbol: coin.symbol,
      previous: prev,
      older,
      allowLiveSequence: true,
      dayBias: coin.dayBias,
      chg24hPct: coin.chg24hPct,
      mexcJson,
    })
    if (read.snapshot) {
      state[coin.symbol] = {
        older: prev,
        previous: read.snapshot,
      }
    }
    const gate = allowMemeFlowEvent(
      read.event,
      biasForSymbol(watchlist, coin.symbol)
    )
    if (!gate.ok) {
      rejects.push({ symbol: coin.symbol, reason: gate.reason })
      continue
    }
    alerts.push(
      toAlert(
        coin.symbol,
        read.event,
        coin.dayBias,
        coin.chg24hPct
      )
    )
    if (alerts.length >= MAX_ALERTS) break
  }

  await saveBookState(opts.kv, state)

  // Prefer highest confidence
  alerts.sort((a, b) => b.score - a.score)
  const top = alerts.slice(0, MAX_ALERTS)

  return {
    alerts: top,
    watchlist,
    skipped: top.length
      ? ''
      : rejects[0]?.reason
        ? `no_ready · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
        : 'no_ready_flow',
    scanned: batch.length,
    rejects: rejects.slice(0, 12),
  }
}
