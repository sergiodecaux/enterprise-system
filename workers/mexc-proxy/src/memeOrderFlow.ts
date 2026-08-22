/**
 * Jeweler Burst v28.2 — PEAK + dedicated RANGE universe.
 *
 * Candles + HTF first, then live book only on structured peaks.
 * Never SHORT into bid walls / bid-heavy OBI.
 */

import type { ScanAlert } from './scanner'
import {
  resolveHotMemeWatchlist,
  type HotMemeEntry,
  type HotMemeWatchlist,
} from './hotMemeWatchlist'
import {
  analyzeCrowdBook,
  readOrderBookEvent,
  type OrderBookEvent,
  type OrderBookSnapshot,
} from './orderBookReader'
import { memeBookForecast } from './memeBookForecast'
import {
  allowPeakSymbol,
  peakCoinTrack,
  setupHistoricalWr,
  type BotAdaptiveGates,
} from './botJournal'
import {
  inspectPeakStructure,
  type Candle,
} from './peakFuelFail'
import {
  detectMemeDirectionalSignal,
  inspectMemeCandleDirections,
  type BtcBurstState,
  type MemeCandleCandidate,
  type MemeDirectionalSignal,
} from './memeDirectionalSignal'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v27'
/** Cover full hotlist — peak hunt needs breadth */
const MAX_SCAN = 12
/** Live 3-snap only after candle/HTF structure already passed */
const LIVE_BOOK = 4
/** More alerts per tick — was missing live peaks */
const MAX_ALERTS = 5
const MIN_SIGNAL_PROBABILITY = 68
const PEAK_ONLY = false

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

