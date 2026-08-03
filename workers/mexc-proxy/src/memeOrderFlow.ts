/**
 * MEME order-flow scanner v27 — PEAK_FUEL_FAIL only.
 *
 * All predator capacity on pump peaks without fuel → small SHORT.
 * CONT_* / WITH-day continuation disabled (journal: trap/late longs toxic).
 */

import type { ScanAlert } from './scanner'
import {
  resolveHotMemeWatchlist,
  type HotMemeWatchlist,
} from './hotMemeWatchlist'
import {
  readOrderBookEvent,
  type OrderBookEvent,
  type OrderBookSnapshot,
} from './orderBookReader'
import {
  setupHistoricalWr,
  type BotAdaptiveGates,
} from './botJournal'
import { detectPeakFuelFail, type Candle } from './peakFuelFail'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v27'
/** Cover full hotlist — peak hunt needs breadth */
const MAX_SCAN = 18
/** More alerts per tick — was missing live peaks */
const MAX_ALERTS = 5
/** Only emit PEAK_FUEL_FAIL */
const PEAK_ONLY = true

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
  {
    previous?: OrderBookSnapshot | null
    older?: OrderBookSnapshot | null
    holdVol?: number | null
  }
>

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EnterpriseMemeFlow/2.7',
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
  if (keys.length > 50) {
    for (const k of keys.slice(0, keys.length - 50)) delete state[k]
  }
  try {
    await kv.put(BOOK_STATE_KEY, JSON.stringify(state))
  } catch {
    /* quota */
  }
}

/**
 * Legacy CONT gate — PEAK_ONLY scan does not emit CONT alerts.
 */
export function allowMemeFlowEvent(
  _event: OrderBookEvent,
  _dayBias: 'PUMP' | 'DUMP' | null
): { ok: boolean; reason: string } {
  if (PEAK_ONLY) return { ok: false, reason: 'peak_only_mode' }
  return { ok: false, reason: 'peak_only_mode' }
}

function peakFailToAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectPeakFuelFail>>,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const limit = sig.limitPrice
  return {
    type: 'MEME',
    title: `🦈 MEME SHORT ${name} · PEAK_FUEL_FAIL`,
    text: [
      `дневной памп ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · PEAK_FUEL_FAIL`,
      dayBias === 'PUMP'
        ? 'PUMP day · fade без топлива'
        : 'сильный зелёный ход · fade',
      ...sig.notes,
      'v27: весь predator на PEAK_FUEL_FAIL',
    ].join('\n'),
    dedupeKey: `cron:mof27:peak_fuel_fail:${symbol}:SHORT:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 480_000)}`,
    score: sig.confidence,
    winPct: Math.min(74, Math.max(48, 45 + (sig.confidence - 70))),
    style: 'SCALP',
    align: 'COUNTER',
    tradePlan: {
      side: 'SHORT',
      symbol,
      setup: 'PEAK_FUEL_FAIL',
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: limit,
      zoneHigh: limit * 1.001,
      invalidate: limit * 1.007,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: limit * (1 - 0.025),
    },
  }
}

async function fetchMin1Candles(
  symbol: string,
  limit = 50
): Promise<Candle[]> {
  const json = await mexcJson<{
    data?: {
      time?: number[]
      open?: number[]
      high?: number[]
      low?: number[]
      close?: number[]
      vol?: number[]
    }
  }>(`/api/v1/contract/kline/${symbol}?interval=Min1&limit=${limit}`)
  const d = json?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  for (let i = 0; i < d.time.length; i++) {
    out.push([
      Number(d.time[i]) * 1000,
      Number(d.open?.[i] ?? 0),
      Number(d.high?.[i] ?? 0),
      Number(d.low?.[i] ?? 0),
      Number(d.close?.[i] ?? 0),
      Number(d.vol?.[i] ?? 0),
    ])
  }
  return out
}

