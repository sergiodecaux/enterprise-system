/**
 * MEME scanner — PEAK SHORT A → Predator; PUMP_CONTINUE → Elite.
 * v31: memeRegime + exhaustion + ageGate (alts keep MM phases elsewhere).
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
import { detectDumpFuelFail } from './dumpFuelFail'
import { detectDumpContinuation } from './dumpContinuation'
import { detectPumpContinue } from './pumpContinue'
import { appendPeakDecision } from './peakDecisionLog'
import { memeBookForecast } from './memeBookForecast'
import {
  measureMemeVolumeProfile,
  memeVolRankScore,
} from './memeVolumeProfile'
import {
  detectMemeRegime,
  type MemeRegime,
} from './memeRegimeDetector'
import { calcExhaustion, tapeBuyExhausting } from './exhaustionScore'
import { ageAllows, memeAgeGate } from './memeAgeGate'
import {
  bucketRejectReason,
  saveMemePipelineDebug,
  type MemePipelineSample,
} from './memePipelineDebug'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v31'
/** Pump batch for PEAK SHORT / Elite LONG */
const MAX_SCAN_PUMP = 10
/** Dump batch (DUMP reclaim muted — still for hotlist balance) */
const MAX_SCAN_DUMP = 4
/**
 * Book reads for meme fuel + manipulation forecast.
 * Cover almost full pump batch — memes lie on tape without depth.
 */
const BOOK_SCAN_PUMP = 10
const BOOK_SCAN_DUMP = 1
/** One PEAK A per tick */
const MAX_ALERTS = 1
/** One Elite meme LONG per tick (pump continue preferred over dump reclaim) */
const MAX_ELITE_LONG = 1

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
    regime?: MemeRegime | null
    wallSeenAt?: number | null
    tapeBuy?: number | null
    tapeActivity?: number | null
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

/** Legacy CONT gate — unused (PEAK + Elite DUMP only). */
export function allowMemeFlowEvent(
  _event: OrderBookEvent,
  _dayBias: 'PUMP' | 'DUMP' | null
): { ok: boolean; reason: string } {
  return { ok: false, reason: 'legacy_cont_disabled' }
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
      `Тейк 1 (TP1): ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)}) · 40% · BE`,
      `Тейк 2 (TP): ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      '',
      `дневной памп ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · PEAK_FUEL_FAIL · класс A`,
      dayBias === 'PUMP'
        ? 'PUMP day · fade без топлива · MM phase/intention'
        : 'сильный зелёный ход · fade · MM phase/intention',
      ...sig.notes.filter((n) => !/^SL~/i.test(n)),
      reasonLine ? `Причины: ${reasonLine}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:mof30:peak_fuel_fail:${symbol}:SHORT:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 1_200_000)}`,
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

function dumpContToAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectDumpContinuation>>,
  chg24hPct: number
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const limit = sig.limitPrice
  return {
    type: 'MEME',
    title: `🦈 MEME SHORT ${name} · DUMP CONT A`,
    text: [
      `DUMP CONTINUATION SHORT (не reclaim)`,
      `Открытие: ${fmtPx(limit)}`,
      `Стоп (SL): ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `Тейк 1: ${fmtPx(sig.tp1)} · Тейк 2: ${fmtPx(sig.tp)}`,
      `24h ${chg24hPct.toFixed(1)}% · bounce +${sig.bouncePct.toFixed(1)}% без bid support`,
      ...sig.notes,
      sig.reasons.slice(0, 8).join(' · '),
    ].join('\n'),
    dedupeKey: `cron:mof30:dump_cont:${symbol}:SHORT:${Math.floor(Date.now() / 1_200_000)}`,
    score: sig.confidence,
    winPct: Math.min(76, Math.max(52, sig.confidence - 10)),
    style: 'SCALP',
    align: 'WITH',
    tradePlan: {
      side: 'SHORT',
      symbol,
      setup: 'DUMP_CONTINUATION',
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: limit * 0.999,
      zoneHigh: limit * 1.001,
      invalidate: limit * 1.008,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: sig.tp,
      entryReasons: sig.reasons,
      entryNotes: sig.notes.join(' · '),
      qualityTier: sig.quality,
    },
  }
}

function dumpFailToEliteAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectDumpFuelFail>>,
  chg24hPct: number
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const limit = sig.limitPrice
  const reasonLine = sig.reasons.slice(0, 8).join(' · ')
  return {
    type: 'SNIPER',
    title: `🟢 ELITE LONG ${name} · DUMP A`,
    text: [
      `Мем LONG (dump reclaim) · Elite`,
      `Открытие: ${fmtPx(limit)}`,
      `Стоп (SL): ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `Тейк 1 (TP1): ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)})`,
      `Тейк 2 (TP): ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      '',
      `24h ${chg24hPct.toFixed(1)}% · DUMP_FUEL_FAIL · класс A`,
      'Нужен отбой от лоя + bullish 1m confirm (не tip-of-dump)',
      ...sig.notes.filter((n) => !/^SL~/i.test(n)),
      reasonLine ? `Причины: ${reasonLine}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:elite:dump_fuel_fail:${symbol}:LONG:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 1_200_000)}`,
    score: sig.confidence,
    winPct: Math.min(76, Math.max(52, 48 + (sig.confidence - 76))),
    style: 'SCALP',
    align: 'COUNTER',
    tradePlan: {
      side: 'LONG',
      symbol,
      setup: 'DUMP_FUEL_FAIL',
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: limit * 0.999,
      zoneHigh: limit * 1.002,
      invalidate: limit * 0.992,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: limit * 1.028,
      entryReasons: sig.reasons,
      entryNotes: sig.notes.join(' · '),
      qualityTier: sig.quality,
    },
  }
}

function pumpContinueToEliteAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectPumpContinue>>,
  chg24hPct: number
): ScanAlert {
  const name = symbol.replace('_USDT', '/USDT')
  const limit = sig.limitPrice
  const reasonLine = sig.reasons.slice(0, 8).join(' · ')
  return {
    type: 'SNIPER',
    title: `🟢 ELITE LONG ${name} · PUMP A`,
    text: [
      `Мем LONG (pump continue / squeeze) · Elite`,
      `Открытие: ${fmtPx(limit)}`,
      `Стоп (SL): ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `Тейк 1 (TP1): ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)})`,
      `Тейк 2 (TP): ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      '',
      `24h +${chg24hPct.toFixed(1)}% · PUMP_CONTINUE · класс A · score ${sig.score}`,
      'Нужны impulse/HH + OI↑ или bid absorb + 2m confirm (не TRAP tip)',
      ...sig.notes.filter((n) => !/^SL~/i.test(n)),
      reasonLine ? `Причины: ${reasonLine}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:elite:pump_continue:${symbol}:LONG:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 1_200_000)}`,
    score: sig.confidence + 2,
    winPct: Math.min(78, Math.max(55, 52 + (sig.confidence - 74))),
    style: 'SCALP',
    align: 'WITH_TREND',
    tradePlan: {
      side: 'LONG',
      symbol,
      setup: 'PUMP_CONTINUE',
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: limit * 0.998,
      zoneHigh: limit * 1.002,
      invalidate: limit * 0.991,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: limit * 1.03,
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
  })

  if (!watchlist.entries.length) {
    await saveMemePipelineDebug(opts.kv, {
      at: Date.now(),
      hotlist: 0,
      scanned: 0,
      age_gate_pass: 0,
      age_gate_block: 0,
      alerts_peak: 0,
      alerts_pump: 0,
      rejectStats: { empty_hotlist: 1 },
      samples: [],
      topRejects: [],
    })
    return {
      alerts: [],
      eliteAlerts: [],
      watchlist,
      skipped: watchlist.reason || 'empty_hotlist',
      scanned: 0,
      rejects: [],
    }
  }

  let ageGatePass = 0
  let ageGateBlock = 0
  const samples: MemePipelineSample[] = []
  const rejectStats: Record<string, number> = {}
  const bumpReject = (reason: string) => {
    const k = bucketRejectReason(reason)
    rejectStats[k] = (rejectStats[k] ?? 0) + 1
  }

  // Prefer mild/early pumps (pre-move lane) over tip monsters — 24h heat last
  const pumps = [...watchlist.entries]
    .filter((e) => e.dayBias === 'PUMP' || e.chg24hPct >= 2)
    .sort((a, b) => {
      const early = (e: (typeof a)) =>
        e.chg24hPct >= 2 && e.chg24hPct <= 14 ? 3 : e.chg24hPct <= 35 ? 2 : 0
      return early(b) - early(a) || b.score - a.score || b.chg24hPct - a.chg24hPct
    })
    .slice(0, MAX_SCAN_PUMP)
  const dumps = [...watchlist.entries]
    .filter((e) => e.dayBias === 'DUMP' || e.chg24hPct <= -4)
    .sort((a, b) => a.chg24hPct - b.chg24hPct || b.score - a.score)
    .slice(0, MAX_SCAN_DUMP)

  const bySym = new Map<string, (typeof pumps)[0]>()
  for (const c of [...pumps, ...dumps]) bySym.set(c.symbol, c)
  const batch = [...bySym.values()]
  // Book budget: early/mild first, then mid rockets — avoid +100% tips
  const pumpsForBook = [...pumps].sort((a, b) => {
    const rank = (e: (typeof a)) => {
      const chg = e.chg24hPct
      if (chg >= 2 && chg <= 14) return 4
      if (chg >= 10 && chg <= 55) return 3
      if (chg > 55 && chg <= 90) return 2
      if (chg >= 8) return 1
      return 0
    }
    return rank(b) - rank(a) || b.score - a.score
  })
  const bookSet = new Set(
    [
      ...pumpsForBook.slice(0, BOOK_SCAN_PUMP).map((c) => c.symbol),
      ...dumps.slice(0, BOOK_SCAN_DUMP).map((c) => c.symbol),
    ].filter(Boolean)
  )
  const state = await loadBookState(opts.kv)
  const rejects: Array<{ symbol: string; reason: string }> = []
  const candidates: ScanAlert[] = []
  const eliteCandidates: ScanAlert[] = []
  const gates = opts.gates ?? null

  for (const coin of batch) {
    const prev = state[coin.symbol]?.previous ?? null
    const older = state[coin.symbol]?.older ?? null
    const prevHold = state[coin.symbol]?.holdVol ?? null
    const tickerRow = tickers.find((t) => t.symbol === coin.symbol)
    const holdVol =
      tickerRow?.holdVol != null ? Number(tickerRow.holdVol) : null
    const price = Number(tickerRow?.lastPrice ?? 0)
    const isPump = coin.dayBias === 'PUMP' || coin.chg24hPct >= 5
    const isDump = coin.dayBias === 'DUMP' || coin.chg24hPct <= -4

    let evSide: 'LONG' | 'SHORT' | null = null
    let evKind = ''
    let evFlow = 50
    let evMove = 0
    let evMm: string | null = null
    let evReady = false
    let bookSeen = false
    let bookObi: number | null = null
    let tapeBuy: number | null = null
    let tapeMove: number | null = null
    let lastEvent: import('./orderBookReader').OrderBookEvent | null = null
    let lastSnap: import('./orderBookReader').OrderBookSnapshot | null = null
    const needBook =
      bookSet.has(coin.symbol) ||
      (isPump && coin.chg24hPct >= 7) ||
      (isDump && Math.abs(coin.chg24hPct) >= 8)
    if (needBook) {
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
          bookObi = read.snapshot.obi
          lastSnap = read.snapshot
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
        lastEvent = ev
        evReady = ev.ready
        evSide = ev.side
        evKind = ev.kind
        evFlow = ev.flowSharePct
        evMove = ev.priceMoveBps
        evMm = ev.mmPattern ?? null
        // Raw tape/OBI even without rare MM "ready" event — was thrown away before
        if (read.tape) {
          tapeBuy = read.tape.buyFlowPct
          tapeMove = read.tape.priceMoveBps
          if (!evReady) {
            evFlow = tapeBuy
            evMove = tapeMove
          }
        } else if (!evReady && bookObi != null) {
          // OBI-only fallback: positive OBI ≈ bid-heavy
          evFlow = Math.min(85, Math.max(15, 50 + bookObi * 0.4))
          evMove = 0
        }
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

    const candles = await fetchMin1Candles(coin.symbol, 80)
    const nowTs = Date.now()
    const wallPersisted = Boolean(lastEvent?.wallPersisted)
    const wallSeenAt = state[coin.symbol]?.wallSeenAt ?? null
    let wallAgeSec = 0
    if (wallPersisted) {
      if (!wallSeenAt) {
        state[coin.symbol] = {
          ...(state[coin.symbol] ?? {}),
          wallSeenAt: nowTs,
        }
        // First sight — unknown age (do NOT treat as 0 → flash spoof toxic)
        wallAgeSec = 0
      } else {
        wallAgeSec = Math.max(1, (nowTs - wallSeenAt) / 1000)
        // Cron ~2m: older+prev ≈ wall survived ≥1 tick (~90–120s)
        if (prev && older) wallAgeSec = Math.max(wallAgeSec, 45)
      }
    } else if (wallSeenAt) {
      state[coin.symbol] = {
        ...(state[coin.symbol] ?? {}),
        wallSeenAt: null,
      }
    }

    const absLong =
      evKind === 'ABSORPTION_LONG' ||
      (evMm === 'ABSORPTION' && evSide === 'LONG')
    const absShort =
      evKind === 'ABSORPTION_SHORT' ||
      (evMm === 'ABSORPTION' && evSide === 'SHORT')

    const volProfile = measureMemeVolumeProfile(candles, price)
    const closed = candles.length >= 2 ? candles.slice(0, -1) : candles
    let chg5mPct: number | null = null
    if (closed.length >= 5) {
      const a = closed[closed.length - 5]![1]
      const b = closed[closed.length - 1]![4]
      if (a > 0) chg5mPct = ((b - a) / a) * 100
    }

    const regimeState = detectMemeRegime({
      profile: volProfile,
      price,
      obi: bookObi,
      chg5mPct,
      prevRegime: state[coin.symbol]?.regime ?? null,
      flushProxy: chg5mPct != null && chg5mPct <= -4,
    })
    const prevTapeBuy = state[coin.symbol]?.tapeBuy ?? null
    const tapeActivity =
      tapeMove != null ? Math.abs(tapeMove) + (tapeBuy != null ? 10 : 0) : null
    const exhaustion = calcExhaustion({
      candles1m: candles,
      profile: volProfile,
      buyFlowPct: tapeBuy,
      priceMoveBps: tapeMove,
      tapeActivity,
      prevTapeActivity: state[coin.symbol]?.tapeActivity ?? null,
      spreadBps: lastEvent?.spreadBps ?? null,
      baselineSpreadBps: null,
    })
    const ageGate = memeAgeGate({
      age_minutes: regimeState.age_minutes,
      vol_ratio: volProfile.vol_ratio,
      profile: volProfile,
      regime: regimeState.regime,
      vol_decay_was_low:
        (state[coin.symbol]?.regime === 'ZOMBIE' ||
          state[coin.symbol]?.regime === 'DISTRIBUTION') &&
        volProfile.vol_ratio > 0.55,
    })

    state[coin.symbol] = {
      ...(state[coin.symbol] ?? {}),
      regime: regimeState.regime,
      holdVol: holdVol ?? prevHold ?? state[coin.symbol]?.holdVol ?? null,
      tapeBuy: tapeBuy ?? state[coin.symbol]?.tapeBuy ?? null,
      tapeActivity: tapeActivity ?? state[coin.symbol]?.tapeActivity ?? null,
    }

    const coherence = {
      // 0 = unknown first sight — forecast must not treat as flash spoof
      wallAgeSec: wallPersisted
        ? wallAgeSec > 0
          ? wallAgeSec
          : null
        : 0,
      tapeDirectionConsistent: true,
      tapeFlips: 0,
      priceResponseLogical: !(
        tapeBuy != null &&
        tapeMove != null &&
        ((tapeBuy >= 58 && tapeMove <= -20) ||
          (tapeBuy <= 42 && tapeMove >= 20))
      ),
    }

    const longForecast = memeBookForecast({
      side: 'LONG',
      bookSeen,
      snapshot: lastSnap,
      previous: prev,
      event: lastEvent,
      tapeBuy,
      tapeMoveBps: tapeMove,
      mmPattern: evMm,
      eventKind: evKind,
      eventReady: evReady,
      eventSide: evSide,
      coherence,
      market: 'meme',
    })
    const shortForecast = memeBookForecast({
      side: 'SHORT',
      bookSeen,
      snapshot: lastSnap,
      previous: prev,
      event: lastEvent,
      tapeBuy,
      tapeMoveBps: tapeMove,
      mmPattern: evMm,
      eventKind: evKind,
      eventReady: evReady,
      eventSide: evSide,
      coherence,
      market: 'meme',
    })

    if (ageGate.tradeable) ageGatePass++
    else ageGateBlock++

    const sampleBase: MemePipelineSample = {
      symbol: coin.symbol,
      age_minutes: regimeState.age_minutes,
      spike_detected: volProfile.spike_detected,
      regime: regimeState.regime,
      exhaustion: exhaustion.total,
      vol_ratio: volProfile.vol_ratio,
      age_gate: ageGate.reason,
      book_score_short: shortForecast.score,
      book_real_short: shortForecast.realBook,
      book_toxic_short: shortForecast.toxic,
      book_bias_short: shortForecast.bias,
      wall_age_sec: wallAgeSec,
    }

    if (!ageGate.tradeable && !isDump) {
      const reason = `age_gate:${ageGate.reason}`
      rejects.push({ symbol: coin.symbol, reason })
      if (samples.length < 8) samples.push({ ...sampleBase, reject: reason })
      continue
    }
    if (samples.length < 6) samples.push(sampleBase)

    if (isPump) {
      // Elite: PUMP_CONTINUE LONG A (catch fueled pumps) — before PEAK short
      if (eliteCandidates.length < MAX_ELITE_LONG) {
        if (longForecast.toxic) {
          rejects.push({
            symbol: coin.symbol,
            reason: `pump_book_toxic:${longForecast.reasons.slice(0, 2).join('+')}`,
          })
        } else {
        const longFlow =
          evReady && evSide === 'SHORT'
            ? Math.max(0, 100 - evFlow)
            : tapeBuy != null
              ? tapeBuy
              : evReady || bookSeen
                ? evFlow
                : null
        const longMove =
          tapeMove != null ? tapeMove : evReady || bookSeen ? evMove : null
        const bidHeavy =
          bookSeen &&
          ((bookObi != null && bookObi >= 12) ||
            (longFlow != null &&
              longFlow >= 56 &&
              (longMove == null || longMove >= -2)))
        if (!ageAllows(ageGate, 'PUMP_CONTINUE')) {
          rejects.push({
            symbol: coin.symbol,
            reason: `pump_age_block:${ageGate.reason}`,
          })
        } else {
        const pumpLong = detectPumpContinue({
          symbol: coin.symbol,
          price,
          chg24hPct: coin.chg24hPct,
          dayBias: coin.dayBias,
          holdVol,
          prevHoldVol: prevHold,
          candles1m: candles,
          buyFlowPct: longFlow,
          priceMoveBps: longMove,
          tapeFromBook: bookSeen && (tapeBuy != null || evReady || bookObi != null),
          absorptionLong: absLong,
          cvdBullish: evKind === 'CVD_DIVERGENCE' && evSide === 'LONG',
          bidHeavy,
          bookConfidence: !bookSeen
            ? null
            : longForecast.realBook
              ? 0.82
              : evReady
                ? 0.78
                : bookObi != null && bookObi >= 12
                  ? 0.66
                  : longFlow != null && longFlow >= 58
                    ? 0.62
                    : 0.5,
          bookForecast: longForecast,
          phase: 'final',
          memeRegime: regimeState.regime,
          memeAgeMinutes: regimeState.age_minutes,
          exhaustion: exhaustion.total,
          ageGateOk: true,
          volRatio: volProfile.vol_ratio,
          decayRate: volProfile.decay_rate,
        })
        if (pumpLong?.ready && pumpLong.quality === 'A') {
          const hist = setupHistoricalWr(gates, 'PUMP_CONTINUE')
          if (hist.n >= 14 && hist.wr < 28) {
            rejects.push({
              symbol: coin.symbol,
              reason: `pump_hist_dead:${hist.wr.toFixed(0)}%`,
            })
          } else {
            const alert = pumpContinueToEliteAlert(
              coin.symbol,
              pumpLong,
              coin.chg24hPct
            )
            alert.score = Math.min(
              99,
              alert.score + Math.round(memeVolRankScore(volProfile) / 20)
            )
            eliteCandidates.push(alert)
          }
        } else {
          rejects.push({
            symbol: coin.symbol,
            reason: !needBook
              ? 'no_pump_continue:book_skipped'
              : !bookSeen
                ? 'no_pump_continue:book_fetch_fail'
                : pumpLong
                  ? `pump_B:${pumpLong.score}/${pumpLong.confidence}/bk${longForecast.score}/exh${exhaustion.total}/${regimeState.regime}`
                  : `no_pump_continue:structure/bk${longForecast.score}/${regimeState.regime}`,
          })
        }
        }
        }
      }

      // Peak tapeStall expects BUY share stuck (buys not lifting) — use raw tapeBuy
      const shortFlow =
        bookSeen || evReady
          ? evReady
            ? evSide === 'SHORT'
              ? evFlow
              : Math.max(0, 100 - evFlow)
            : tapeBuy
          : null
      const shortMove =
        tapeMove != null ? tapeMove : evReady || bookSeen ? evMove : null
      const askHeavy =
        bookSeen &&
        ((bookObi != null && bookObi <= -12) ||
          (shortFlow != null && shortFlow <= 42))
      if (!ageAllows(ageGate, 'PEAK_SHORT')) {
        rejects.push({
          symbol: coin.symbol,
          reason: `peak_age_block:${ageGate.reason}`,
        })
      } else if (shortForecast.toxic) {
        rejects.push({
          symbol: coin.symbol,
          reason: `peak_book_toxic:${shortForecast.reasons.slice(0, 2).join('+')}`,
        })
      } else {
      const peak = detectPeakFuelFail({
        symbol: coin.symbol,
        price,
        chg24hPct: coin.chg24hPct,
        dayBias: coin.dayBias,
        holdVol,
        prevHoldVol: prevHold,
        candles1m: candles,
        buyFlowPct: shortFlow,
        priceMoveBps: shortMove,
        tapeFromBook: bookSeen && (tapeBuy != null || evReady || bookObi != null),
        absorptionShort: absShort,
        cvdBearish: evKind === 'CVD_DIVERGENCE' && evSide === 'SHORT',
        bookObi,
        askHeavy,
        bookForecast: shortForecast,
        memeRegime: regimeState.regime,
        memeAgeMinutes: regimeState.age_minutes,
        exhaustion: exhaustion.total,
        ageGateOk: true,
        tapeBuyExhausting: tapeBuyExhausting(tapeBuy, tapeMove, prevTapeBuy),
        decayRate: volProfile.decay_rate,
      })

      if (!peak?.ready) {
        rejects.push({
          symbol: coin.symbol,
          reason: 'no_weakness_confirm',
        })
      } else if (peak.quality !== 'A') {
        rejects.push({
          symbol: coin.symbol,
          reason: `peak_B:${peak.confidence}/bk${shortForecast.score}`,
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
      } else {
        const hist = setupHistoricalWr(gates, 'PEAK_FUEL_FAIL')
        if (hist.n >= 14 && hist.wr < 25) {
          rejects.push({
            symbol: coin.symbol,
            reason: `peak_hist_dead:${hist.wr.toFixed(0)}%`,
          })
        } else {
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
      }
      }
    }

    // DUMP reclaim LONG muted. DUMP_CONTINUATION SHORT → Predator.
    if (isDump && candidates.length < MAX_ALERTS) {
      const bidHeavyDump =
        bookSeen &&
        ((bookObi != null && bookObi >= 12) ||
          (tapeBuy != null &&
            tapeBuy >= 56 &&
            (tapeMove == null || tapeMove >= -2)))
      const dumpCont = detectDumpContinuation({
        symbol: coin.symbol,
        price,
        chg24hPct: coin.chg24hPct,
        dayBias: coin.dayBias,
        holdVol,
        prevHoldVol: prevHold,
        candles1m: candles,
        bookForecast: shortForecast,
        bidHeavy: bidHeavyDump,
      })
      if (dumpCont?.ready && dumpCont.quality === 'A') {
        candidates.push(dumpContToAlert(coin.symbol, dumpCont, coin.chg24hPct))
      } else {
        rejects.push({
          symbol: coin.symbol,
          reason: dumpCont
            ? `dump_cont_B:${dumpCont.confidence}`
            : 'no_dump_continuation',
        })
      }
    }

    // Legacy DUMP reclaim kept for type/import stability — never alerts
    if (false && isDump) {
      detectDumpFuelFail({
        symbol: coin.symbol,
        price,
        chg24hPct: coin.chg24hPct,
        dayBias: coin.dayBias,
        holdVol,
        prevHoldVol: prevHold,
        candles1m: candles,
        phase: 'final',
      })
    }
  }

  await saveBookState(opts.kv, state)

  candidates.sort((a, b) => b.score - a.score)
  // Prefer PUMP_CONTINUE over DUMP when both A fire
  eliteCandidates.sort((a, b) => {
    const ap = a.tradePlan?.setup === 'PUMP_CONTINUE' ? 1 : 0
    const bp = b.tradePlan?.setup === 'PUMP_CONTINUE' ? 1 : 0
    if (bp !== ap) return bp - ap
    return b.score - a.score
  })
  const top = candidates.slice(0, MAX_ALERTS)
  const eliteTop = eliteCandidates.slice(0, MAX_ELITE_LONG)

  // Rebuild reject funnel (covers all push paths)
  for (const r of rejects) bumpReject(r.reason)
  // Fill samples from leftover rejects if thin
  for (const r of rejects) {
    if (samples.length >= 8) break
    if (samples.some((s) => s.symbol === r.symbol)) continue
    samples.push({
      symbol: r.symbol,
      age_minutes: 0,
      spike_detected: false,
      regime: '?',
      exhaustion: 0,
      vol_ratio: 0,
      age_gate: '?',
      book_score_short: 0,
      book_real_short: false,
      book_toxic_short: false,
      book_bias_short: '?',
      wall_age_sec: 0,
      reject: r.reason,
    })
  }

  await saveMemePipelineDebug(opts.kv, {
    at: Date.now(),
    hotlist: watchlist.entries.length,
    scanned: batch.length,
    age_gate_pass: ageGatePass,
    age_gate_block: ageGateBlock,
    alerts_peak: top.length,
    alerts_pump: eliteTop.length,
    rejectStats,
    samples,
    topRejects: rejects.slice(0, 10),
  })

  return {
    alerts: top,
    eliteAlerts: eliteTop,
    watchlist,
    skipped:
      top.length || eliteTop.length
        ? ''
        : rejects[0]?.reason
          ? `no_signal · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
          : 'no_peak_or_dump',
    scanned: batch.length,
    rejects: rejects.slice(0, 18),
  }
}
