/**
 * MEME order-flow scanner — dual strategy:
 * PUMP_CONTINUE LONG (бывший SL шорта = TP) + DUMP_FUEL_FAIL LONG (reclaim).
 * PEAK_FUEL_FAIL SHORT остаётся только для чистого post_dump fade.
 * TG/paper only quality A.
 */

import type { ScanAlert } from './scanner'
import {
  resolveHotMemeWatchlist,
  type HotMemeEntry,
  type HotMemeWatchlist,
} from './hotMemeWatchlist'
import {
  readOrderBookEvent,
  analyzeCrowdBook,
  type OrderBookEvent,
  type OrderBookSnapshot,
} from './orderBookReader'
import {
  setupHistoricalWr,
  type BotAdaptiveGates,
} from './botJournal'
import { detectPeakFuelFail, type Candle } from './peakFuelFail'
import { detectDumpFuelFail } from './dumpFuelFail'
import { detectPumpContinue } from './pumpContinue'
import { appendPeakDecision } from './peakDecisionLog'
import {
  resolveMemeTradableUniverse,
  fetchPublicTradableSymbols,
  type MexcAuthEnv,
} from './mexcUniverse'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v27'
const PENDING_CONFIRM_KEY = 'scanner:meme_pending_confirm_v1'
/** First A-hit arms watch; emit only after ≥2 ticks spanning ~2 minutes */
const CONFIRM_WAIT_MS = 110_000
const CONFIRM_MIN_HITS = 2
/**
 * CF Workers free ~50 subrequests/invocation.
 * Lean scan leaves headroom for TG (+ pending flush on paper cron).
 */
const MAX_SCAN = 10
/**
 * More books = more chance to see retail $1–10 asks (CF budget ~50).
 * depth+deals ×6 ≈ 12 subreq + 10 klines ≈ 22 — headroom left.
 */
const MAX_BOOK = 6
/** Emit every A-tier hit this tick (paper/TG caps apply downstream) */
const MAX_ALERTS = 3
/** LONG squeeze focus — PEAK short fallback off (those SLs → LONG TP) */
const ALLOW_PEAK_SHORT = false
/** Peak short lane + dump long lane only */
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
  'DOGE_USDT',
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

interface PendingConfirm {
  symbol: string
  setup: string
  side: string
  firstAt: number
  lastAt: number
  hits: number
  conf: number
}

type PendingMap = Record<string, PendingConfirm>

function pendingKey(symbol: string, setup: string, side: string): string {
  return `${symbol}|${setup}|${side}`
}

