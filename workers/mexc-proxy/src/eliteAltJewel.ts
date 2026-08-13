/**
 * Elite ALT_JEWEL — autonomous top-3 liquid alts (NOT Mini App watches, NOT memes).
 *
 * Target: SHORT + LONG scalps · 40% ROE @ 50x = +0.80% price · SL 0.40% (~2R).
 * LONG only if chg24 > −5% (not dump meat-grinder).
 * Jewelry gate: absorb/CVD + OBI align + 1m with us + impulse started (not tip).
 */

import {
  readOrderBookEvent,
  type OrderBookSnapshot,
} from './orderBookReader'
import { memeBookForecast } from './memeBookForecast'
import type { ScanAlert } from './scanner'
import { PREFERRED_ALTS } from './vane/universe'

export const ALT_JEWEL_SETUP = 'ALT_JEWEL'
export const ALT_JEWEL_LEVERAGE = 50
export const ALT_JEWEL_TARGET_ROE_PCT = 40
/** 40% / 50x = 0.80% price */
export const ALT_JEWEL_TP_PCT = ALT_JEWEL_TARGET_ROE_PCT / ALT_JEWEL_LEVERAGE / 100
export const ALT_JEWEL_SL_PCT = 0.004
export const ALT_JEWEL_TOP_N = 3
const MIN_QUOTE_VOL = 8_000_000
const MIN_BOOK_SCORE = 62
const IMPULSE_MIN = 0.28
const IMPULSE_MAX = 0.95
const STATE_KEY = 'scanner:elite_alt_jewel_book_v1'
const DEDUP_MS = 35 * 60_000

type Candle = [number, number, number, number, number, number]

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>
}

type BookState = Record<
  string,
  { previous?: OrderBookSnapshot | null; older?: OrderBookSnapshot | null }
>

const MEXC = 'https://contract.mexc.com'

