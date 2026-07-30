/**
 * MEME order-flow scanner v26 — Day Continue (journal autopsy 2026-07-30).
 *
 * Journal 103 MEME: WR~12% · ΣPnL −24.9% · 93% LOSS с MFE&lt;0.25%.
 * Kill: TRAP/COUNTER/LIQ/SPOOF + blind fade v25 (COUNTER tag = 0% WR).
 * Keep: WITH-day continuation after wall-release / absorption.
 * Wins clustered on DUMP→SHORT and clean PUMP→LONG with real MFE 2–9%.
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
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v26'
const MAX_SCAN = 8
const MAX_ALERTS = 2
const MIN_CONF = 84
const MAX_SPREAD_BPS = 45
const MAX_SPREAD_BPS_STRONG = 55

/** Autopsy: fade/counter lost — trade WITH day bias only */
const INVERT_SIDE = false
const SL_PCT = 0.015
const TP_PCT = 0.03
const TP1_PCT = 0.018
const TP3_PCT = 0.04
/** Wall-release: tape in trade direction */
const MIN_FLOW_SHARE_WALL = 52
/** FOMO chase into pump without wall/abs */
const MAX_FOMO_FLOW_NO_WALL = 72

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
        'User-Agent': 'EnterpriseMemeFlow/2.6',
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
  // Journal: LIQ 0/6 · SPOOF 0 wins · traps toxic
  if (kind.startsWith('LIQ_CASCADE')) return false
  if (kind.startsWith('SPOOF_SWEEP')) return false
  if (kind.startsWith('TRAP_FLIP')) return false
  return (
    kind.startsWith('ABSORPTION') ||
    kind === 'CVD_DIVERGENCE' ||
    kind === 'ASK_WALL_REMOVED' ||
    kind === 'BID_WALL_REMOVED' ||
    // Pre-impulse OBI build WITH day — was blocked entirely → rare alerts
    kind === 'BUY_FLOW_IMBALANCE' ||
    kind === 'SELL_FLOW_IMBALANCE'
  )
}