async function loadPending(kv?: KvLike): Promise<PendingMap> {
  if (!kv) return {}
  try {
    const raw = await kv.get(PENDING_CONFIRM_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as PendingMap
  } catch {
    return {}
  }
}

async function savePending(kv: KvLike | undefined, map: PendingMap) {
  if (!kv) return
  const now = Date.now()
  for (const [k, v] of Object.entries(map)) {
    if (now - v.lastAt > 20 * 60_000) delete map[k]
  }
  try {
    await kv.put(PENDING_CONFIRM_KEY, JSON.stringify(map))
  } catch {
    /* quota */
  }
}

/**
 * Arm on first A-hit; fire only after ~2m and ≥2 confirming ticks.
 */
function armOrReleasePending(
  map: PendingMap,
  opts: {
    symbol: string
    setup: string
    side: string
    confidence: number
    now?: number
  }
): { release: boolean; hits: number; waitedMs: number } {
  const now = opts.now ?? Date.now()
  const key = pendingKey(opts.symbol, opts.setup, opts.side)
  const prev = map[key]
  if (!prev) {
    map[key] = {
      symbol: opts.symbol,
      setup: opts.setup,
      side: opts.side,
      firstAt: now,
      lastAt: now,
      hits: 1,
      conf: opts.confidence,
    }
    return { release: false, hits: 1, waitedMs: 0 }
  }
  prev.hits += 1
  prev.lastAt = now
  prev.conf = Math.max(prev.conf, opts.confidence)
  const waitedMs = now - prev.firstAt
  const release =
    prev.hits >= CONFIRM_MIN_HITS && waitedMs >= CONFIRM_WAIT_MS
  if (release) delete map[key]
  return { release, hits: prev.hits, waitedMs }
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

/** Plain-language tags for TG body (skip internal scoring noise). */
function humanPeakReasons(reasons: string[]): string[] {
  const out: string[] = []
  for (const r of reasons) {
    if (
      /^(quality|fuel|conf|dist_high|dist_local|dump|bounce|peak_age|trough_age|lh_vs_peak|hl_vs_trough|chg24|promote_B_to_A|oi_unknown|dump_weak|bounce_weak):?/.test(r) ||
      r === 'promote_B_to_A' ||
      r === 'oi_unknown' ||
      r === 'dump_weak' ||
      r === 'bounce_weak'
    ) {
      continue
    }
    else if (r.startsWith('failed_break_low')) out.push('фейл-брейк лоя')
    else if (r.startsWith('failed_break')) out.push('фейл-брейк хая')
    else if (r.startsWith('rejection_wick')) out.push('отбойный фитиль')
    else if (r.startsWith('lower_high')) out.push('структура lower high')
    else if (r.startsWith('stall_at_high')) out.push('застой у локального хая')
    else if (r === 'post_dump') out.push('памп уже слит — отбой')
    else if (r === 'dump_partial') out.push('частичный слив с пика')
    else if (r.startsWith('ask_absorption')) out.push('поглощение на ask')
    else if (r.startsWith('bid_absorption')) out.push('поглощение на bid')
    else if (r.startsWith('cvd_bearish')) out.push('CVD медвежий')
    else if (r.startsWith('cvd_bullish')) out.push('CVD бычий')
    else if (r.startsWith('ask_heavy_strong')) out.push('сильный перевес asks')
    else if (r.startsWith('ask_heavy')) out.push('стакан в asks')
    else if (r.startsWith('bid_heavy_strong')) out.push('сильный перевес bids')
    else if (r.startsWith('bid_heavy')) out.push('стакан в bids')
    else if (r.startsWith('bearish_trigger')) out.push('медвежья свеча')
    else if (r.startsWith('bullish_trigger')) out.push('бычья свеча')
    else if (r.startsWith('up_vol_fade')) out.push('объём покупок гаснет')
    else if (r.startsWith('down_vol_fade')) out.push('объём продаж гаснет')
    else if (r.startsWith('tape_stall')) out.push('агрессия не двигает цену')
    else if (r.startsWith('tape_down')) out.push('лента давит вниз')
    else if (r.startsWith('tape_up')) out.push('лента тянет вверх')
    else if (r.startsWith('price_stall')) out.push('цена стоит у уровня')
    else if (r.startsWith('hammer_wick')) out.push('молот / нижний фитиль')
    else if (r.startsWith('higher_low')) out.push('структура higher low')
    else if (r.startsWith('stall_at_low')) out.push('застой у локального лоя')
    else if (r === 'post_bounce') out.push('дамп уже отбит — отбой')
    else if (r === 'bounce_partial') out.push('частичный отскок от лоя')
    else if (r.startsWith('oi_flat')) out.push('OI без топлива')
    else if (r.startsWith('oi_weak')) out.push('OI слабый')
    else if (r.startsWith('oi_rising')) out.push('OI растёт — осторожно')
    else if (r === 'exhaust_ok') out.push('топливо выдохлось')
    else if (r === 'tech_ok') out.push('техвход подтверждён')
    else if (r === 'book_ok') out.push('стакан подтвердил')
    else if (r === 'book_missing') out.push('стакан не подтвердил')
    else if (r === 'down_confirmed') out.push('падение подтверждено')
    else if (r === 'down_unconfirmed') out.push('падение не подтверждено')
    else if (r === 'pressure_ok') out.push('давление покупок есть')
    else if (r === 'pressure_missing') out.push('нет давления — пропуск')
    else if (r === 'short_trap') out.push('приманка для шортов')
    else if (r.startsWith('crowd_asks_bait')) out.push('мелкие asks толпы $1–10')
    else if (r.startsWith('crowd_asks_weak')) out.push('мало толпы в asks')
    else if (r.startsWith('bid_support')) out.push('реальная поддержка bids')
    else if (r === 'fueled_impulse') out.push('импульс у хая живой')
    else if (r === 'higher_high_break') out.push('пробой локального хая')
    else if (r === 'fake_fade_reclaim') out.push('ложный fade → reclaim')
    else if (r === 'continue_ok') out.push('продолжение пампа')
    else if (r === 'squeeze_confirmed') out.push('сквиз подтверждён')
    else if (r === 'squeeze_unconfirmed') out.push('сквиз не подтверждён')
    else if (r.startsWith('former_sl_tp')) out.push('TP = бывший SL шорта')
  }
  return [...new Set(out)].slice(0, 5)
}

function peakFailToAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectPeakFuelFail>>,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const ticker = symbol.replace('_USDT', '')
  const limit = sig.limitPrice
  const title = `${fmtPx(limit)} ${ticker} · 🔴 SHORT`
  const why = [
    ...sig.notes.filter(
      (n) =>
        !/^SL~/i.test(n) &&
        !/^Пик без топлива/i.test(n) &&
        !/^Отбой после слива/i.test(n) &&
        !/^24h /i.test(n)
    ),
    ...humanPeakReasons(sig.reasons),
  ].slice(0, 5)
  return {
    type: 'MEME',
    title,
    text: [
      `🎯 ВХОД ${fmtPx(limit)}`,
      `🛑 SL ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `🟢 TP1 ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)}) · 💎 TP ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      `📊 24h ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · к хаю −${sig.distToHighPct.toFixed(2)}% · 🔥 conf ${sig.confidence}`,
      why.length
        ? `⚡ Почему: ${why.join(' · ')}`
        : '⚡ Пик без топлива — fade шорт',
      `⚠️ Инвалидация выше ${fmtPx(limit * 1.007)} · ушло ≥0.6% — НЕ догонять`,
      dayBias === 'PUMP' ? '🚀 День PUMP · работаем от пика' : '🌊 Сильный зелёный ход · fade',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:mof:peak_fuel_fail:${symbol}:SHORT:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 480_000)}`,
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

function dumpFailToAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectDumpFuelFail>>,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const ticker = symbol.replace('_USDT', '')
  const limit = sig.limitPrice
  const title = `${fmtPx(limit)} ${ticker} · 🟢 LONG`
  const why = [
    ...sig.notes.filter(
      (n) =>
        !/^SL~/i.test(n) &&
        !/^Лой без топлива/i.test(n) &&
        !/^Отбой после дампа/i.test(n) &&
        !/^24h /i.test(n)
    ),
    ...humanPeakReasons(sig.reasons),
  ].slice(0, 5)
  return {
    type: 'MEME',
    title,
    text: [
      `🎯 ВХОД ${fmtPx(limit)}`,
      `🛑 SL ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `🟢 TP1 ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)}) · 💎 TP ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      `📊 24h ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · к лою +${sig.distToLowPct.toFixed(2)}% · 🔥 conf ${sig.confidence}`,
      why.length
        ? `⚡ Почему: ${why.join(' · ')}`
        : '⚡ Дамп без топлива продавцов — reclaim лонг',
      `⚠️ Инвалидация ниже ${fmtPx(limit * 0.993)} · ушло ≥0.6% — НЕ догонять`,
      dayBias === 'DUMP' ? '🩸 День DUMP · работаем от лоя' : '🌊 Сильный красный ход · reclaim',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:mof:dump_fuel_fail:${symbol}:LONG:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 480_000)}`,
    score: sig.confidence,
    winPct: Math.min(78, Math.max(55, 50 + (sig.confidence - 78))),
    style: 'SCALP',
    align: 'COUNTER',
    tradePlan: {
      side: 'LONG',
      symbol,
      setup: 'DUMP_FUEL_FAIL',
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: limit * 0.999,
      zoneHigh: limit,
      invalidate: limit * 0.993,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: limit * (1 + 0.025),
      entryReasons: sig.reasons,
      entryNotes: sig.notes.join(' · '),
      qualityTier: sig.quality,
    },
  }
}

