/**
 * MEME order-flow scanner v25 — journal invert rewrite 2026-07-28.
 *
 * Live journal (~51 W/L): WR~22%, MFE≈0 on most losses, invert → WR~78%.
 * Changes vs v24:
 * - INVERT_SIDE: fade the MM pattern (trade opposite of detected side)
 * - Kill LIQ_CASCADE + SPOOF_SWEEP (0% edge / instant SL)
 * - Keep ABSORPTION / CVD / wall-release only
 * - Wider SL ~1.8% · TP ~2.8% (was 0.8/2 — instant stops on meme spread)
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
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v25'
const MAX_SCAN = 6
const MAX_ALERTS = 1
const MIN_CONF = 84
const MAX_SPREAD_BPS = 40
const MAX_SPREAD_BPS_STRONG = 55

/** Journal: follow-signal lost → fade it */
const INVERT_SIDE = true
const SL_PCT = 0.018
const TP_PCT = 0.028
const TP1_PCT = 0.018
const TP3_PCT = 0.035

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
        'User-Agent': 'EnterpriseMemeFlow/2.5',
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

function isAllowedKind(kind: OrderBookEvent['kind']): boolean {
  // Journal: LIQ_CASCADE 0/6 instant SL · SPOOF 0 wins → kill
  if (kind.startsWith('LIQ_CASCADE')) return false
  if (kind.startsWith('SPOOF_SWEEP')) return false
  return (
    kind.startsWith('ABSORPTION') ||
    kind === 'CVD_DIVERGENCE' ||
    kind === 'ASK_WALL_REMOVED' ||
    kind === 'BID_WALL_REMOVED'
  )
}

/**
 * Gate the *detected* pattern (pre-invert). We still require day-aligned
 * "join" signals — then invert them into fades.
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

  if (!isAllowedKind(event.kind)) {
    return { ok: false, reason: `killed ${event.kind}` }
  }

  const isAbs =
    event.kind.startsWith('ABSORPTION') || event.kind === 'CVD_DIVERGENCE'
  const isWall =
    event.kind === 'ASK_WALL_REMOVED' || event.kind === 'BID_WALL_REMOVED'

  // Detect WITH day bias (the pattern that historically lost when followed)
  if (dayBias === 'PUMP' && event.side !== 'LONG') {
    return { ok: false, reason: 'against_pump_day' }
  }
  if (dayBias === 'DUMP' && event.side !== 'SHORT') {
    return { ok: false, reason: 'against_dump_day' }
  }

  if (
    dayBias === 'PUMP' &&
    event.side === 'LONG' &&
    !isAbs &&
    !isWall &&
    event.flowSharePct >= 60
  ) {
    return { ok: false, reason: 'pump_unload_chase' }
  }

  if (event.kind === 'ASK_WALL_REMOVED' && event.side !== 'LONG') {
    return { ok: false, reason: 'ask_gone_not_long' }
  }
  if (event.kind === 'BID_WALL_REMOVED' && event.side !== 'SHORT') {
    return { ok: false, reason: 'bid_gone_not_short' }
  }

  if (event.trap) {
    return { ok: false, reason: 'trap_disabled' }
  }

  return { ok: true, reason: 'ok' }
}

function levelsForSide(side: 'LONG' | 'SHORT', limit: number) {
  if (side === 'LONG') {
    return {
      sl: limit * (1 - SL_PCT),
      tp: limit * (1 + TP_PCT),
      tp1: limit * (1 + TP1_PCT),
      tp3: limit * (1 + TP3_PCT),
      invalidate: limit * (1 + SL_PCT * 0.55),
      zoneLow: limit * (1 - 0.0008),
      zoneHigh: limit,
    }
  }
  return {
    sl: limit * (1 + SL_PCT),
    tp: limit * (1 - TP_PCT),
    tp1: limit * (1 - TP1_PCT),
    tp3: limit * (1 - TP3_PCT),
    invalidate: limit * (1 - SL_PCT * 0.55),
    zoneLow: limit,
    zoneHigh: limit * (1 + 0.0008),
  }
}

function toAlert(
  symbol: string,
  event: OrderBookEvent,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const detected = event.side!
  const side: 'LONG' | 'SHORT' = INVERT_SIDE
    ? detected === 'LONG'
      ? 'SHORT'
      : 'LONG'
    : detected

  const rawSetup = (
    event.mmPattern ||
    (event.kind === 'ASK_WALL_REMOVED' || event.kind === 'BID_WALL_REMOVED'
      ? 'BOOK_RELEASE'
      : event.kind.replace(/_LONG$|_SHORT$/, ''))
  ).slice(0, 24)
  const setup = INVERT_SIDE ? `FADE_${rawSetup}`.slice(0, 32) : rawSetup

  const limit = event.wallPrice && event.wallPrice > 0 ? event.wallPrice : 0
  const lv = levelsForSide(side, limit)
  const dayTag =
    dayBias === 'PUMP' ? 'дневной памп' : dayBias === 'DUMP' ? 'дневной дамп' : 'hot'
  const name = symbol.replace('_USDT', '/USDT')
  const modeTag = INVERT_SIDE ? 'INVERT fade' : 'join'

  return {
    type: 'MEME',
    title: `🦈 MEME ${side} ${name} · ${setup}`,
    text: [
      `${dayTag} ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · ${setup}`,
      `${modeTag}: детект ${detected} → торг ${side}`,
      `Limit @ ${limit}`,
      `SL ${lv.sl} (~${(SL_PCT * 100).toFixed(1)}%) · TP1 ${lv.tp1} · TP ${lv.tp} (~${(TP_PCT * 100).toFixed(1)}%)`,
      `spread ${event.spreadBps.toFixed(0)}bps · conf ${event.confidence}`,
      ...event.notes.slice(0, 3),
      'v25: journal invert · no liq/spoof · wide SL',
    ].join('\n'),
    dedupeKey: `cron:mof25:${setup.toLowerCase()}:${symbol}:${side}:${Math.round(limit * 1e6)}`,
    score: event.confidence,
    winPct: Math.min(74, 54 + (event.confidence - 80)),
    style: 'SCALP',
    align: 'COUNTER',
    tradePlan: {
      side,
      symbol,
      setup,
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: lv.zoneLow,
      zoneHigh: lv.zoneHigh,
      invalidate: lv.invalidate,
      sl: lv.sl,
      tp: lv.tp,
      target1: lv.tp1,
      target3: lv.tp3,
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
    const alert = toAlert(
      coin.symbol,
      read.event,
      coin.dayBias,
      coin.chg24hPct
    )
    if (!alert.tradePlan || !(alert.tradePlan.signalPrice > 0)) {
      rejects.push({ symbol: coin.symbol, reason: 'no_limit' })
      continue
    }
    alerts.push(alert)
    if (alerts.length >= MAX_ALERTS) break
  }

  await saveBookState(opts.kv, state)

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