/**
 * Gate for Day Continue: detected side must match day bias (WITH),
 * tape must confirm continuation, no trap/unload/cover.
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
  if (event.spreadBps > MAX_SPREAD_BPS && event.confidence < 92) {
    return { ok: false, reason: `wide_spread ${event.spreadBps}bps` }
  }

  if (!isAllowedKind(event.kind)) {
    return { ok: false, reason: `killed ${event.kind}` }
  }

  if (event.trap) {
    return { ok: false, reason: 'trap_disabled' }
  }

  if (!dayBias) {
    return { ok: false, reason: 'no_day_bias' }
  }

  // WITH day only — COUNTER was 0% WR in journal
  if (dayBias === 'PUMP' && event.side !== 'LONG') {
    return { ok: false, reason: 'against_pump_day' }
  }
  if (dayBias === 'DUMP' && event.side !== 'SHORT') {
    return { ok: false, reason: 'against_dump_day' }
  }

  const isAbs =
    event.kind.startsWith('ABSORPTION') || event.kind === 'CVD_DIVERGENCE'
  const isWall =
    event.kind === 'ASK_WALL_REMOVED' || event.kind === 'BID_WALL_REMOVED'
  const isFlowImb =
    event.kind === 'BUY_FLOW_IMBALANCE' || event.kind === 'SELL_FLOW_IMBALANCE'

  if (event.kind === 'ASK_WALL_REMOVED' && event.side !== 'LONG') {
    return { ok: false, reason: 'ask_gone_not_long' }
  }
  if (event.kind === 'BID_WALL_REMOVED' && event.side !== 'SHORT') {
    return { ok: false, reason: 'bid_gone_not_short' }
  }
  if (event.kind === 'BUY_FLOW_IMBALANCE' && event.side !== 'LONG') {
    return { ok: false, reason: 'buy_imb_not_long' }
  }
  if (event.kind === 'SELL_FLOW_IMBALANCE' && event.side !== 'SHORT') {
    return { ok: false, reason: 'sell_imb_not_short' }
  }

  // Absorption reports OPPOSING tape in flowSharePct — don't treat as unload.
  // Wall/flow-imbalance need supportive tape in trade direction.
  if (!isAbs && event.flowSharePct < MIN_FLOW_SHARE_WALL) {
    return {
      ok: false,
      reason:
        dayBias === 'PUMP'
          ? `weak_buy_flow=${event.flowSharePct.toFixed(0)}`
          : `weak_sell_flow=${event.flowSharePct.toFixed(0)}`,
    }
  }
  if (isAbs && event.flowSharePct < 45) {
    return {
      ok: false,
      reason: `weak_absorption_tape=${event.flowSharePct.toFixed(0)}`,
    }
  }

  // FOMO: extreme buy into pump without structure → late chase
  if (
    dayBias === 'PUMP' &&
    event.side === 'LONG' &&
    !isAbs &&
    !isWall &&
    event.flowSharePct >= MAX_FOMO_FLOW_NO_WALL
  ) {
    return { ok: false, reason: 'pump_fomo_chase' }
  }

  if (!isWall && !isAbs && !isFlowImb) {
    return { ok: false, reason: 'need_wall_abs_or_flow' }
  }

  // Flow imbalance alone: need higher conf (no discrete wall event)
  if (isFlowImb && event.confidence < 88) {
    return { ok: false, reason: 'flow_imb_conf<88' }
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
      invalidate: limit * (1 - SL_PCT * 0.7),
      zoneLow: limit * (1 - 0.0008),
      zoneHigh: limit,
    }
  }
  return {
    sl: limit * (1 + SL_PCT),
    tp: limit * (1 - TP_PCT),
    tp1: limit * (1 - TP1_PCT),
    tp3: limit * (1 - TP3_PCT),
    invalidate: limit * (1 + SL_PCT * 0.7),
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
  ).slice(0, 20)
  const setup = `CONT_${rawSetup}`.slice(0, 32)

  const limit = event.wallPrice && event.wallPrice > 0 ? event.wallPrice : 0
  const lv = levelsForSide(side, limit)
  const dayTag =
    dayBias === 'PUMP' ? 'дневной памп' : dayBias === 'DUMP' ? 'дневной дамп' : 'hot'
  const name = symbol.replace('_USDT', '/USDT')

  return {
    type: 'MEME',
    title: `🦈 MEME ${side} ${name} · ${setup}`,
    text: [
      `${dayTag} ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · ${setup}`,
      `Day Continue: WITH ${dayBias} · детект ${detected}`,
      `Limit @ ${limit}`,
      `SL ${lv.sl} (~${(SL_PCT * 100).toFixed(1)}%) · TP1 ${lv.tp1} · TP ${lv.tp} (~${(TP_PCT * 100).toFixed(1)}%)`,
      `spread ${event.spreadBps.toFixed(0)}bps · conf ${event.confidence} · flow ${event.flowSharePct.toFixed(0)}%`,
      ...event.notes.slice(0, 3),
      'v26: journal autopsy · WITH day · no trap/liq/spoof/fade',
    ].join('\n'),
    dedupeKey: `cron:mof26:${setup.toLowerCase()}:${symbol}:${side}:${Math.round(limit * 1e6)}`,
    score: event.confidence,
    winPct: Math.min(72, 50 + (event.confidence - 80) + (event.flowSharePct - 50) * 0.15),
    style: 'SCALP',
    align: 'WITH',
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
    // Prefer DUMP days slightly — SHORT continuation had better ΣPnL
    const dumpA = a.dayBias === 'DUMP' ? 1 : 0
    const dumpB = b.dayBias === 'DUMP' ? 1 : 0
    return (
      dumpB - dumpA || thinB - thinA || b.score - a.score
    )
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