function pumpContinueToAlert(
  symbol: string,
  sig: NonNullable<ReturnType<typeof detectPumpContinue>>,
  dayBias: 'PUMP' | 'DUMP' | null,
  chg24hPct: number
): ScanAlert {
  const ticker = symbol.replace('_USDT', '')
  const limit = sig.limitPrice
  const title = `${fmtPx(limit)} ${ticker} · 🟢 LONG`
  const why = [
    ...sig.notes.filter(
      (n) =>
        !/^SL~/i.test(n) &&
        !/^Сквиз пампа/i.test(n) &&
        !/^24h /i.test(n)
    ),
    ...humanPeakReasons(sig.reasons),
  ].slice(0, 5)
  return {
    type: 'MEME',
    title,
    text: [
      `🎯 ВХОД ${fmtPx(limit)}`,
      `🛑 SL ${fmtPx(sig.sl)} (${pctFrom(limit, sig.sl)})`,
      `🟢 TP1 ${fmtPx(sig.tp1)} (${pctFrom(limit, sig.tp1)}) · 💎 TP ${fmtPx(sig.tp)} (${pctFrom(limit, sig.tp)})`,
      `📊 24h ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · к хаю −${sig.distToHighPct.toFixed(2)}% · 🔥 conf ${sig.confidence}`,
      why.length
        ? `⚡ Почему: ${why.join(' · ')}`
        : '⚡ Бывший SL шорта = TP лонга',
      `🎯 Бывший SL шорта → TP ${fmtPx(sig.formerSlAsTp)}`,
      `⚠️ Инвалидация ниже ${fmtPx(limit * 0.993)} · ушло ≥0.6% — НЕ догонять`,
      dayBias === 'PUMP' ? '🚀 День PUMP · едем сквиз, не шортим' : '🌊 Зелёный импульс · continue',
    ]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `cron:mof:pump_continue:${symbol}:LONG:${Math.round(limit * 1e5)}:${Math.floor(Date.now() / 480_000)}`,
    score: sig.confidence,
    winPct: Math.min(78, Math.max(55, 50 + (sig.confidence - 78))),
    style: 'SCALP',
    align: 'WITH',
    tradePlan: {
      side: 'LONG',
      symbol,
      setup: 'PUMP_CONTINUE',
      signalPrice: limit,
      entryIdeal: limit,
      zoneLow: limit * 0.999,
      zoneHigh: limit,
      invalidate: limit * 0.993,
      sl: sig.sl,
      tp: sig.tp,
      target1: sig.tp1,
      target3: limit * (1 + 0.025),
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
  /** Optional MEXC API keys → filter to account/region-tradable contracts */
  mexcEnv?: MexcAuthEnv
}): Promise<{
  alerts: ScanAlert[]
  watchlist: HotMemeWatchlist
  skipped: string
  scanned: number
  /** Actual scan batch (pump shorts + dump longs). */
  scannedSymbols?: string[]
  rejects: Array<{ symbol: string; reason: string }>
  universeSource?: string
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
  const resolved = opts.mexcEnv
    ? await resolveMemeTradableUniverse(opts.mexcEnv)
    : {
        tradable: await fetchPublicTradableSymbols(),
        source: 'public',
      }
  const tradable = resolved.tradable
  let universeSource = resolved.source
  // Never fall back to raw tickers — that listed RU-missing coins
  if (tradable.size < 30) {
    return {
      alerts: [],
      watchlist: {
        updatedAt: Date.now(),
        dayKey: new Date().toISOString().slice(0, 10),
        entries: [],
        reason: `tradable_too_small:${tradable.size}`,
      },
      skipped: `tradable_too_small:${tradable.size}`,
      scanned: 0,
      rejects: [],
      universeSource,
    }
  }
  let watchlist = await resolveHotMemeWatchlist(opts.kv, tickers, {
    blueChips: BLUE_CHIPS,
    tradable,
    pinSymbols: opts.pinSymbols,
  })

  // Safety net: broken country/account intersection → 0 pumps while market is hot.
  // Fall back to ticker USDT set (pre-universe behavior) so predator isn't silent.
  if (!watchlist.entries.length) {
    const tickerTradable = new Set(
      tickers.filter((t) => t.symbol.endsWith('_USDT')).map((t) => t.symbol)
    )
    const fb = await resolveHotMemeWatchlist(opts.kv, tickers, {
      blueChips: BLUE_CHIPS,
      tradable: tickerTradable,
      pinSymbols: opts.pinSymbols,
    })
    if (fb.entries.length) {
      watchlist = {
        ...fb,
        reason: `fallback_ticker_universe after:${watchlist.reason || 'empty'}`,
      }
      universeSource = `${universeSource}|ticker_fallback`
    }
  }

  if (!watchlist.entries.length) {
    return {
      alerts: [],
      watchlist,
      skipped: watchlist.reason || 'empty_hotlist',
      scanned: 0,
      rejects: [],
      universeSource,
    }
  }

  // Dual meme batch: pumps → SHORT lane, dumps → LONG lane (no alts).
  const pumps = watchlist.entries.filter(
    (e) => e.dayBias === 'PUMP' || e.chg24hPct >= 4
  )
  const dumps = watchlist.entries.filter(
    (e) => e.dayBias === 'DUMP' || e.chg24hPct <= -4
  )
  const isCalmPump = (e: (typeof pumps)[0]) =>
    e.quoteVolUsd >= 800_000 &&
    e.quoteVolUsd <= 20_000_000 &&
    e.chg24hPct >= 5 &&
    e.chg24hPct <= 30
  const rockets = pumps
    .filter((e) => !isCalmPump(e) || e.chg24hPct > 28 || e.quoteVolUsd < 800_000)
    .sort((a, b) => b.chg24hPct - a.chg24hPct || b.score - a.score)
  const calm = pumps
    .filter(isCalmPump)
    .sort((a, b) => b.score - a.score || b.chg24hPct - a.chg24hPct)
  const dumpSorted = [...dumps].sort(
    (a, b) => a.chg24hPct - b.chg24hPct || b.score - a.score
  )

  const shortSlots = Math.ceil(MAX_SCAN * 0.6)
  const longSlots = MAX_SCAN - shortSlots
  const batch: HotMemeEntry[] = []
  const seen = new Set<string>()
  for (const e of rockets.slice(0, Math.ceil(shortSlots * 0.6))) {
    batch.push(e)
    seen.add(e.symbol)
  }
  for (const e of calm) {
    if (batch.filter((x) => x.dayBias !== 'DUMP' && x.chg24hPct >= 0).length >= shortSlots)
      break
    if (seen.has(e.symbol)) continue
    batch.push(e)
    seen.add(e.symbol)
  }
  for (const e of rockets) {
    if (batch.filter((x) => x.dayBias !== 'DUMP' && x.chg24hPct >= 0).length >= shortSlots)
      break
    if (seen.has(e.symbol)) continue
    batch.push(e)
    seen.add(e.symbol)
  }
  for (const e of dumpSorted.slice(0, longSlots)) {
    if (seen.has(e.symbol)) continue
    batch.push(e)
    seen.add(e.symbol)
  }
  // Fill remainder with leftover pumps/dumps
  for (const e of [...rockets, ...dumpSorted]) {
    if (batch.length >= MAX_SCAN) break
    if (seen.has(e.symbol)) continue
    batch.push(e)
    seen.add(e.symbol)
  }
  const state = await loadBookState(opts.kv)
  const pending = await loadPending(opts.kv)
  const rejects: Array<{ symbol: string; reason: string }> = []
  const candidates: ScanAlert[] = []
  const gates = opts.gates ?? null

  type DraftSignal =
    | NonNullable<ReturnType<typeof detectPeakFuelFail>>
    | NonNullable<ReturnType<typeof detectDumpFuelFail>>
    | NonNullable<ReturnType<typeof detectPumpContinue>>

  type PreRow = {
    coin: HotMemeEntry
    price: number
    holdVol: number | null
    prevHold: number | null
    candles: Candle[]
    draft: DraftSignal
  }
  const pre: PreRow[] = []

  async function collectStructureDrafts(
    coins: HotMemeEntry[]
  ): Promise<PreRow[]> {
    const out: PreRow[] = []
    for (const coin of coins) {
      try {
        const prevHold = state[coin.symbol]?.holdVol ?? null
        const tickerRow = tickers.find((t) => t.symbol === coin.symbol)
        const holdVol =
          tickerRow?.holdVol != null ? Number(tickerRow.holdVol) : null
        const price = Number(tickerRow?.lastPrice ?? 0)
        if (holdVol != null) {
          state[coin.symbol] = {
            ...(state[coin.symbol] ?? {}),
            holdVol,
          }
        }
        if (!(price > 0)) {
          rejects.push({ symbol: coin.symbol, reason: 'no_price' })
          continue
        }
        const candles = await fetchMin1Candles(coin.symbol, 150)
        const wantPump = coin.dayBias === 'PUMP' || coin.chg24hPct >= 4
        const wantDump = coin.dayBias === 'DUMP' || coin.chg24hPct <= -4
        let draft: DraftSignal | null = null

        // Pumps: first look for the old short-SL bait → LONG continue
        if (wantPump) {
          draft = detectPumpContinue({
            symbol: coin.symbol,
            price,
            chg24hPct: coin.chg24hPct,
            dayBias: coin.dayBias,
            holdVol,
            prevHoldVol: prevHold,
            candles1m: candles,
          })
          // PEAK short off — former SL zone is now PUMP_CONTINUE LONG TP
          if (!draft?.ready && ALLOW_PEAK_SHORT) {
            draft = detectPeakFuelFail({
              symbol: coin.symbol,
              price,
              chg24hPct: coin.chg24hPct,
              dayBias: coin.dayBias,
              holdVol,
              prevHoldVol: prevHold,
              candles1m: candles,
            })
          }
        }
        if (!draft?.ready && wantDump) {
          draft = detectDumpFuelFail({
            symbol: coin.symbol,
            price,
            chg24hPct: coin.chg24hPct,
            dayBias: coin.dayBias,
            holdVol,
            prevHoldVol: prevHold,
            candles1m: candles,
          })
        }
        if (!draft?.ready) {
          rejects.push({
            symbol: coin.symbol,
            reason: wantDump && !wantPump ? 'no_long_structure' : 'no_setup_structure',
          })
          continue
        }
        out.push({ coin, price, holdVol, prevHold, candles, draft })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        rejects.push({
          symbol: coin.symbol,
          reason: `coin_error:${msg.slice(0, 80)}`,
        })
        if (/subrequest/i.test(msg)) break
      }
    }
    return out
  }

  // Pass 1: structure drafts
  pre.push(...(await collectStructureDrafts(batch)))

  // Pass 2: book ONLY on best structure hits (A requires book_ok)
  const bookQueue = [...pre]
    .sort((a, b) => {
      const score = (d: DraftSignal) =>
        (d.reasons.includes('post_dump') ||
        d.reasons.includes('post_bounce') ||
        d.reasons.includes('continue_ok') ||
        d.reasons.includes('fueled_impulse')
          ? 20
          : 0) + d.confidence
      return score(b.draft) - score(a.draft)
    })
    .slice(0, MAX_BOOK)

  type BookFeed = {
    absorptionShort: boolean
    absorptionLong: boolean
    cvdBearish: boolean
    cvdBullish: boolean
    askHeavy: boolean
    bidHeavy: boolean
    confidence: number
    obi: number
    obiChange: number
    buyFlowPct: number | null
    priceMoveBps: number | null
    kind: string
    ready: boolean
    shortBaitAsks: boolean
    crowdAskLevels: number
    bidSupportUsd: number
  }
  const bookFeed = new Map<string, BookFeed>()

  for (const row of bookQueue) {
    try {
      const prev = state[row.coin.symbol]?.previous ?? null
      const older = state[row.coin.symbol]?.older ?? null
      const read = await readOrderBookEvent({
        symbol: row.coin.symbol,
        previous: prev,
        older,
        allowLiveSequence: true,
        dayBias: row.coin.dayBias,
        chg24hPct: row.coin.chg24hPct,
        mexcJson,
      })
      if (read.snapshot) {
        state[row.coin.symbol] = {
          older: prev,
          previous: read.snapshot,
          holdVol: row.holdVol ?? row.prevHold,
        }
      }
      const ev = read.event
      const obi =
        Number.isFinite(ev.obi) && ev.obi !== 0
          ? ev.obi
          : (read.snapshot?.obi ?? 0)
      const hasTape = ev.ready && (ev.side === 'SHORT' || ev.side === 'LONG')
      const crowd = analyzeCrowdBook(read.snapshot)
      bookFeed.set(row.coin.symbol, {
        absorptionShort:
          ev.kind === 'ABSORPTION_SHORT' ||
          (ev.mmPattern === 'ABSORPTION' && ev.side === 'SHORT'),
        absorptionLong:
          ev.kind === 'ABSORPTION_LONG' ||
          (ev.mmPattern === 'ABSORPTION' && ev.side === 'LONG'),
        cvdBearish: ev.kind === 'CVD_DIVERGENCE' && ev.side === 'SHORT',
        cvdBullish: ev.kind === 'CVD_DIVERGENCE' && ev.side === 'LONG',
        askHeavy: obi <= -12,
        bidHeavy: obi >= 12,
        confidence: ev.confidence,
        obi,
        obiChange: ev.obiChange,
        buyFlowPct: hasTape
          ? ev.side === 'LONG'
            ? ev.flowSharePct
            : Math.max(0, 100 - ev.flowSharePct)
          : null,
        priceMoveBps: hasTape ? ev.priceMoveBps : null,
        kind: ev.kind,
        ready: ev.ready,
        shortBaitAsks: crowd.shortBaitAsks,
        crowdAskLevels: crowd.crowdAskLevels,
        bidSupportUsd: crowd.bidSupportUsd,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rejects.push({
        symbol: row.coin.symbol,
        reason: `book_error:${msg.slice(0, 60)}`,
      })
      if (/subrequest/i.test(msg)) break
    }
  }

  for (const row of pre) {
    try {
      const feed = bookFeed.get(row.coin.symbol)
      const distKey =
        row.draft.setup === 'DUMP_FUEL_FAIL'
          ? (row.draft as NonNullable<ReturnType<typeof detectDumpFuelFail>>)
              .distToLowPct
          : row.draft.distToHighPct
      if (!feed) {
        rejects.push({
          symbol: row.coin.symbol,
          reason: `peak_no_book:${row.draft.confidence}`,
        })
        await appendPeakDecision(opts.kv, {
          at: Date.now(),
          symbol: row.coin.symbol,
          action: 'SKIP_QUALITY',
          confidence: row.draft.confidence,
          quality: 'B',
          reasons: [...row.draft.reasons, 'book_missing', 'no_book_budget'],
          chg24hPct: row.coin.chg24hPct,
          distToHighPct: distKey,
        })
        continue
      }

      const setup = row.draft.setup
      const longBook = {
        buyFlowPct: feed.buyFlowPct,
        priceMoveBps: feed.priceMoveBps,
        absorptionLong: feed.absorptionLong,
        cvdBullish: feed.cvdBullish,
        bidHeavy: feed.bidHeavy,
        bookConfidence: feed.confidence,
        obi: feed.obi,
        obiChange: feed.obiChange,
        shortBaitAsks: feed.shortBaitAsks,
        crowdAskLevels: feed.crowdAskLevels,
        bidSupportUsd: feed.bidSupportUsd,
      }
      const signal =
        setup === 'PUMP_CONTINUE'
          ? detectPumpContinue({
              symbol: row.coin.symbol,
              price: row.price,
              chg24hPct: row.coin.chg24hPct,
              dayBias: row.coin.dayBias,
              holdVol: row.holdVol,
              prevHoldVol: row.prevHold,
              candles1m: row.candles,
              ...longBook,
            })
          : setup === 'DUMP_FUEL_FAIL'
            ? detectDumpFuelFail({
                symbol: row.coin.symbol,
                price: row.price,
                chg24hPct: row.coin.chg24hPct,
                dayBias: row.coin.dayBias,
                holdVol: row.holdVol,
                prevHoldVol: row.prevHold,
                candles1m: row.candles,
                ...longBook,
              })
            : detectPeakFuelFail({
                symbol: row.coin.symbol,
                price: row.price,
                chg24hPct: row.coin.chg24hPct,
                dayBias: row.coin.dayBias,
                holdVol: row.holdVol,
                prevHoldVol: row.prevHold,
                candles1m: row.candles,
                buyFlowPct: feed.buyFlowPct,
                priceMoveBps: feed.priceMoveBps,
                absorptionShort: feed.absorptionShort,
                cvdBearish: feed.cvdBearish,
                askHeavy: feed.askHeavy,
                bookConfidence: feed.confidence,
                obi: feed.obi,
                obiChange: feed.obiChange,
              })

      if (!signal?.ready) {
        rejects.push({
          symbol: row.coin.symbol,
          reason: feed.ready
            ? `no_setup_after_book:${feed.kind}`
            : 'no_setup_book_cold',
        })
        continue
      }

      const setupName = signal.setup
      if (gates) {
        const hist = setupHistoricalWr(gates, setupName)
        if (hist.n >= 8 && hist.wr < 28) {
          rejects.push({
            symbol: row.coin.symbol,
            reason: `hist_dead:${setupName}:${hist.wr.toFixed(0)}%`,
          })
          await appendPeakDecision(opts.kv, {
            at: Date.now(),
            symbol: row.coin.symbol,
            action: 'SKIP_GATES',
            confidence: signal.confidence,
            quality: signal.quality,
            reasons: [
              ...signal.reasons,
              `hist_wr:${hist.wr.toFixed(0)}`,
              `hist_n:${hist.n}`,
            ],
            chg24hPct: row.coin.chg24hPct,
            distToHighPct:
              signal.setup === 'DUMP_FUEL_FAIL'
                ? signal.distToLowPct
                : signal.distToHighPct,
          })
          continue
        }
      }

      // Promote B→A with real book pressure
      if (signal.setup === 'PUMP_CONTINUE') {
        if (
          signal.quality === 'B' &&
          signal.confidence >= 74 &&
          signal.reasons.includes('continue_ok') &&
          signal.reasons.includes('pressure_ok') &&
          signal.reasons.includes('short_trap') &&
          (signal.reasons.includes('squeeze_confirmed') ||
            signal.reasons.includes('book_ok') ||
            signal.reasons.some((r) => r.startsWith('crowd_asks_bait'))) &&
          signal.reasons.some((r) =>
            /^(bid_absorption|cvd_bullish|bid_heavy_strong|bid_heavy|crowd_asks_bait|fueled_impulse|higher_high_break|fake_fade_reclaim)\b/.test(
              r
            )
          )
        ) {
          signal.quality = 'A'
          signal.reasons.push('promote_B_to_A')
        }
      } else if (signal.setup === 'DUMP_FUEL_FAIL') {
        if (
          signal.quality === 'B' &&
          signal.confidence >= 84 &&
          signal.reasons.includes('exhaust_ok') &&
          signal.reasons.includes('tech_ok') &&
          signal.reasons.includes('pressure_ok') &&
          signal.reasons.includes('post_bounce') &&
          signal.reasons.includes('up_confirmed') &&
          signal.reasons.some((r) =>
            /^(bid_absorption|cvd_bullish|bid_heavy_strong)\b/.test(r)
          )
        ) {
          signal.quality = 'A'
          signal.reasons.push('promote_B_to_A')
        }
      } else if (
        signal.quality === 'B' &&
        signal.confidence >= 84 &&
        signal.reasons.includes('exhaust_ok') &&
        signal.reasons.includes('tech_ok') &&
        signal.reasons.includes('post_dump') &&
        signal.reasons.includes('down_confirmed') &&
        signal.reasons.some((r) =>
          /^(ask_absorption|cvd_bearish|ask_heavy_strong)\b/.test(r)
        ) &&
        signal.reasons.some((r) =>
          /^(failed_break|rejection_wick|bearish_trigger)\b/.test(r)
        )
      ) {
        signal.quality = 'A'
        signal.reasons.push('promote_B_to_A')
      }

      const dist =
        signal.setup === 'DUMP_FUEL_FAIL'
          ? signal.distToLowPct
          : signal.distToHighPct

      if (signal.quality !== 'A') {
        rejects.push({
          symbol: row.coin.symbol,
          reason: signal.reasons.includes('book_missing')
            ? `${signal.setup}_blind:${signal.confidence}`
            : `${signal.setup}_B:${signal.confidence}`,
        })
        await appendPeakDecision(opts.kv, {
          at: Date.now(),
          symbol: row.coin.symbol,
          action: 'SKIP_QUALITY',
          confidence: signal.confidence,
          quality: 'B',
          reasons: signal.reasons,
          chg24hPct: row.coin.chg24hPct,
          distToHighPct: dist,
        })
        continue
      }

      const avoid = (gates?.peakAvoidReasons ?? []).filter(
        (t) =>
          t !== 'lower_high' &&
          t !== 'stall_at_high' &&
          t !== 'higher_low' &&
          t !== 'stall_at_low' &&
          t !== 'oi_unknown'
      )
      if (avoid.length) {
        const hit = signal.reasons.find((r) => {
          const tag = r.includes(':') ? r.split(':')[0]! : r
          return avoid.includes(tag)
        })
        if (hit) {
          rejects.push({
            symbol: row.coin.symbol,
            reason: `learn_avoid:${hit}`,
          })
          await appendPeakDecision(opts.kv, {
            at: Date.now(),
            symbol: row.coin.symbol,
            action: 'SKIP_GATES',
            confidence: signal.confidence,
            quality: 'A',
            reasons: [...signal.reasons, `avoid:${hit}`],
            chg24hPct: row.coin.chg24hPct,
            distToHighPct: dist,
          })
          continue
        }
      }

      const prefer = gates?.peakPreferReasons ?? []
      if (prefer.length) {
        const prefHit = signal.reasons.some((r) => {
          const tag = r.includes(':') ? r.split(':')[0]! : r
          return prefer.includes(tag)
        })
        if (prefHit) signal.confidence = Math.min(94, signal.confidence + 3)
      }

      // Wait ~2m + 2 confirming ticks (book+chart still A) before TG/paper
      const gate = armOrReleasePending(pending, {
        symbol: row.coin.symbol,
        setup: signal.setup,
        side: signal.side,
        confidence: signal.confidence,
      })
      if (!gate.release) {
        rejects.push({
          symbol: row.coin.symbol,
          reason: `wait_confirm:${gate.hits}h/${Math.round(gate.waitedMs / 1000)}s`,
        })
        await appendPeakDecision(opts.kv, {
          at: Date.now(),
          symbol: row.coin.symbol,
          action: 'SKIP_QUALITY',
          confidence: signal.confidence,
          quality: 'A',
          reasons: [
            ...signal.reasons,
            `wait_confirm:hits${gate.hits}`,
            `wait_ms:${gate.waitedMs}`,
          ],
          chg24hPct: row.coin.chg24hPct,
          distToHighPct: dist,
        })
        continue
      }
      signal.reasons.push('confirm_2m_ok')

      const alert =
        signal.setup === 'PUMP_CONTINUE'
          ? pumpContinueToAlert(
              row.coin.symbol,
              signal,
              row.coin.dayBias,
              row.coin.chg24hPct
            )
          : signal.setup === 'DUMP_FUEL_FAIL'
            ? dumpFailToAlert(
                row.coin.symbol,
                signal,
                row.coin.dayBias,
                row.coin.chg24hPct
              )
            : peakFailToAlert(
                row.coin.symbol,
                signal,
                row.coin.dayBias,
                row.coin.chg24hPct
              )
      await appendPeakDecision(opts.kv, {
        at: Date.now(),
        symbol: row.coin.symbol,
        action: 'ALERT',
        confidence: signal.confidence,
        quality: 'A',
        reasons: signal.reasons,
        chg24hPct: row.coin.chg24hPct,
        distToHighPct: dist,
      })
      candidates.push(alert)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rejects.push({
        symbol: row.coin.symbol,
        reason: `coin_error:${msg.slice(0, 80)}`,
      })
      if (/subrequest/i.test(msg)) break
    }
  }

  await saveBookState(opts.kv, state)
  await savePending(opts.kv, pending)

  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, MAX_ALERTS)

  return {
    alerts: top,
    watchlist,
    skipped: top.length
      ? ''
      : rejects[0]?.reason
        ? `no_setup · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
        : 'no_peak_or_dump_setup',
    scanned: batch.length,
    scannedSymbols: batch.map((e) => e.symbol),
    rejects: rejects.slice(0, 18),
    universeSource,
  }
}
