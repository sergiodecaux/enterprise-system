/**
 * MEME order-flow scanner v27.4 — PEAK_FUEL_FAIL only (proven coins).
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
import { detectPeakFuelFail, type Candle } from './peakFuelFail'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v27'
/** Cover full hotlist — peak hunt needs breadth */
const MAX_SCAN = 12
/** Live 3-snap (~4 subrequests) only on a few prefer+PUMP names */
const LIVE_BOOK = 3
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
  chg24hPct: number,
  wrLine: string
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const limit = sig.limitPrice
  const fmt = (p: number) => {
    if (!(p > 0)) return '—'
    if (p >= 1000) return p.toFixed(2)
    if (p >= 1) return p.toFixed(4)
    if (p >= 0.01) return p.toFixed(6)
    return p.toFixed(8)
  }
  const pct = (entry: number, level: number) => {
    if (!(entry > 0)) return ''
    const p = ((level - entry) / entry) * 100
    return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
  }
  return {
    type: 'MEME',
    title: `🦈 MEME SHORT ${name} · PEAK_FUEL_FAIL`,
    text: [
      `Уровни (SHORT):`,
      `Открытие: ${fmt(limit)}`,
      `Стоп (SL): ${fmt(sig.sl)} (${pct(limit, sig.sl)})`,
      `Тейк 1 (TP1): ${fmt(sig.tp1)} (${pct(limit, sig.tp1)})`,
      `Тейк 2 (TP): ${fmt(sig.tp)} (${pct(limit, sig.tp)})`,
      '',
      `дневной памп ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · PEAK_FUEL_FAIL`,
      wrLine,
      dayBias === 'PUMP'
        ? 'PUMP day · fade без топлива'
        : 'сильный зелёный ход · fade',
      ...sig.notes.filter((n) => !/^SL~/i.test(n)),
      'v27.4: только проверенные монеты · WR в сигнале · новая = notice',
    ].join('\n'),
    dedupeKey: `cron:mof273:peak_fuel_fail:${symbol}:SHORT:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 480_000)}`,
    score: sig.confidence,
    winPct: Math.min(74, Math.max(48, 45 + (sig.confidence - 70))),
    style: 'SCALP',
    align: 'COUNTER',
    tradePlan: {
      side: 'SHORT',
      symbol,
      setup: 'PEAK_FUEL_FAIL',
      qualityTier: 'A',
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

  const pinSet = new Set(opts.pinSymbols ?? [])
  const gates = opts.gates ?? null
  const rejects: Array<{ symbol: string; reason: string }> = []
  const candidates: ScanAlert[] = []
  // Peak hunt: journal winners first, then PUMP / strong green
  const ranked = [...watchlist.entries]
    .filter((e) => {
      const gate = allowPeakSymbol(gates, e.symbol)
      if (gate.ok) return true
      if (pinSet.has(e.symbol)) return true
      rejects.push({ symbol: e.symbol, reason: gate.reason || 'symbol_wr_block' })
      return false
    })
    .sort((a, b) => {
      const prefA = allowPeakSymbol(gates, a.symbol).action === 'prefer' ? 1 : 0
      const prefB = allowPeakSymbol(gates, b.symbol).action === 'prefer' ? 1 : 0
      const pumpA = a.dayBias === 'PUMP' || a.chg24hPct >= 8 ? 1 : 0
      const pumpB = b.dayBias === 'PUMP' || b.chg24hPct >= 8 ? 1 : 0
      const thinA =
        a.quoteVolUsd >= 150_000 && a.quoteVolUsd <= 5_000_000 ? 1 : 0
      const thinB =
        b.quoteVolUsd >= 150_000 && b.quoteVolUsd <= 5_000_000 ? 1 : 0
      return (
        prefB - prefA ||
        pumpB - pumpA ||
        b.chg24hPct - a.chg24hPct ||
        thinB - thinA ||
        b.score - a.score
      )
    })
  const batch = ranked.slice(0, MAX_SCAN)
  const liveBook = new Set<string>()
  const pumpBatch = batch.filter(
    (c) => c.dayBias === 'PUMP' || c.chg24hPct >= 4
  )
  const preferPumps = pumpBatch.filter(
    (c) => allowPeakSymbol(gates, c.symbol).action === 'prefer'
  )
  const otherPumps = pumpBatch.filter(
    (c) => allowPeakSymbol(gates, c.symbol).action !== 'prefer'
  )
  for (const c of [...preferPumps, ...otherPumps]) {
    if (liveBook.size >= LIVE_BOOK) break
    liveBook.add(c.symbol)
  }
  const state = await loadBookState(opts.kv)

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

    let evSide: 'LONG' | 'SHORT' | null = null
    let evKind = ''
    let evFlow: number | null = null
    let evMove: number | null = null
    let evMm: string | null = null
    let evReady = false
    let bookSeen = false
    let crowdSoft = 0
    let crowdNote: string | null = null
    let toxicBook = false
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
        evFlow = ev.ready ? ev.flowSharePct : null
        evMove = ev.ready ? ev.priceMoveBps : null
        evMm = ev.mmPattern ?? null

        const crowd = analyzeCrowdBook(
          read.snapshot,
          read.prior ?? prev
        )
        if (crowd.shortBaitAsks) {
          crowdSoft -= 1
          crowdNote = `мелкие asks толпы ×${crowd.crowdAskLevels} — приманка шортов`
        }
        if (crowd.spoofAskWall && crowd.largeBidWall) {
          crowdSoft -= 2
          crowdNote = 'yank ask + живые биды — магнит вверх'
        } else if (crowd.spoofAskWall) {
          crowdSoft -= 1
          crowdNote = crowdNote ?? 'ask-стена сорвана без прохода (spoof)'
        } else if (
          crowd.largeAskWall &&
          evReady &&
          evMove != null &&
          Math.abs(evMove) <= 16 &&
          (evFlow ?? 0) >= 52
        ) {
          crowdSoft += 2
          crowdNote = 'живая ask-стена · покупки не едут — толпа заперта'
        }
        crowdSoft = Math.max(-2, Math.min(2, crowdSoft))

        const fc = memeBookForecast({
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
        if (fc.toxic) toxicBook = true
      } catch {
        if (holdVol != null) {
          state[coin.symbol] = {
            ...(state[coin.symbol] ?? {}),
            holdVol,
          }
        }
      }
    } else if (holdVol != null) {
      state[coin.symbol] = {
        ...(state[coin.symbol] ?? {}),
        holdVol,
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
        evReady && evSide === 'SHORT'
          ? evFlow
          : evReady && evSide === 'LONG'
            ? evFlow != null
              ? Math.max(0, 100 - evFlow)
              : null
            : evReady
              ? 55
              : null,
      priceMoveBps: evReady ? evMove : null,
      absorptionShort:
        evKind === 'ABSORPTION_SHORT' ||
        (evMm === 'ABSORPTION' && evSide === 'SHORT') ||
        (evReady && evSide === 'SHORT' && evMove != null && Math.abs(evMove) <= 16),
      cvdBearish: evKind === 'CVD_DIVERGENCE' && evSide === 'SHORT',
      bookSeen,
      crowdSoft,
      crowdNote,
      toxicBook,
    })

    if (!peak?.ready) {
      rejects.push({
        symbol: coin.symbol,
        reason: toxicBook
          ? `peak_book_toxic:${evKind || 'forecast'}`
          : evReady
            ? `no_peak:${evKind}`
            : 'no_peak_structure',
      })
      continue
    }

    const gate = allowPeakSymbol(gates, coin.symbol)
    if (!gate.ok) {
      rejects.push({
        symbol: coin.symbol,
        reason: gate.reason || 'symbol_wr_block',
      })
      continue
    }
    const track = peakCoinTrack(gates, coin.symbol)
    if (track.kind === 'thin') {
      rejects.push({
        symbol: coin.symbol,
        reason: `symbol_thin:${track.wrLine}`,
      })
      continue
    }
    if (track.kind === 'new') {
      const nick = coin.symbol.replace(/_USDT$/i, '')
      candidates.push({
        type: 'MEME',
        title: `NEW ${nick} · нет истории PEAK`,
        text: [
          `Новая монета: ${nick}`,
          `PEAK SHORT нашёл сетап, но закрытых сделок по ней нет.`,
          `Сигнал не открываю — сначала нужна история.`,
          track.wrLine,
          `pump ${coin.chg24hPct >= 0 ? '+' : ''}${coin.chg24hPct.toFixed(1)}%`,
        ].join('\n'),
        dedupeKey: `cron:new_coin:${coin.symbol}:${Math.floor(Date.now() / 14_400_000)}`,
        score: Math.max(1, peak.confidence - 20),
        winPct: 0,
        style: 'SCALP',
        align: 'COUNTER',
        watchOnly: true,
        tradePlan: {
          side: 'SHORT',
          symbol: coin.symbol,
          setup: 'PEAK_FUEL_FAIL',
          qualityTier: 'A',
          signalPrice: peak.limitPrice,
          entryIdeal: peak.limitPrice,
          zoneLow: peak.limitPrice,
          zoneHigh: peak.limitPrice * 1.001,
          invalidate: peak.limitPrice * 1.007,
          sl: peak.sl,
          tp: peak.tp,
        },
      })
      continue
    }
    const alert = peakFailToAlert(
      coin.symbol,
      peak,
      coin.dayBias,
      coin.chg24hPct,
      track.wrLine
    )
    if (gate.action === 'prefer') {
      alert.score = Math.min(99, alert.score + 4)
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
        ? `no_peak · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
        : 'no_peak_fuel_fail',
    scanned: batch.length,
    rejects: rejects.slice(0, 18),
  }
}
