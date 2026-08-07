/**
 * MEME order-flow scanner v27.3 — PEAK_FUEL_FAIL A-tier only.
 *
 * Scan broad → log all peak decisions with reasons → TG/paper only quality A
 * (protect WR). B-tier and skips stay in peak decision log for autopsy.
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
import { appendPeakDecision } from './peakDecisionLog'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v27'
/**
 * CF Workers free ~50 subrequests/invocation.
 * Lean scan leaves headroom for TG (+ pending flush on paper cron).
 * Budget: 1 ticker + 10 klines ≲ 12 — book off (candles carry PEAK).
 */
const MAX_SCAN = 10
/** Book off — each book+deals pair ate ~2 subreq and caused silent TG */
const BOOK_SCAN = 0
/** Emit every A-tier hit this tick (paper/TG caps apply downstream) */
const MAX_ALERTS = 3
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
        'User-Agent': 'EnterpriseMemeFlow/2.7.2',
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

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(6)
  return p.toFixed(8)
}

function pctFrom(entry: number, level: number): string {
  if (!(entry > 0)) return ''
  const p = ((level - entry) / entry) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
}

function peakFailToAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectPeakFuelFail>>,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const limit = sig.limitPrice
  const reasonLine = sig.reasons.slice(0, 8).join(' · ')
  return {
    type: 'MEME',
    title: `🦈 MEME SHORT ${name} · PEAK A`,
    text: [
      `Уровни (SHORT):`,
      `Открытие: ${fmtPx(limit)}`,
      `Стоп (SL): ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `Тейк 1 (TP1): ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)})`,
      `Тейк 2 (TP): ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      '',
      `дневной памп ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · PEAK_FUEL_FAIL · класс A`,
      dayBias === 'PUMP'
        ? 'PUMP day · fade без топлива'
        : 'сильный зелёный ход · fade',
      ...sig.notes.filter((n) => !/^SL~/i.test(n)),
      reasonLine ? `Причины: ${reasonLine}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:mof272:peak_fuel_fail:${symbol}:SHORT:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 480_000)}`,
    score: sig.confidence,
    winPct: Math.min(78, Math.max(55, 50 + (sig.confidence - 78))),
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
      entryReasons: sig.reasons,
      entryNotes: sig.notes.join(' · '),
      qualityTier: sig.quality,
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
  const bookSet = new Set(batch.slice(0, BOOK_SCAN).map((c) => c.symbol))
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

    // Book only for top BOOK_SCAN — stay under CF subrequest cap
    let evSide: 'LONG' | 'SHORT' | null = null
    let evKind = ''
    let evFlow = 50
    let evMove = 0
    let evMm: string | null = null
    let evReady = false
    if (bookSet.has(coin.symbol)) {
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
        reason: evReady
          ? `no_peak_or_weakness:${evKind}`
          : 'no_weakness_confirm',
      })
      await appendPeakDecision(opts.kv, {
        at: Date.now(),
        symbol: coin.symbol,
        action: 'SKIP_STRUCTURE',
        confidence: 0,
        quality: 'NONE',
        reasons: ['no_weakness_confirm', evReady ? evKind : 'no_book'],
        chg24hPct: coin.chg24hPct,
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
        await appendPeakDecision(opts.kv, {
          at: Date.now(),
          symbol: coin.symbol,
          action: 'SKIP_GATES',
          confidence: peak.confidence,
          quality: peak.quality,
          reasons: [
            ...peak.reasons,
            `hist_wr:${hist.wr.toFixed(0)}`,
            `hist_n:${hist.n}`,
          ],
          chg24hPct: coin.chg24hPct,
          distToHighPct: peak.distToHighPct,
        })
        continue
      }
    }

    // B-tier: log only — do not dilute WR with weak stalls
    if (peak.quality !== 'A') {
      rejects.push({
        symbol: coin.symbol,
        reason: `peak_B:${peak.confidence}`,
      })
      await appendPeakDecision(opts.kv, {
        at: Date.now(),
        symbol: coin.symbol,
        action: 'SKIP_QUALITY',
        confidence: peak.confidence,
        quality: 'B',
        reasons: peak.reasons,
        chg24hPct: coin.chg24hPct,
        distToHighPct: peak.distToHighPct,
      })
      continue
    }

    // Learn from closed PEAK: skip reason tags that lose live
    const avoid = gates?.peakAvoidReasons ?? []
    if (avoid.length) {
      const hit = peak.reasons.find((r) => {
        const tag = r.includes(':') ? r.split(':')[0]! : r
        return avoid.includes(tag)
      })
      if (hit) {
        rejects.push({
          symbol: coin.symbol,
          reason: `peak_learn_avoid:${hit}`,
        })
        await appendPeakDecision(opts.kv, {
          at: Date.now(),
          symbol: coin.symbol,
          action: 'SKIP_GATES',
          confidence: peak.confidence,
          quality: 'A',
          reasons: [...peak.reasons, `avoid:${hit}`],
          chg24hPct: coin.chg24hPct,
          distToHighPct: peak.distToHighPct,
        })
        continue
      }
    }

    // Prefer learned winning tags — slight score bump for ranking
    const prefer = gates?.peakPreferReasons ?? []
    if (prefer.length) {
      const prefHit = peak.reasons.some((r) => {
        const tag = r.includes(':') ? r.split(':')[0]! : r
        return prefer.includes(tag)
      })
      if (prefHit) peak.confidence = Math.min(94, peak.confidence + 3)
    }

    const alert = peakFailToAlert(
      coin.symbol,
      peak,
      coin.dayBias,
      coin.chg24hPct
    )
    await appendPeakDecision(opts.kv, {
      at: Date.now(),
      symbol: coin.symbol,
      action: 'ALERT',
      confidence: peak.confidence,
      quality: 'A',
      reasons: peak.reasons,
      chg24hPct: coin.chg24hPct,
      distToHighPct: peak.distToHighPct,
    })
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