export async function runMemeOrderFlowScan(opts: {
  kv?: KvLike
  pinSymbols?: string[]
  gates?: BotAdaptiveGates | null
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

  // Peak hunt: PUMP / strong green first
  const ranked = [...watchlist.entries].sort((a, b) => {
    const pumpA = a.dayBias === 'PUMP' || a.chg24hPct >= 8 ? 1 : 0
    const pumpB = b.dayBias === 'PUMP' || b.chg24hPct >= 8 ? 1 : 0
    const thinA =
      a.quoteVolUsd >= 150_000 && a.quoteVolUsd <= 5_000_000 ? 1 : 0
    const thinB =
      b.quoteVolUsd >= 150_000 && b.quoteVolUsd <= 5_000_000 ? 1 : 0
    return (
      pumpB - pumpA ||
      b.chg24hPct - a.chg24hPct ||
      thinB - thinA ||
      b.score - a.score
    )
  })
  const batch = ranked.slice(0, MAX_SCAN)
  const state = await loadBookState(opts.kv)
  const rejects: Array<{ symbol: string; reason: string }> = []
  const candidates: ScanAlert[] = []
  const gates = opts.gates ?? null

  for (const coin of batch) {
    const prev = state[coin.symbol]?.previous ?? null
    const older = state[coin.symbol]?.older ?? null
    const prevHold = state[coin.symbol]?.holdVol ?? null
    const tickerRow = tickers.find((t) => t.symbol === coin.symbol)
    const holdVol =
      tickerRow?.holdVol != null ? Number(tickerRow.holdVol) : null
    const price = Number(tickerRow?.lastPrice ?? 0)

    const isPump = coin.dayBias === 'PUMP' || coin.chg24hPct >= 4
    if (!isPump) {
      rejects.push({ symbol: coin.symbol, reason: 'not_pump_skip' })
      continue
    }

    // Book optional — peak structure from candles is enough
    let evSide: 'LONG' | 'SHORT' | null = null
    let evKind = ''
    let evFlow = 50
    let evMove = 0
    let evMm: string | null = null
    let evReady = false
    try {
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
          holdVol: holdVol ?? prevHold,
        }
      } else if (holdVol != null) {
        state[coin.symbol] = {
          ...(state[coin.symbol] ?? {}),
          holdVol,
        }
      }
      const ev = read.event
      evReady = ev.ready
      evSide = ev.side
      evKind = ev.kind
      evFlow = ev.flowSharePct
      evMove = ev.priceMoveBps
      evMm = ev.mmPattern ?? null
    } catch {
      if (holdVol != null) {
        state[coin.symbol] = {
          ...(state[coin.symbol] ?? {}),
          holdVol,
        }
      }
    }

    if (!(price > 0)) {
      rejects.push({ symbol: coin.symbol, reason: 'no_price' })
      continue
    }

    const candles = await fetchMin1Candles(coin.symbol, 60)
    const peak = detectPeakFuelFail({
      symbol: coin.symbol,
      price,
      chg24hPct: coin.chg24hPct,
      dayBias: coin.dayBias,
      holdVol,
      prevHoldVol: prevHold,
      candles1m: candles,
      buyFlowPct:
        evSide === 'SHORT'
          ? evFlow
          : evSide === 'LONG'
            ? Math.max(0, 100 - evFlow)
            : evReady
              ? 55
              : 58,
      priceMoveBps: evReady ? evMove : 0,
      absorptionShort:
        evKind === 'ABSORPTION_SHORT' ||
        (evMm === 'ABSORPTION' && evSide === 'SHORT') ||
        (evReady && evSide === 'SHORT' && Math.abs(evMove) <= 16),
      cvdBearish: evKind === 'CVD_DIVERGENCE' && evSide === 'SHORT',
    })

    if (!peak?.ready) {
      rejects.push({
        symbol: coin.symbol,
        reason: evReady ? `no_peak:${evKind}` : 'no_peak_structure',
      })
      continue
    }

    const alert = peakFailToAlert(
      coin.symbol,
      peak,
      coin.dayBias,
      coin.chg24hPct
    )
    if (gates) {
      const hist = setupHistoricalWr(gates, 'PEAK_FUEL_FAIL')
      if (hist.n >= 8 && hist.wr < 28) {
        rejects.push({
          symbol: coin.symbol,
          reason: `peak_hist_dead:${hist.wr.toFixed(0)}%`,
        })
        continue
      }
    }
    candidates.push(alert)
  }

  await saveBookState(opts.kv, state)

  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, MAX_ALERTS)

  return {
    alerts: top,
    watchlist,
    skipped: top.length
      ? ''
      : rejects[0]?.reason
        ? `no_peak · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
        : 'no_peak_fuel_fail',
    scanned: batch.length,
    rejects: rejects.slice(0, 18),
  }
}