const ALT_POOL = new Set<string>([
  ...PREFERRED_ALTS,
  'NEAR_USDT',
  'APT_USDT',
  'TON_USDT',
  'ATOM_USDT',
  'UNI_USDT',
  'OP_USDT',
  'ARB_USDT',
  'INJ_USDT',
  'SEI_USDT',
  'TIA_USDT',
  'WLD_USDT',
  'FIL_USDT',
  'AAVE_USDT',
])

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EnterpriseEliteAltJewel/1.0',
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function loadState(kv?: KvLike): Promise<BookState> {
  if (!kv) return {}
  try {
    const raw = await kv.get(STATE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as BookState
  } catch {
    return {}
  }
}

async function saveState(kv: KvLike | undefined, state: BookState): Promise<void> {
  if (!kv) return
  try {
    await kv.put(STATE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function quoteVol(t: {
  symbol?: string
  lastPrice?: string | number
  volume24?: string | number
  amount24?: string | number
}): number {
  const amount = Number(t.amount24 ?? 0)
  if (amount > 0) return amount
  return Number(t.volume24 ?? 0) * Number(t.lastPrice ?? 0)
}

function nameOf(symbol: string): string {
  return symbol.replace('_USDT', '/USDT')
}

async function fetchMin1(symbol: string, limit = 40): Promise<Candle[]> {
  const j = await mexcJson<{
    success?: boolean
    data?: { time?: number[]; open?: number[]; high?: number[]; low?: number[]; close?: number[]; vol?: number[] }
  }>(`/api/v1/contract/kline/${symbol}?interval=Min1`)
  const d = j?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  const n = d.time.length
  for (let i = Math.max(0, n - limit); i < n; i++) {
    out.push([
      d.time[i]! * 1000,
      Number(d.open?.[i] ?? 0),
      Number(d.high?.[i] ?? 0),
      Number(d.low?.[i] ?? 0),
      Number(d.close?.[i] ?? 0),
      Number(d.vol?.[i] ?? 0),
    ])
  }
  return out
}

/** Impulse % over last ~3 closed 1m bars in direction */
function impulsePct(candles: Candle[], side: 'LONG' | 'SHORT'): number {
  const c = candles.length >= 2 ? candles.slice(0, -1) : candles
  if (c.length < 4) return 0
  const w = c.slice(-4)
  const a = w[0]![1]
  const b = w[w.length - 1]![4]
  if (!(a > 0)) return 0
  const pct = ((b - a) / a) * 100
  return side === 'LONG' ? pct : -pct
}

function candleWithUs(candles: Candle[], side: 'LONG' | 'SHORT'): boolean {
  const c = candles.length >= 2 ? candles[candles.length - 2]! : candles[candles.length - 1]
  if (!c) return false
  return side === 'LONG' ? c[4] > c[1] : c[4] < c[1]
}

export async function pickTopAltJewelSymbols(opts?: {
  n?: number
}): Promise<Array<{ symbol: string; price: number; chg24hPct: number; quoteVolUsd: number }>> {
  const n = opts?.n ?? ALT_JEWEL_TOP_N
  const tickers = await mexcJson<{ data?: Array<Record<string, unknown>> }>(
    '/api/v1/contract/ticker'
  )
  const rows = Array.isArray(tickers?.data) ? tickers!.data! : []
  const ranked = rows
    .map((t) => {
      const symbol = String(t.symbol ?? '')
      const price = Number(t.lastPrice ?? 0)
      const chg24hPct = Number(t.riseFallRate ?? 0) * 100
      const qv = quoteVol(t as { lastPrice?: number; volume24?: number; amount24?: number })
      return { symbol, price, chg24hPct, quoteVolUsd: qv }
    })
    .filter(
      (t) =>
        ALT_POOL.has(t.symbol) &&
        t.price > 0 &&
        t.quoteVolUsd >= MIN_QUOTE_VOL &&
        Math.abs(t.chg24hPct) < 25
    )
    .sort((a, b) => b.quoteVolUsd - a.quoteVolUsd)
  return ranked.slice(0, n)
}

export interface EliteAltJewelScanResult {
  alerts: ScanAlert[]
  scanned: string[]
  rejects: Array<{ symbol: string; reason: string }>
}

export async function runEliteAltJewelScan(opts: {
  kv?: KvLike
}): Promise<EliteAltJewelScanResult> {
  const top = await pickTopAltJewelSymbols({ n: ALT_JEWEL_TOP_N })
  const rejects: EliteAltJewelScanResult['rejects'] = []
  const alerts: ScanAlert[] = []
  if (!top.length) {
    return { alerts, scanned: [], rejects: [{ symbol: '-', reason: 'empty_universe' }] }
  }

  const state = await loadState(opts.kv)
  const now = Date.now()

  for (const coin of top) {
    const prev = state[coin.symbol]?.previous ?? null
    const older = state[coin.symbol]?.older ?? null
    let bookSeen = false
    let snap: OrderBookSnapshot | null = null
    let evKind = 'NO_EVENT'
    let evSide: 'LONG' | 'SHORT' | null = null
    let evReady = false
    let evMm: string | null = null
    let tapeBuy: number | null = null
    let tapeMove: number | null = null
    let event: import('./orderBookReader').OrderBookEvent | null = null

    try {
      const read = await readOrderBookEvent({
        symbol: coin.symbol,
        previous: prev,
        older,
        allowLiveSequence: true,
        dayBias: coin.chg24hPct >= 3 ? 'PUMP' : coin.chg24hPct <= -3 ? 'DUMP' : null,
        chg24hPct: coin.chg24hPct,
        mexcJson,
      })
      if (read.snapshot) {
        bookSeen = true
        snap = read.snapshot
        state[coin.symbol] = {
          older: prev,
          previous: read.snapshot,
        }
      }
      event = read.event
      evReady = read.event.ready
      evSide = read.event.side
      evKind = read.event.kind
      evMm = read.event.mmPattern ?? null
      if (read.tape) {
        tapeBuy = read.tape.buyFlowPct
        tapeMove = read.tape.priceMoveBps
      }
    } catch (err) {
      rejects.push({
        symbol: coin.symbol,
        reason: `book_err:${err instanceof Error ? err.message.slice(0, 40) : 'x'}`,
      })
      continue
    }

    if (!bookSeen || !snap) {
      rejects.push({ symbol: coin.symbol, reason: 'no_book' })
      continue
    }

    const candles = await fetchMin1(coin.symbol, 40)
    if (candles.length < 12) {
      rejects.push({ symbol: coin.symbol, reason: 'no_candles' })
      continue
    }

    // Both sides @ ×50 — LONG skipped in dump meat-grinder (chg24 ≤ −5%)
    const sides: Array<'LONG' | 'SHORT'> =
      coin.chg24hPct > -5 ? ['SHORT', 'LONG'] : ['SHORT']

    let best: ScanAlert | null = null
    let bestScore = 0
    let bestReject = 'no_jewel'

    for (const side of sides) {
      const fc = memeBookForecast({
        side,
        bookSeen: true,
        snapshot: snap,
        previous: prev,
        event,
        tapeBuy,
        tapeMoveBps: tapeMove,
        mmPattern: evMm,
        eventKind: evKind,
        eventReady: evReady,
        eventSide: evSide,
        market: 'alt',
      })
      if (fc.toxic) {
        bestReject = `toxic:${fc.reasons.slice(0, 2).join('+')}`
        continue
      }
      if (!fc.realBook || fc.score < MIN_BOOK_SCORE) {
        bestReject = `book:${fc.score}/${fc.bias}`
        continue
      }
      if (fc.bias === 'TRAP' || fc.bias === 'CHOP') {
        bestReject = `bias:${fc.bias}`
        continue
      }
      if (side === 'LONG' && fc.bias !== 'NEXT_UP') {
        bestReject = `bias_mismatch:${fc.bias}`
        continue
      }
      if (side === 'SHORT' && fc.bias !== 'NEXT_DOWN') {
        bestReject = `bias_mismatch:${fc.bias}`
        continue
      }

      const imp = impulsePct(candles, side)
      if (imp < IMPULSE_MIN || imp > IMPULSE_MAX) {
        bestReject =
          imp < IMPULSE_MIN ? `impulse_early:${imp.toFixed(2)}` : `impulse_late:${imp.toFixed(2)}`
        continue
      }
      if (!candleWithUs(candles, side)) {
        bestReject = '1m_against'
        continue
      }

      const entry = coin.price
      const sl =
        side === 'LONG'
          ? entry * (1 - ALT_JEWEL_SL_PCT)
          : entry * (1 + ALT_JEWEL_SL_PCT)
      const tp =
        side === 'LONG'
          ? entry * (1 + ALT_JEWEL_TP_PCT)
          : entry * (1 - ALT_JEWEL_TP_PCT)
      const conf = Math.min(
        94,
        Math.round(58 + fc.score * 0.28 + Math.min(imp, 0.8) * 8)
      )
      if (conf < 72) {
        bestReject = `conf:${conf}`
        continue
      }

      const score = Math.round(fc.score + imp * 10)
      if (score <= bestScore) continue
      bestScore = score

      const icon = side === 'LONG' ? '🟢' : '🔴'
      const ticker = coin.symbol.replace('_USDT', '')
      const reasons = [
        ...fc.reasons.slice(0, 8),
        `impulse:${imp.toFixed(2)}`,
        '1m_with',
        `tp:${(ALT_JEWEL_TP_PCT * 100).toFixed(2)}%`,
        `sl:${(ALT_JEWEL_SL_PCT * 100).toFixed(2)}%`,
        `lev:${ALT_JEWEL_LEVERAGE}`,
        `roe_target:${ALT_JEWEL_TARGET_ROE_PCT}`,
        'quality:A',
      ]

      best = {
        type: 'SNIPER',
        title: `${icon} ALT JEWEL ${side} ${ticker}`,
        text: [
          `💎 <b>Ювелир · топ‑альт</b> · без Mini App`,
          `${nameOf(coin.symbol)} · ${side}`,
          `Вход ~${entry} · SL ${sl.toPrecision(6)} (${(ALT_JEWEL_SL_PCT * 100).toFixed(2)}% против)`,
          `TP ${tp.toPrecision(6)} (${(ALT_JEWEL_TP_PCT * 100).toFixed(2)}% цены ≈ <b>+${ALT_JEWEL_TARGET_ROE_PCT}% @ ×${ALT_JEWEL_LEVERAGE}</b>)`,
          `Стакан score ${fc.score} · ${fc.bias} · impulse ${imp.toFixed(2)}% · conf ${conf}`,
          `Почему: ${reasons.filter((r) => !r.startsWith('quality')).slice(0, 5).join(' · ')}`,
          `Выход: только SL или TP. Короткий скальп · ${side}.`,
        ].join('\n'),
        score: conf,
        dedupeKey: `elite:alt_jewel:${coin.symbol}:${side}:${Math.floor(now / DEDUP_MS)}`,
        tradePlan: {
          side,
          symbol: coin.symbol,
          setup: ALT_JEWEL_SETUP,
          signalPrice: entry,
          entryIdeal: entry,
          zoneLow: side === 'LONG' ? entry * 0.999 : entry,
          zoneHigh: side === 'LONG' ? entry : entry * 1.001,
          invalidate: side === 'LONG' ? entry * 0.996 : entry * 1.004,
          sl,
          tp,
          target1: tp,
          target3: tp,
          alertType: 'SNIPER',
          entryReasons: reasons,
          entryNotes: `ALT JEWEL · ${side} · book ${fc.score} ${fc.bias} · +${ALT_JEWEL_TARGET_ROE_PCT}% @ ×${ALT_JEWEL_LEVERAGE}`,
          qualityTier: 'A',
        },
      }
      bestReject = 'ok'
    }

    if (best) alerts.push(best)
    else rejects.push({ symbol: coin.symbol, reason: bestReject })
  }

  await saveState(opts.kv, state)
  // One jewel per tick max
  alerts.sort((a, b) => b.score - a.score)
  return {
    alerts: alerts.slice(0, 1),
    scanned: top.map((t) => t.symbol),
    rejects,
  }
}
