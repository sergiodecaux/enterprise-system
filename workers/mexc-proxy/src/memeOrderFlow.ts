/**
 * MEME order-flow scanner v26.4 — Day Continue + PEAK_FUEL_FAIL shorts.
 *
 * Coverage: TOP-18 hot memes, deep-scan 16/tick.
 * Emit: CONT_* WITH day + PEAK_FUEL_FAIL (pump stall at local high → small SHORT).
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
import {
  allowSetupByGates,
  isHighWrMemeSetup,
  memeSetupRankScore,
  setupHistoricalWr,
  type BotAdaptiveGates,
} from './botJournal'
import {
  detectPeakFuelFail,
  isPeakFuelFailBookHint,
  type Candle,
} from './peakFuelFail'

const MEXC = 'https://contract.mexc.com'
const BOOK_STATE_KEY = 'scanner:meme_order_flow_v26'
/** Scan full TOP watchlist each tick (was 8 — many coins never checked) */
const MAX_SCAN = 16
/** Prefer quality over spam, but allow 3 high-WR alerts */
const MAX_ALERTS = 3
const MIN_CONF = 84
/** Absorption alone was 0W/1L + 2 dead after v26.1 — require stronger confirm */
const MIN_CONF_ABSORPTION = 92
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
/** Absorption: need clearer tape than pre-v26.2 (was 45) */
const MIN_FLOW_SHARE_ABS = 52
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
  // Exception: PEAK_FUEL_FAIL — SHORT into exhausted pump peak
  const peakFade = isPeakFuelFailBookHint({
    dayBias,
    side: event.side,
    kind: event.kind,
    priceMoveBps: event.priceMoveBps,
    flowSharePct: event.flowSharePct,
  })
  if (dayBias === 'PUMP' && event.side !== 'LONG' && !peakFade) {
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
  if (isAbs && event.flowSharePct < MIN_FLOW_SHARE_ABS) {
    return {
      ok: false,
      reason: `weak_absorption_tape=${event.flowSharePct.toFixed(0)}`,
    }
  }
  // Pure absorption without a wall needs elite conf (CONT_ABSORPTION weak post-v26.1)
  if (isAbs && !isWall && event.confidence < MIN_CONF_ABSORPTION) {
    return {
      ok: false,
      reason: `abs_conf<${MIN_CONF_ABSORPTION}`,
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
  const peakFade = isPeakFuelFailBookHint({
    dayBias,
    side: event.side,
    kind: event.kind,
    priceMoveBps: event.priceMoveBps,
    flowSharePct: event.flowSharePct,
  })
  const side: 'LONG' | 'SHORT' = INVERT_SIDE
    ? detected === 'LONG'
      ? 'SHORT'
      : 'LONG'
    : detected

  const rawSetup = peakFade
    ? 'PEAK_FUEL_FAIL'
    : (
        event.mmPattern ||
        (event.kind === 'ASK_WALL_REMOVED' || event.kind === 'BID_WALL_REMOVED'
          ? 'BOOK_RELEASE'
          : event.kind.replace(/_LONG$|_SHORT$/, ''))
      ).slice(0, 20)
  const setup = (peakFade ? rawSetup : `CONT_${rawSetup}`).slice(0, 32)

  const limit = event.wallPrice && event.wallPrice > 0 ? event.wallPrice : 0
  // Tighter scalp on peak fade shorts
  const lv = peakFade
    ? {
        sl: limit * 1.01,
        tp: limit * (1 - 0.018),
        tp1: limit * (1 - 0.011),
        tp3: limit * (1 - 0.025),
        invalidate: limit * 1.007,
        zoneLow: limit,
        zoneHigh: limit * 1.0008,
      }
    : levelsForSide(side, limit)
  const dayTag =
    dayBias === 'PUMP' ? 'дневной памп' : dayBias === 'DUMP' ? 'дневной дамп' : 'hot'
  const name = symbol.replace('_USDT', '/USDT')

  return {
    type: 'MEME',
    title: `🦈 MEME ${side} ${name} · ${setup}`,
    text: [
      `${dayTag} ${chg24hPct >= 0 ? '+' : ''}${chg24hPct.toFixed(1)}% · ${setup}`,
      peakFade
        ? `Peak fuel fail: SHORT с пика · топливо кончилось`
        : `Day Continue: WITH ${dayBias} · детект ${detected}`,
      `Limit @ ${limit}`,
      `SL ${lv.sl} · TP1 ${lv.tp1} · TP ${lv.tp}`,
      `spread ${event.spreadBps.toFixed(0)}bps · conf ${event.confidence} · flow ${event.flowSharePct.toFixed(0)}%`,
      ...event.notes.slice(0, 3),
      peakFade
        ? 'v26.4: PEAK_FUEL_FAIL — не догонять памп без OI/ленты'
        : 'v26.4: TOP-18 · hist WR · CONT + peak fade',
    ].join('\n'),
    dedupeKey: `cron:mof26:${setup.toLowerCase()}:${symbol}:${side}:${Math.round(limit * 1e6)}`,
    score: event.confidence,
    winPct: Math.min(
      72,
      50 + (event.confidence - 80) + (event.flowSharePct - 50) * 0.15
    ),
    style: 'SCALP',
    align: peakFade ? 'COUNTER' : 'WITH_TREND',
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
      ...sig.notes,
      'v26.4: пик без топлива → небольшой шорт',
    ].join('\n'),
    dedupeKey: `cron:mof26:peak_fuel_fail:${symbol}:SHORT:${Math.round(limit * 1e6)}`,
    score: sig.confidence,
    winPct: Math.min(70, 48 + (sig.confidence - 78)),
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
  limit = 40
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
  /** Journal adaptive gates — prefer highest WR setups */
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

    const dayBias = biasForSymbol(watchlist, coin.symbol)
    const gate = allowMemeFlowEvent(read.event, dayBias)

    let pushed = false
    if (gate.ok) {
      const alert = toAlert(
        coin.symbol,
        read.event,
        coin.dayBias,
        coin.chg24hPct
      )
      if (alert.tradePlan && alert.tradePlan.signalPrice > 0) {
        const setup = alert.tradePlan.setup
        let blocked = false
        if (gates) {
          const ag = allowSetupByGates(gates, setup, alert.score, 'MEME')
          if (!ag.ok) {
            rejects.push({
              symbol: coin.symbol,
              reason: ag.reason ?? 'gates',
            })
            blocked = true
          } else {
            const hist = setupHistoricalWr(gates, setup)
            if (
              hist.n >= 3 &&
              hist.wr < 30 &&
              setup !== 'CONT_BOOK_RELEASE' &&
              setup !== 'PEAK_FUEL_FAIL'
            ) {
              rejects.push({
                symbol: coin.symbol,
                reason: `low_hist_wr:${hist.wr.toFixed(0)}%_n${hist.n}`,
              })
              blocked = true
            } else if (hist.n >= 3) {
              alert.winPct = Math.round(
                Math.min(
                  78,
                  Math.max(42, hist.wr * 0.7 + (alert.winPct ?? 50) * 0.3)
                )
              )
              alert.text = [
                alert.text,
                `Hist WR ${hist.wr.toFixed(0)}% (n=${hist.n}) · rank hunt high-WR`,
              ].join('\n')
            }
          }
        }
        if (!blocked) {
          candidates.push(alert)
          pushed = true
        }
      } else {
        rejects.push({ symbol: coin.symbol, reason: 'no_limit' })
      }
    } else {
      rejects.push({ symbol: coin.symbol, reason: gate.reason })
    }

    // Peak fuel-fail SHORT: pump near local high without fuel
    const bookHintsPeak =
      read.event.kind === 'ABSORPTION_SHORT' ||
      (read.event.kind === 'CVD_DIVERGENCE' && read.event.side === 'SHORT') ||
      gate.reason === 'against_pump_day'
    const wantPeakCheck =
      !pushed &&
      price > 0 &&
      (coin.dayBias === 'PUMP' || coin.chg24hPct >= 8) &&
      (bookHintsPeak || coin.chg24hPct >= 12)
    if (wantPeakCheck) {
      const candles = await fetchMin1Candles(coin.symbol, 40)
      const ev = read.event
      const peak = detectPeakFuelFail({
        symbol: coin.symbol,
        price,
        chg24hPct: coin.chg24hPct,
        dayBias: coin.dayBias,
        holdVol,
        prevHoldVol: prevHold,
        candles1m: candles,
        buyFlowPct:
          ev.side === 'SHORT'
            ? ev.flowSharePct
            : ev.side === 'LONG'
              ? 100 - ev.flowSharePct
              : null,
        priceMoveBps: ev.priceMoveBps,
        absorptionShort:
          ev.kind === 'ABSORPTION_SHORT' ||
          (ev.mmPattern === 'ABSORPTION' && ev.side === 'SHORT'),
        cvdBearish:
          ev.kind === 'CVD_DIVERGENCE' && ev.side === 'SHORT',
      })
      if (peak?.ready) {
        const alert = peakFailToAlert(
          coin.symbol,
          peak,
          coin.dayBias,
          coin.chg24hPct
        )
        if (gates) {
          const ag = allowSetupByGates(
            gates,
            'PEAK_FUEL_FAIL',
            alert.score,
            'MEME'
          )
          if (!ag.ok) {
            rejects.push({
              symbol: coin.symbol,
              reason: ag.reason ?? 'gates_peak',
            })
          } else {
            candidates.push(alert)
          }
        } else {
          candidates.push(alert)
        }
      }
    }
  }

  await saveBookState(opts.kv, state)

  // Sort by historical WR rank (CONT_BOOK_RELEASE first), then confidence
  candidates.sort((a, b) => {
    const ra = memeSetupRankScore(
      gates,
      a.tradePlan?.setup ?? '',
      a.score
    )
    const rb = memeSetupRankScore(
      gates,
      b.tradePlan?.setup ?? '',
      b.score
    )
    if (rb !== ra) return rb - ra
    return b.score - a.score
  })

  // Prefer taking high-WR setups; fill remaining slots with next best
  const high = candidates.filter((a) =>
    isHighWrMemeSetup(gates, a.tradePlan?.setup ?? '')
  )
  const rest = candidates.filter(
    (a) => !isHighWrMemeSetup(gates, a.tradePlan?.setup ?? '')
  )
  const top = [...high, ...rest].slice(0, MAX_ALERTS)

  return {
    alerts: top,
    watchlist,
    skipped: top.length
      ? ''
      : rejects[0]?.reason
        ? `no_ready · e.g. ${rejects[0].symbol}:${rejects[0].reason}`
        : 'no_ready_flow',
    scanned: batch.length,
    rejects: rejects.slice(0, 16),
  }
}