function directionalToAlert(
  symbol: string,
  sig: MemeDirectionalSignal,
  chg24hPct: number
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const fmt = (p: number) => {
    if (p >= 1000) return p.toFixed(2)
    if (p >= 1) return p.toFixed(4)
    if (p >= 0.01) return p.toFixed(6)
    return p.toFixed(8)
  }
  const pct = (level: number) => {
    const p = ((level - sig.limitPrice) / sig.limitPrice) * 100
    return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
  }
  const quality =
    sig.journalReasons
      .find((reason) => /^quality:(PLATINUM|GOLD|SILVER)$/.test(reason))
      ?.split(':')[1] ?? 'SILVER'
  return {
    type: 'MEME',
    title: `${sig.side === 'LONG' ? '🟢' : '🔴'} ${quality} ${sig.side} ${name} · JEWELER BURST`,
    text: [
      `Jeweler quality: ${sig.probability}/100 · порог ${MIN_SIGNAL_PROBABILITY}`,
      `24h ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}%`,
      '',
      `Вход: ${fmt(sig.limitPrice)}`,
      `SL: ${fmt(sig.sl)} (${pct(sig.sl)})`,
      `TP1: ${fmt(sig.tp1)} (${pct(sig.tp1)})`,
      `TP2: ${fmt(sig.tp)} (${pct(sig.tp)})`,
      ...sig.notes,
      'Новая стратегия: 3-snapshot стакан + tape + phase + BTC + sync',
    ].join('\n'),
    dedupeKey: `jeweler:burst:${sig.setup}:${symbol}:${sig.side}:${Math.floor(Date.now() / 480_000)}`,
    score: sig.probability,
    winPct: sig.probability,
    style: 'SCALP',
    align: sig.side === 'LONG' ? 'WITH_TREND' : 'COUNTER',
    tradePlan: {
      side: sig.side,
      symbol,
      setup: sig.setup,
      qualityTier: 'A',
      signalPrice: sig.limitPrice,
      entryIdeal: sig.limitPrice,
      zoneLow:
        sig.side === 'LONG' ? sig.limitPrice * 0.999 : sig.limitPrice,
      zoneHigh:
        sig.side === 'LONG' ? sig.limitPrice : sig.limitPrice * 1.001,
      invalidate: sig.sl,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: sig.target3,
      entryReasons: sig.journalReasons,
      entryNotes: sig.notes.join(' · '),
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
  for (let i = Math.max(0, d.time.length - limit); i < d.time.length; i++) {
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

function btcStateFromCandles(candles: Candle[]): BtcBurstState {
  const closed = candles.slice(0, -1)
  if (closed.length < 3) return 'NEUTRAL'
  const recent = closed.slice(-3)
  const first = recent[0]![1]
  const last = recent[recent.length - 1]![4]
  const change = first > 0 ? ((last - first) / first) * 100 : 0
  const short = recent.length >= 2 && recent[recent.length - 2]![4] > 0
    ? ((last - recent[recent.length - 2]![4]) /
        recent[recent.length - 2]![4]) *
      100
    : 0
  if (change > 0.3 || short > 0.15) return 'RISK_ON'
  if (change < -0.3 || short < -0.15) return 'RISK_OFF'
  return 'NEUTRAL'
}

export async function runMemeOrderFlowScan(opts: {
  kv?: KvLike
  pinSymbols?: string[]
  gates?: BotAdaptiveGates | null
}): Promise<{
  alerts: ScanAlert[]
  eliteAlerts: ScanAlert[]
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
    blockedSymbols: opts.gates?.blockedSymbols,
    preferSymbols: opts.gates?.preferSymbols,
  })

  if (!watchlist.entries.length) {
    return {
      alerts: [],
      eliteAlerts: [],
      watchlist,
      skipped: watchlist.reason || 'empty_hotlist',
      scanned: 0,
      rejects: [],
    }
  }

  const gates = opts.gates ?? null
  const btcState = btcStateFromCandles(
    await fetchMin1Candles('BTC_USDT', 10)
  )
  const rejects: Array<{ symbol: string; reason: string }> = []
  const candidates: ScanAlert[] = []
  // Directional hunt: liquid heat first. SHORT symbol WR is applied only
  // after the book chose SHORT; it must not suppress valid LONG candidates.
  const ranked = [...watchlist.entries]
    .sort((a, b) => {
      const prefA = allowPeakSymbol(gates, a.symbol).action === 'prefer' ? 1 : 0
      const prefB = allowPeakSymbol(gates, b.symbol).action === 'prefer' ? 1 : 0
      const thinA =
        a.quoteVolUsd >= 150_000 && a.quoteVolUsd <= 5_000_000 ? 1 : 0
      const thinB =
        b.quoteVolUsd >= 150_000 && b.quoteVolUsd <= 5_000_000 ? 1 : 0
      return (
        prefB - prefA ||
        thinB - thinA ||
        b.score - a.score ||
        Math.abs(b.chg24hPct) - Math.abs(a.chg24hPct)
      )
    })
  // Reserve half of every scan for liquid low-movement names. The old ranking
  // was dominated by 24h pumps/dumps, so RANGE logic rarely received candles.
  const movers = ranked
    .filter((coin) => Math.abs(coin.chg24hPct) >= 6)
    .slice(0, Math.ceil(MAX_SCAN / 2))
  const sideways = ranked
    .filter(
      (coin) =>
        Math.abs(coin.chg24hPct) >= 0.5 &&
        Math.abs(coin.chg24hPct) < 6 &&
        coin.quoteVolUsd >= 250_000
    )
    .sort((a, b) => {
      const liquidityA = Math.log10(Math.max(a.quoteVolUsd, 10_000))
      const liquidityB = Math.log10(Math.max(b.quoteVolUsd, 10_000))
      const calmA = Math.max(0, 6 - Math.abs(a.chg24hPct))
      const calmB = Math.max(0, 6 - Math.abs(b.chg24hPct))
      return liquidityB + calmB * 0.35 - (liquidityA + calmA * 0.35)
    })
    .slice(0, Math.floor(MAX_SCAN / 2))
  const batch = [...movers, ...sideways]
  for (const coin of ranked) {
    if (batch.length >= MAX_SCAN) break
    if (!batch.some((picked) => picked.symbol === coin.symbol)) batch.push(coin)
  }
  const state = await loadBookState(opts.kv)

  type Structured = {
    coin: HotMemeEntry
    price: number
    holdVol: number | null
    prevHold: number | null
    candles: Candle[]
    directions: MemeCandleCandidate[]
  }
  const structured: Structured[] = []

  for (const coin of batch) {
    const prevHold = state[coin.symbol]?.holdVol ?? null
    const tickerRow = tickers.find((t) => t.symbol === coin.symbol)
    const holdVol =
      tickerRow?.holdVol != null ? Number(tickerRow.holdVol) : null
    const price = Number(tickerRow?.lastPrice ?? 0)
    if (!(price > 0)) {
      rejects.push({ symbol: coin.symbol, reason: 'no_price' })
      continue
    }
    if (holdVol != null) {
      state[coin.symbol] = {
        ...(state[coin.symbol] ?? {}),
        holdVol,
      }
    }
    const candles = await fetchMin1Candles(coin.symbol, 120)
    const peakInspect = inspectPeakStructure({
      price,
      chg24hPct: coin.chg24hPct,
      dayBias: coin.dayBias,
      candles1m: candles,
    })
    const directions = inspectMemeCandleDirections(candles, coin.chg24hPct)
    if (
      peakInspect?.ok &&
      !directions.some((candidate) => candidate.side === 'SHORT')
    ) {
      directions.push({
        side: 'SHORT',
        score: 64,
        htfAligned: !peakInspect.candles.htfUp,
        patterns: peakInspect.candles.patterns,
      })
    }
    if (!directions.length) {
      rejects.push({
        symbol: coin.symbol,
        reason: peakInspect?.reason || 'no_directional_candle_structure',
      })
      continue
    }
    structured.push({ coin, price, holdVol, prevHold, candles, directions })
  }

  const liveBook = new Set<string>()
  const bookRanked = [...structured].sort((a, b) => {
    const bestA = Math.max(...a.directions.map((d) => d.score))
    const bestB = Math.max(...b.directions.map((d) => d.score))
    const prefA = allowPeakSymbol(gates, a.coin.symbol).action === 'prefer' ? 1 : 0
    const prefB = allowPeakSymbol(gates, b.coin.symbol).action === 'prefer' ? 1 : 0
    return bestB - bestA || prefB - prefA || b.coin.score - a.coin.score
  })
  const rangeStructured = bookRanked.filter((row) =>
    row.directions.some((direction) =>
      direction.patterns.some((pattern) => pattern.startsWith('range_'))
    )
  )
  for (const row of rangeStructured.slice(0, 2)) {
    liveBook.add(row.coin.symbol)
  }
  for (const r of bookRanked) {
    if (liveBook.size >= LIVE_BOOK) break
    liveBook.add(r.coin.symbol)
  }

  for (const row of structured) {
    const { coin, price, holdVol, prevHold, candles, directions } = row
    const prev = state[coin.symbol]?.previous ?? null
    const older = state[coin.symbol]?.older ?? null

    let evSide: 'LONG' | 'SHORT' | null = null
    let evKind = ''
    let evFlow: number | null = null
    let evMove: number | null = null
    let evMm: string | null = null
    let evReady = false
    let bookSeen = false
    let toxicBook = false
    let bookEvent: OrderBookEvent | null = null
    let snapshot: OrderBookSnapshot | null = null
    let crowd = analyzeCrowdBook(null)
    let forecastShort = memeBookForecast({
      side: 'SHORT',
      bookSeen: false,
      market: 'meme',
    })
    let forecastLong = memeBookForecast({
      side: 'LONG',
      bookSeen: false,
      market: 'meme',
    })
    const wantLive = liveBook.has(coin.symbol)
    if (wantLive) {
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
          bookSeen = true
          snapshot = read.snapshot
          state[coin.symbol] = {
            older: prev,
            previous: read.snapshot,
            holdVol: holdVol ?? prevHold,
          }
        }
        const ev = read.event
        bookEvent = ev
        evReady = ev.ready
        evSide = ev.side
        evKind = ev.kind
        evFlow = read.tape?.buyFlowPct ?? (ev.ready ? ev.flowSharePct : null)
        evMove = read.tape?.priceMoveBps ?? (ev.ready ? ev.priceMoveBps : null)
        evMm = ev.mmPattern ?? null

        crowd = analyzeCrowdBook(read.snapshot, read.prior ?? prev)

        forecastShort = memeBookForecast({
          side: 'SHORT',
          bookSeen: true,
          snapshot: read.snapshot,
          previous: prev,
          event: ev,
          tapeBuy: evFlow,
          tapeMoveBps: evMove,
          mmPattern: evMm,
          eventKind: evKind,
          eventReady: evReady,
          eventSide: evSide,
          market: 'meme',
        })
        forecastLong = memeBookForecast({
          side: 'LONG',
          bookSeen: true,
          snapshot: read.snapshot,
          previous: prev,
          event: ev,
          tapeBuy: evFlow,
          tapeMoveBps: evMove,
          mmPattern: evMm,
          eventKind: evKind,
          eventReady: evReady,
          eventSide: evSide,
          market: 'meme',
        })
        if (forecastShort.toxic && forecastLong.toxic) toxicBook = true
      } catch {
        /* book is mandatory below */
      }
    }

    if (!bookSeen || !snapshot || !bookEvent) {
      rejects.push({ symbol: coin.symbol, reason: 'live_book_required' })
      continue
    }

    const longCandidate = directions
      .filter((candidate) => candidate.side === 'LONG')
      .sort((a, b) => b.score - a.score)[0]
    const longSignal = longCandidate
      ? detectMemeDirectionalSignal({
          candidate: longCandidate,
          price,
          snapshot,
          crowd,
          forecast: forecastLong,
          event: bookEvent,
          candles,
          btcState,
          tapeBuyPct: evFlow,
          tapeMoveBps: evMove,
        })
      : null

    const shortCandidate = directions
      .filter((candidate) => candidate.side === 'SHORT')
      .sort((a, b) => b.score - a.score)[0]
    const shortSignal = shortCandidate
      ? detectMemeDirectionalSignal({
          candidate: shortCandidate,
          price,
          snapshot,
          crowd,
          forecast: forecastShort,
          event: bookEvent,
          candles,
          btcState,
          tapeBuyPct: evFlow,
          tapeMoveBps: evMove,
        })
      : null
    const chosen = [longSignal, shortSignal]
      .filter((signal): signal is MemeDirectionalSignal => signal != null)
      .sort((a, b) => b.probability - a.probability)[0]
    if (!chosen) {
      rejects.push({
        symbol: coin.symbol,
        reason: toxicBook
          ? `book_toxic:${evKind || 'forecast'}`
          : 'jeweler_direction_not_confirmed',
      })
      continue
    }

    const gate = allowPeakSymbol(gates, coin.symbol)
    if (chosen.side === 'SHORT') {
      if (!gate.ok) {
        rejects.push({
          symbol: coin.symbol,
          reason: gate.reason || 'symbol_wr_block',
        })
        continue
      }
      const track = peakCoinTrack(gates, coin.symbol)
      if (
        (track.kind === 'thin' || track.kind === 'new') &&
        chosen.probability < 72
      ) {
        rejects.push({
          symbol: coin.symbol,
          reason: `symbol_${track.kind}_needs_72:${track.wrLine}`,
        })
        continue
      }
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
    }
    const alert = directionalToAlert(
      coin.symbol,
      chosen,
      coin.chg24hPct
    )
    if (chosen.side === 'SHORT' && gate.action === 'prefer') {
      alert.score = Math.min(99, alert.score + 4)
    }
    candidates.push(alert)
  }

  await saveBookState(opts.kv, state)

  candidates.sort((a, b) => {
    const noticeA = a.watchOnly ? 1 : 0
    const noticeB = b.watchOnly ? 1 : 0
    if (noticeA !== noticeB) return noticeA - noticeB
    const prefA =
      allowPeakSymbol(gates, a.tradePlan!.symbol).action === 'prefer' ? 1 : 0
    const prefB =
      allowPeakSymbol(gates, b.tradePlan!.symbol).action === 'prefer' ? 1 : 0
    return prefB - prefA || b.score - a.score
  })
  const trades = candidates.filter((a) => !a.watchOnly)
  const notices = candidates.filter((a) => a.watchOnly).slice(0, 1)
  const top = [...trades.slice(0, Math.max(1, MAX_ALERTS - 1)), ...notices]

  return {
    alerts: top,
    eliteAlerts: [],
    watchlist,
    skipped: top.length
      ? ''
      : rejects[0]?.reason
        ? `no_jeweler_signal · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
        : 'no_jeweler_signal',
    scanned: batch.length,
    rejects: rejects.slice(0, 18),
  }
}
