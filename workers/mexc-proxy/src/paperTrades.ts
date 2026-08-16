/**
 * Example (paper) trades + live market companion commentary.
 * Memes: commentary ≥ every 2 min. Alts: ≥ every 5 min.
 * Comments cover pressure / structure / updated win probability — not fluff.
 */

import {
  applyPredatorOutcome,
  loadPredatorRisk,
  savePredatorRisk,
} from './liquidationEcho'
import {
  applyVaneOutcome,
  loadVaneRisk,
  saveVaneRisk,
  unregisterVaneSymbol,
} from './vane/portfolioRisk'
import {
  isMicroSetup,
  MICRO_BE_MFE_PCT,
  MICRO_BE_R,
  MICRO_TRAIL_AFTER_TP1,
  MICRO_TRAIL_PCT,
} from './vane/microStrategy'
import {
  isMacroSetup,
  MACRO_BE_MFE_PCT,
  MACRO_BE_R,
  MACRO_TRAIL_AFTER_TP1,
  MACRO_TRAIL_PCT,
} from './vane/macroStrategy'
import { rememberMacroOutcome } from './vane/macroMemory'
import {
  ALT_JEWEL_LEVERAGE,
  ALT_JEWEL_SL_PCT,
  ALT_JEWEL_TARGET_ROE_PCT,
  ALT_JEWEL_TP_PCT,
} from './eliteAltJewel'

const PAPER_KEY = 'telegram:paper_trades_v292'
const MAX_ACTIVE = 6
/** One live PEAK at a time — manage it, don't spam */
const MAX_ACTIVE_MEME = 1
/** Same symbol cooldown after open/close */
const MEME_SYMBOL_COOLDOWN_MS = 60 * 60_000
/** Trail width — used only for non-binary (legacy vane) paths */
const MEME_TRAIL_TIGHT = 0.006
const MEME_TRAIL_RUNNER = 0.0045
const MEME_TRAIL_EARLY = 0.01
/** Arm trail / BE after this favorable move (disabled for binary meme exits) */
const MEME_ARM_PCT = 0.0035
/** PEAK: arm only after real MFE — autopsy: early arm → noise exits */
const PEAK_ARM_PCT = 0.007
const PEAK_TRAIL_TIGHT = 0.005
const PEAK_TRAIL_RUNNER = 0.004
const PEAK_TRAIL_EARLY = 0.009
const PEAK_BE_R = 0.55
/** Elite meme LONGs — separate slot from PEAK SHORT */
const MAX_ACTIVE_ELITE_MEME = 1
const ELITE_MEME_SETUPS = new Set(['DUMP_FUEL_FAIL', 'PUMP_CONTINUE'])
function isContSetup(setup?: string | null): boolean {
  return Boolean(setup?.startsWith('CONT_'))
}
function isPredatorShortSetup(setup: string, side?: string): boolean {
  return (
    setup === 'PEAK_FUEL_FAIL' ||
    setup === 'DUMP_CONTINUATION' ||
    (isContSetup(setup) && (!side || side === 'SHORT'))
  )
}
function isEliteMemeLongSetup(setup: string, side?: string): boolean {
  return (
    ELITE_MEME_SETUPS.has(setup) ||
    (isContSetup(setup) && (!side || side === 'LONG'))
  )
}
/** Elite liquid-alt jewelry scalps (independent of Mini App) */
const MAX_ACTIVE_ALT_JEWEL = 1
const ALT_JEWEL_SETUP = 'ALT_JEWEL'
const ALT_JEWEL_COOLDOWN_MS = 45 * 60_000
/** Partial lock at ~1R (TP1) then trail remainder */
const MEME_PARTIAL_R = 1.0
/**
 * Meme structural exit: TP1 0.8% (lock BE) → TP2 2.0% (40% ROE @ ×20).
 * Soft floors only after proven MFE / TP1.
 */
export const MEME_TARGET_ROE_PCT = 40
export const MEME_ASSUMED_LEVERAGE = 20
export const MEME_TP_PRICE_PCT =
  MEME_TARGET_ROE_PCT / MEME_ASSUMED_LEVERAGE / 100
/** Partial take — then BE, hunt TP2 */
export const MEME_TP1_PRICE_PCT = 0.008
const MEME_TP1_BE_BUF = 0.001
/** Don't time-stop open meme if already this much in profit (need room for +2% TP) */
const MEME_TIMEOUT_SKIP_PNL_PCT = 0.8
/** PEAK: after this MFE, floor SL to BE±0.2% (no trail, just stop give-back) */
const PEAK_FLOOR_MFE_PCT = 1.0
const PEAK_FLOOR_BE_BUF = 0.002
const PREDATOR_SHORT_SETUPS = new Set([
  'PEAK_FUEL_FAIL',
  'DUMP_CONTINUATION',
])
/** PUMP: flat dead cut — earlier than SL race on tight stops */
const PUMP_DEAD_AFTER_MS = 6 * 60_000
const PUMP_DEAD_MFE_PCT = 0.25
const WAITING_TTL_MS = 90 * 60_000
/** Vane HOLD can wait for zone reclaim longer (v4 scalp+wait) */
const WAITING_TTL_VANE_MS = 240 * 60_000
const OPEN_TTL_MS = 6 * 60 * 60_000
/** Hold for +2% TP; extend further if already green (see timeout skip) */
const OPEN_TTL_MEME_MS = 6 * 60 * 60_000
const OPEN_TTL_MEME_EXTEND_MS = 3 * 60 * 60_000
/** Alt jewel SHORT scalp @×50 — room for +0.8% without overnight */
const OPEN_TTL_ALT_JEWEL_MS = 90 * 60_000
const OPEN_TTL_ALT_JEWEL_EXTEND_MS = 45 * 60_000
/** MICRO scalp — small TP, don't overnight */
const OPEN_TTL_MICRO_MS = 55 * 60_000
/** MACRO move — ride body of the move */
const OPEN_TTL_MACRO_MS = 3 * 60 * 60_000
/** Arm MICRO trail after this MFE % */
const MICRO_ARM_PCT = MICRO_BE_MFE_PCT / 100
const MACRO_ARM_PCT = MACRO_BE_MFE_PCT / 100
/** Quiet WAIT companion — no 5m spam */
const PULSE_WAIT_MS = 45 * 60_000
/** Predator echo: impulse dies in seconds */
const OPEN_TTL_ECHO_MS = 90_000
const ECHO_TIME_STOP_MS = 12_000
/** Meme setups — less chat noise; stats still resolve every cron */
const PULSE_MEME_MS = 6 * 60_000
/** Regular alts / sniper — every ~5 min */
const PULSE_ALT_MS = 5 * 60_000
const MEXC = 'https://contract.mexc.com'

export type PaperSide = 'LONG' | 'SHORT'
export type PaperStatus = 'WAITING' | 'OPEN' | 'CLOSED'
export type AlertKind = 'SNIPER' | 'MEME'

export interface TradePlan {
  side: PaperSide
  symbol: string
  setup: string
  signalPrice: number
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
  target1?: number
  target3?: number
  alertType: AlertKind
  vanePath?: 'HOLD' | 'FLIP'
  vaneTier?: 'TIER1' | 'TIER2'
  vaneScore?: number
  /** Why signal fired — persisted for autopsy */
  entryReasons?: string[]
  entryNotes?: string
  qualityTier?: 'A' | 'B'
  /** Skip extra MEXC ticker fetch when caller already has mark */
  markPrice?: number
}

export interface PaperTrade {
  id: string
  symbol: string
  side: PaperSide
  setup: string
  alertType: AlertKind
  signalPrice: number
  zoneLow: number
  zoneHigh: number
  entryIdeal: number
  invalidate: number
  sl: number
  tp: number
  target1?: number | null
  target3?: number | null
  status: PaperStatus
  fillPrice: number | null
  /** First zone touch; a trade opens only after directional reclaim. */
  zoneTouchedAt?: number | null
  zoneTouchPrice?: number | null
  peak: number | null
  trailingStop: number | null
  createdAt: number
  openedAt: number | null
  expiresAt: number
  closedAt: number | null
  lastPulseAt: number | null
  closeReason: string | null
  beSent: boolean
  tpSent: boolean
  /** Partial TP1 hit — BE locked, runner continues */
  tp1Sent?: boolean
  /** Peak favorable OBI while open (for structural OBI-flip exit) */
  peakObi?: number | null
  trailMovedSent: boolean
  waitingAnnounced: boolean
  /** Last published success probability 0–100 */
  lastWinPct: number | null
  vanePath?: 'HOLD' | 'FLIP'
  vaneTier?: 'TIER1' | 'TIER2'
  vaneScore?: number
  entryReasons?: string[]
  entryNotes?: string
  qualityTier?: 'A' | 'B'
}

export interface PaperComment {
  title: string
  text: string
  dedupeKey: string
  alertType: AlertKind | 'SYSTEM'
  /** Telegram bot channel: meme Predator bot vs sniper/alts bot */
  route?: 'meme' | 'sniper'
  /** When set, meme TG skips non-PEAK companion noise */
  setup?: string
}

interface PaperEnv {
  SUBSCRIBERS?: KVNamespace
}

interface TickerSnap {
  last: number
  high: number
  low: number
  bid1: number
  ask1: number
  fundingRate: number | null
  amount24: number
}

interface MarketBrief {
  buyShare: number
  sellShare: number
  pressure: 'BUYERS' | 'SELLERS' | 'MIXED'
  pressureLabel: string
  candleBias: 'UP' | 'DOWN' | 'CHOP'
  volMult: number
  move1mPct: number
  /** Slope of last ~5 closes in % */
  move5mPct: number
  /** Order book imbalance −100…+100 (bids heavy → +) */
  bookImb: number | null
  spreadBps: number
  fundingPct: number | null
}

const memoryPapers: PaperTrade[] = []

function paperCacheRequest(): Request {
  return new Request('https://enterprise-system-runtime.invalid/paper-trades-v292')
}

async function readPaperCache(): Promise<PaperTrade[] | null> {
  try {
    const response = await caches.default.match(paperCacheRequest())
    if (!response) return null
    return (await response.json()) as PaperTrade[]
  } catch {
    return null
  }
}

async function writePaperCache(list: PaperTrade[]): Promise<void> {
  try {
    await caches.default.put(
      paperCacheRequest(),
      new Response(JSON.stringify(list), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      })
    )
  } catch {
    // Memory remains available in a warm isolate.
  }
}

function fmt(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(6)
  return p.toFixed(8)
}

function pctFromEntry(entry: number, level: number): string {
  if (!(entry > 0)) return '—'
  const p = ((level - entry) / entry) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
}

function pnlPct(side: PaperSide, entry: number, price: number): number {
  if (!(entry > 0)) return 0
  return side === 'LONG'
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100
}

function nameOf(symbol: string): string {
  return symbol.replace('_USDT', '/USDT')
}

function riskUnit(t: PaperTrade): number {
  const entry = t.fillPrice ?? t.entryIdeal
  return Math.abs(entry - t.sl)
}

const MEME_MAX_RISK = 0.011
const MEME_MIN_RISK = 0.0075

/**
 * Always rebuild SL/TP from CURRENT entry using risk%.
 * Prevents absolute scan-time / “former SL” levels sticking to a new fill.
 */
export function rebaseMemeLevels(opts: {
  entry: number
  side: 'LONG' | 'SHORT'
  refEntry?: number
  refSl?: number
}): {
  sl: number
  tp: number
  target1: number
  target3: number
  riskPct: number
} {
  const entry = opts.entry
  let riskPct = 0.008
  if (
    opts.refEntry != null &&
    opts.refEntry > 0 &&
    opts.refSl != null &&
    opts.refSl > 0
  ) {
    riskPct = Math.abs(opts.refEntry - opts.refSl) / opts.refEntry
  }
  riskPct = Math.min(MEME_MAX_RISK, Math.max(MEME_MIN_RISK, riskPct))
  if (opts.side === 'LONG') {
    return {
      sl: entry * (1 - riskPct),
      target1: entry * (1 + riskPct * 1.15),
      tp: entry * (1 + riskPct * 2.2),
      target3: entry * (1 + riskPct * 2.8),
      riskPct,
    }
  }
  return {
    sl: entry * (1 + riskPct),
    target1: entry * (1 - riskPct * 1.15),
    tp: entry * (1 - riskPct * 2.2),
    target3: entry * (1 - riskPct * 2.8),
    riskPct,
  }
}

function pulseMs(t: PaperTrade): number {
  if (t.alertType === 'MEME') return PULSE_MEME_MS
  // Kill WAIT zone chatter — legacy VANE_WAIT papers stay almost silent
  if (t.setup.startsWith('VANE_WAIT_') && t.status === 'WAITING') {
    return PULSE_WAIT_MS
  }
  return PULSE_ALT_MS
}

function isMemeTrade(t: PaperTrade): boolean {
  return (
    t.alertType === 'MEME' ||
    (t.alertType === 'SNIPER' && isEliteMemeLongSetup(t.setup, t.side))
  )
}

function isAltJewel(t: PaperTrade | { setup?: string }): boolean {
  return t.setup === ALT_JEWEL_SETUP
}

/** PEAK / Elite meme: only initial SL or +2% TP (40% @ ×20). */
function isBinaryRoeExit(t: PaperTrade): boolean {
  return isMemeTrade(t) || isAltJewel(t)
}

function binaryTpPct(t: PaperTrade): number {
  return isAltJewel(t) ? ALT_JEWEL_TP_PCT : MEME_TP_PRICE_PCT
}

function binaryTargetRoe(t: PaperTrade): number {
  return isAltJewel(t) ? ALT_JEWEL_TARGET_ROE_PCT : MEME_TARGET_ROE_PCT
}

function binaryLeverage(t: PaperTrade): number {
  return isAltJewel(t) ? ALT_JEWEL_LEVERAGE : MEME_ASSUMED_LEVERAGE
}

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'EnterpriseSystem/2.0' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchTickerSnap(symbol: string): Promise<TickerSnap | null> {
  const json = await mexcJson<{
    data:
      | {
          lastPrice?: number
          bid1?: number
          ask1?: number
          fundingRate?: number
          amount24?: number
          volume24?: number
        }
      | Array<{
          lastPrice?: number
          bid1?: number
          ask1?: number
          fundingRate?: number
          amount24?: number
        }>
  }>(`/api/v1/contract/ticker?symbol=${symbol}`)

  const row = Array.isArray(json?.data) ? json?.data[0] : json?.data
  if (!row) return null
  const last = Number(row.lastPrice)
  if (!(last > 0)) return null

  // Only current Min1 — 3-bar lookback was awarding TP from pre-entry wicks.
  const k = await mexcJson<{
    data: { high: number[]; low: number[]; close: number[] }
  }>(`/api/v1/contract/kline/${symbol}?interval=Min1&limit=1`)

  let high = last
  let low = last
  const hs = k?.data?.high
  const ls = k?.data?.low
  if (hs?.length && ls?.length) {
    high = Math.max(Number(hs[hs.length - 1]), last)
    low = Math.min(Number(ls[ls.length - 1]), last)
  }

  return {
    last,
    high,
    low,
    bid1: Number(row.bid1 ?? last),
    ask1: Number(row.ask1 ?? last),
    fundingRate:
      row.fundingRate != null && !Number.isNaN(Number(row.fundingRate))
        ? Number(row.fundingRate)
        : null,
    amount24: Number(row.amount24 ?? row.volume24 ?? 0),
  }
}

async function fetchMarketBrief(
  symbol: string,
  snap: TickerSnap
): Promise<MarketBrief> {
  const [klines, deals, depth] = await Promise.all([
    mexcJson<{
      data: {
        open: number[]
        high: number[]
        low: number[]
        close: number[]
        vol: number[]
      }
    }>(`/api/v1/contract/kline/${symbol}?interval=Min1&limit=20`),
    mexcJson<{
      data: Array<{ p: number; v: number; T: number; O?: number }>
    }>(`/api/v1/contract/deals/${symbol}?limit=60`),
    mexcJson<{
      data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
    }>(`/api/v1/contract/depth/${symbol}?limit=20`),
  ])

  const o = klines?.data?.open?.map(Number) ?? []
  const c = klines?.data?.close?.map(Number) ?? []
  const v = klines?.data?.vol?.map(Number) ?? []

  let up = 0
  let down = 0
  for (let i = Math.max(0, c.length - 8); i < c.length; i++) {
    if (c[i] >= o[i]) up++
    else down++
  }
  const candleBias: MarketBrief['candleBias'] =
    up >= down + 2 ? 'UP' : down >= up + 2 ? 'DOWN' : 'CHOP'

  const recent = v.slice(-5)
  const base = v.slice(-15, -5)
  const avgBase =
    base.length > 0 ? base.reduce((s, x) => s + x, 0) / base.length : 0
  const avgRecent =
    recent.length > 0 ? recent.reduce((s, x) => s + x, 0) / recent.length : 0
  const volMult = avgBase > 0 ? avgRecent / avgBase : 1

  const lastO = o[o.length - 1] ?? snap.last
  const lastC = c[c.length - 1] ?? snap.last
  const move1mPct = lastO > 0 ? ((lastC - lastO) / lastO) * 100 : 0

  const c5 = c.length >= 6 ? c[c.length - 6] : c[0] ?? snap.last
  const move5mPct = c5 > 0 ? ((lastC - c5) / c5) * 100 : 0

  // MEXC deals: T=1 taker buy, T=2 taker sell
  let buyVol = 0
  let sellVol = 0
  const rows = deals?.data ?? []
  for (const d of rows) {
    const vol = Number(d.v ?? 0) * Number(d.p ?? 0)
    const side = d.T ?? d.O
    if (side === 1 || side === 2) {
      if (side === 1) buyVol += vol
      else sellVol += vol
    } else {
      if (Number(d.p) >= snap.last) buyVol += vol
      else sellVol += vol
    }
  }
  const tot = buyVol + sellVol
  const buyShare = tot > 0 ? buyVol / tot : 0.5
  const sellShare = 1 - buyShare

  let pressure: MarketBrief['pressure'] = 'MIXED'
  if (buyShare >= 0.58) pressure = 'BUYERS'
  else if (sellShare >= 0.58) pressure = 'SELLERS'

  // If price is ripping one way, trust candles over noisy tape
  if (move5mPct >= 0.45 && candleBias === 'UP' && pressure === 'SELLERS') {
    pressure = 'MIXED'
  }
  if (move5mPct <= -0.45 && candleBias === 'DOWN' && pressure === 'BUYERS') {
    pressure = 'MIXED'
  }

  const pressureLabel =
    pressure === 'BUYERS'
      ? `Покупатели давят (${(buyShare * 100).toFixed(0)}% taker buy)`
      : pressure === 'SELLERS'
        ? `Продавцы давят (${(sellShare * 100).toFixed(0)}% taker sell)`
        : `Баланс сил (~${(buyShare * 100).toFixed(0)}/${(sellShare * 100).toFixed(0)} buy/sell)`

  const mid = (snap.bid1 + snap.ask1) / 2
  const spreadBps = mid > 0 ? ((snap.ask1 - snap.bid1) / mid) * 10_000 : 0

  let bookImb: number | null = null
  const asks = depth?.data?.asks ?? []
  const bids = depth?.data?.bids ?? []
  if (asks.length && bids.length) {
    let askVol = 0
    let bidVol = 0
    for (const a of asks) askVol += Number(a[1] ?? 0)
    for (const b of bids) bidVol += Number(b[1] ?? 0)
    const bookTot = askVol + bidVol
    if (bookTot > 0) bookImb = ((bidVol - askVol) / bookTot) * 100
  }

  return {
    buyShare,
    sellShare,
    pressure,
    pressureLabel,
    candleBias,
    volMult,
    move1mPct,
    move5mPct,
    bookImb,
    spreadBps,
    fundingPct: snap.fundingRate != null ? snap.fundingRate * 100 : null,
  }
}

/**
 * Live success probability — driven by price path, momentum strength, book.
 * Hysteresis vs lastWinPct so it doesn't collapse on one noisy tape print.
 */
function computeWinPct(
  t: PaperTrade,
  price: number,
  brief: MarketBrief
): { winPct: number; factors: string[] } {
  const factors: string[] = []
  const entry = t.fillPrice ?? t.entryIdeal
  const risk = Math.abs(entry - t.sl)
  const reward = Math.abs(t.tp - entry)
  const open = t.status === 'OPEN' && t.fillPrice != null

  // ── 1) Path / R-multiple (primary for OPEN) ─────────────────────
  let score = open ? 60 : 54

  if (open && risk > 0) {
    const rMult =
      t.side === 'LONG' ? (price - entry) / risk : (entry - price) / risk
    const tpProgress =
      reward > 0
        ? t.side === 'LONG'
          ? (price - entry) / reward
          : (entry - price) / reward
        : 0

    if (rMult >= 1.2) {
      score = 78 + Math.min(8, (rMult - 1.2) * 4)
      factors.push(`в плюсе +${rMult.toFixed(1)}R · сила хода`)
    } else if (rMult >= 0.35) {
      score = 66 + Math.min(12, rMult * 10)
      factors.push(`к цели ${(Math.max(0, tpProgress) * 100).toFixed(0)}% · +${rMult.toFixed(2)}R`)
    } else if (rMult >= 0) {
      score = 60 + rMult * 14
      factors.push(`чуть в плюсе +${rMult.toFixed(2)}R`)
    } else if (rMult > -0.45) {
      score = 58 + rMult * 18
      factors.push(`откат ${rMult.toFixed(2)}R от входа`)
    } else {
      score = 52 + Math.max(-26, rMult * 22)
      factors.push(`к стопу ${Math.abs(rMult).toFixed(2)}R`)
    }
  } else if (!open && risk > 0) {
    // WAITING: closer to zone = better; price running away from zone hurts
    const zoneMid = (t.zoneLow + t.zoneHigh) / 2
    const distPct = ((price - zoneMid) / price) * 100
    const approaching =
      (t.side === 'LONG' && price >= t.zoneLow * 0.997 && price <= t.zoneHigh * 1.01) ||
      (t.side === 'SHORT' && price <= t.zoneHigh * 1.003 && price >= t.zoneLow * 0.99)
    if (approaching) {
      score = 64
      factors.push('цена у зоны входа')
    } else if (t.side === 'LONG' && distPct > 1.2) {
      score = 48
      factors.push(`ушла вверх от зоны (+${distPct.toFixed(1)}%) — жду откат`)
    } else if (t.side === 'SHORT' && distPct < -1.2) {
      score = 48
      factors.push(`ушла вниз от зоны (${distPct.toFixed(1)}%) — жду откат`)
    } else {
      score = 56
      factors.push(`до зоны ${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%`)
    }
  }

  // ── 2) Momentum / strength of the move ──────────────────────────
  const momWith =
    (t.side === 'LONG' && brief.move5mPct >= 0.25 && brief.move1mPct >= -0.05) ||
    (t.side === 'SHORT' && brief.move5mPct <= -0.25 && brief.move1mPct <= 0.05)
  const momAgainst =
    (t.side === 'LONG' && brief.move5mPct <= -0.35) ||
    (t.side === 'SHORT' && brief.move5mPct >= 0.35)
  const strongTrend =
    (t.side === 'LONG' && brief.move5mPct >= 0.6 && brief.candleBias !== 'DOWN') ||
    (t.side === 'SHORT' && brief.move5mPct <= -0.6 && brief.candleBias !== 'UP')

  if (strongTrend) {
    score += open ? 12 : 4
    factors.push(
      `сильный ход ${brief.move5mPct >= 0 ? '+' : ''}${brief.move5mPct.toFixed(2)}% /5м`
    )
  } else if (momWith) {
    score += open ? 8 : 3
    factors.push(
      `импульс с нами ${brief.move5mPct >= 0 ? '+' : ''}${brief.move5mPct.toFixed(2)}%`
    )
  } else if (momAgainst && !(open && score >= 70)) {
    // Don't punish a winning runner for a shallow pullback print
    score -= open ? 6 : 8
    factors.push(
      `импульс против ${brief.move5mPct >= 0 ? '+' : ''}${brief.move5mPct.toFixed(2)}%`
    )
  }

  if (
    (t.side === 'LONG' && brief.candleBias === 'UP') ||
    (t.side === 'SHORT' && brief.candleBias === 'DOWN')
  ) {
    score += 5
    factors.push('свечи 1м за нас')
  } else if (
    (t.side === 'LONG' && brief.candleBias === 'DOWN' && !momWith) ||
    (t.side === 'SHORT' && brief.candleBias === 'UP' && !momWith)
  ) {
    score -= 4
    factors.push('свечи 1м против')
  }

  // ── 3) Order book ───────────────────────────────────────────────
  if (brief.bookImb != null) {
    const bookWith =
      (t.side === 'LONG' && brief.bookImb >= 12) ||
      (t.side === 'SHORT' && brief.bookImb <= -12)
    const bookAgainst =
      (t.side === 'LONG' && brief.bookImb <= -20) ||
      (t.side === 'SHORT' && brief.bookImb >= 20)
    if (bookWith) {
      score += 7
      factors.push(
        `стакан за нас (OBI ${brief.bookImb >= 0 ? '+' : ''}${brief.bookImb.toFixed(0)}%)`
      )
    } else if (bookAgainst && !strongTrend) {
      score -= 6
      factors.push(
        `стакан против (OBI ${brief.bookImb >= 0 ? '+' : ''}${brief.bookImb.toFixed(0)}%)`
      )
    } else {
      factors.push(
        `стакан OBI ${brief.bookImb >= 0 ? '+' : ''}${brief.bookImb.toFixed(0)}%`
      )
    }
  }

  // ── 4) Tape — soft, never override strong price trend ───────────
  const flowWithUs =
    (t.side === 'LONG' && brief.pressure === 'BUYERS') ||
    (t.side === 'SHORT' && brief.pressure === 'SELLERS')
  const flowAgainst =
    (t.side === 'LONG' && brief.pressure === 'SELLERS') ||
    (t.side === 'SHORT' && brief.pressure === 'BUYERS')

  if (flowWithUs) {
    score += 6
    factors.push('лента с нами')
  } else if (flowAgainst && !strongTrend && !momWith) {
    score -= 5
    factors.push('лента против')
  } else if (flowAgainst && (strongTrend || momWith)) {
    factors.push('лента шумная, но цена/сила за нас')
  } else {
    factors.push('лента нейтральна')
  }

  if (brief.volMult >= 1.8 && (flowWithUs || momWith || strongTrend)) {
    score += 4
    factors.push(`объём ×${brief.volMult.toFixed(1)}`)
  }

  if (t.beSent) {
    score += 3
    factors.push('стоп в BE')
  }

  // Floor: winning + momentum must not look like a loser
  if (open && risk > 0) {
    const rMult =
      t.side === 'LONG' ? (price - entry) / risk : (entry - price) / risk
    if (rMult > 0.15 && (momWith || strongTrend || flowWithUs)) {
      score = Math.max(score, 68)
    }
    if (rMult > 0.5 && (strongTrend || brief.candleBias !== (t.side === 'LONG' ? 'DOWN' : 'UP'))) {
      score = Math.max(score, 74)
    }
  }

  let winPct = Math.round(Math.min(90, Math.max(28, score)))

  // Hysteresis vs last published — avoid 80→46 whiplash
  if (t.lastWinPct != null) {
    const prev = t.lastWinPct
    const nearSl =
      open &&
      risk > 0 &&
      (t.side === 'LONG'
        ? (entry - price) / risk > 0.55
        : (price - entry) / risk > 0.55)
    const maxStep = nearSl ? 14 : strongTrend || momWith ? 8 : 10
    if (winPct > prev + maxStep) winPct = prev + maxStep
    if (winPct < prev - maxStep) winPct = prev - maxStep
    // Blend slightly toward fresh read
    winPct = Math.round(winPct * 0.65 + prev * 0.35)
  }

  return { winPct: Math.round(Math.min(90, Math.max(28, winPct))), factors: factors.slice(0, 6) }
}

function buildCommentary(opts: {
  t: PaperTrade
  price: number
  brief: MarketBrief
  winPct: number
  prevWin: number | null
  factors: string[]
  phase: 'WAITING' | 'OPEN'
}): PaperComment {
  const { t, price, brief, winPct, prevWin, factors, phase } = opts
  const entry = t.fillPrice ?? t.entryIdeal
  const unreal =
    phase === 'OPEN' && t.fillPrice != null
      ? pnlPct(t.side, t.fillPrice, price)
      : null
  const delta =
    prevWin != null ? winPct - prevWin : 0
  const deltaStr =
    prevWin == null
      ? ''
      : delta > 0
        ? `↑ +${delta}`
        : delta < 0
          ? `↓ ${delta}`
          : '→ 0'

  const distTp =
    t.side === 'LONG'
      ? ((t.tp - price) / price) * 100
      : ((price - t.tp) / price) * 100
  const distSl =
    t.side === 'LONG'
      ? ((price - t.sl) / price) * 100
      : ((t.sl - price) / price) * 100

  const actionHint =
    winPct >= 72
      ? 'Ход за нас — держу план, не мешаю прибыли.'
      : winPct >= 58
        ? 'Пока ок. Без догона — только по плану.'
        : winPct >= 42
          ? 'Преимущество слабеет. Ближе к стопу — без усреднения.'
          : 'Сценарий слабый. Стоп — нормальный исход риска.'

  const title =
    phase === 'WAITING'
      ? `👁 Пример ${nameOf(t.symbol)} · жду зону`
      : `📡 Пример ${t.side} ${nameOf(t.symbol)}`

  const bookLine =
    brief.bookImb != null
      ? `Стакан OBI ${brief.bookImb >= 0 ? '+' : ''}${brief.bookImb.toFixed(0)}%`
      : 'Стакан: н/д'

  const lines = [
    `Учебная (бумажная) сделка · ${t.setup} · ${isMemeTrade(t) ? 'MEME 2м' : 'ALT 5м'}`,
    phase === 'WAITING'
      ? `Статус: жду лимитку ${fmt(t.zoneLow)}–${fmt(t.zoneHigh)}`
      : `Вход ${fmt(entry)} · сейчас ${fmt(price)} · uPnL ${unreal != null && unreal >= 0 ? '+' : ''}${unreal?.toFixed(2) ?? '—'}%`,
    '',
    `🎯 Вероятность успеха: ${winPct}%${deltaStr ? ` (${deltaStr} п.п.)` : ''}`,
    `Факторы: ${factors.join('; ') || '—'}`,
    '',
    brief.pressureLabel,
    bookLine,
    `Цена: 1м ${brief.move1mPct >= 0 ? '+' : ''}${brief.move1mPct.toFixed(2)}% · 5м ${brief.move5mPct >= 0 ? '+' : ''}${brief.move5mPct.toFixed(2)}% · свечи ${brief.candleBias} · vol ×${brief.volMult.toFixed(1)}`,
    brief.fundingPct != null
      ? `Funding: ${brief.fundingPct.toFixed(3)}% · спред ~${brief.spreadBps.toFixed(0)} bps`
      : `Спред ~${brief.spreadBps.toFixed(0)} bps`,
    `До цели ~${distTp.toFixed(2)}% · до стопа ~${distSl.toFixed(2)}%`,
    '',
    actionHint,
  ]

  return {
    alertType: 'SYSTEM',
    route: t.alertType === 'SNIPER' ? 'sniper' : 'meme',
    title,
    text: lines.join('\n'),
    dedupeKey: `paper:pulse:${t.id}:${Math.floor(Date.now() / pulseMs(t))}`,
  }
}

export async function listPaperTrades(env: PaperEnv): Promise<PaperTrade[]> {
  const cached = await readPaperCache()
  if (cached) return cached
  if (!env.SUBSCRIBERS) return [...memoryPapers]
  const raw = await env.SUBSCRIBERS.get(PAPER_KEY)
  if (!raw) return [...memoryPapers]
  try {
    return JSON.parse(raw) as PaperTrade[]
  } catch {
    return [...memoryPapers]
  }
}

/** Close leftover dual LONG / non-PEAK meme papers so slots stay for PEAK SHORT. */
export async function closeNonPeakMemePapers(env: PaperEnv): Promise<number> {
  const list = await listPaperTrades(env)
  const now = Date.now()
  let n = 0
  for (const t of list) {
    if (t.alertType !== 'MEME') continue
    if (t.status !== 'WAITING' && t.status !== 'OPEN') continue
    if (isPredatorShortSetup(t.setup, t.side) && t.side === 'SHORT') continue
    t.status = 'CLOSED'
    t.closedAt = now
    t.closeReason = 'non_peak_purged'
    n++
  }
  if (n) await savePaperTrades(env, list)
  return n
}

/** Close all open/waiting meme papers (stats reset / clean lab). */
export async function closeAllMemePapers(env: PaperEnv): Promise<number> {
  const list = await listPaperTrades(env)
  const now = Date.now()
  let n = 0
  for (const t of list) {
    if (t.alertType !== 'MEME') continue
    if (t.status !== 'WAITING' && t.status !== 'OPEN') continue
    t.status = 'CLOSED'
    t.closedAt = now
    t.closeReason = 'stats_reset'
    n++
  }
  if (n) await savePaperTrades(env, list)
  return n
}

/** Close every open/waiting paper (full lab reset). */
export async function closeAllLabPapers(env: PaperEnv): Promise<number> {
  const list = await listPaperTrades(env)
  const now = Date.now()
  let n = 0
  for (const t of list) {
    if (t.status !== 'WAITING' && t.status !== 'OPEN') continue
    t.status = 'CLOSED'
    t.closedAt = now
    t.closeReason = 'stats_reset'
    n++
  }
  if (n) await savePaperTrades(env, list)
  return n
}

async function savePaperTrades(
  env: PaperEnv,
  list: PaperTrade[]
): Promise<void> {
  memoryPapers.length = 0
  memoryPapers.push(...list)
  await writePaperCache(list)
  try {
    await env.SUBSCRIBERS?.put(PAPER_KEY, JSON.stringify(list))
  } catch {
    /* quota */
  }
}

function activeCount(list: PaperTrade[]): number {
  return list.filter((t) => t.status === 'WAITING' || t.status === 'OPEN').length
}

export async function createPaperTradeFromPlan(
  env: PaperEnv,
  plan: TradePlan
): Promise<{
  created: boolean
  comment: PaperComment | null
  skipReason?: 'cooldown' | 'caps' | 'dup' | 'bad_mark' | 'pre_stopped' | 'setup'
}> {
  // Predator: PEAK / DUMP_CONT / CONT_* SHORT. Elite: PUMP / CONT_* LONG + ALT_JEWEL.
  const eliteMemeLong =
    plan.alertType === 'SNIPER' &&
    plan.side === 'LONG' &&
    isEliteMemeLongSetup(plan.setup, plan.side)
  const eliteAltJewel =
    plan.alertType === 'SNIPER' && plan.setup === ALT_JEWEL_SETUP
  if (
    plan.alertType === 'MEME' &&
    (!isPredatorShortSetup(plan.setup, plan.side) || plan.side !== 'SHORT')
  ) {
    return { created: false, comment: null, skipReason: 'setup' }
  }
  if (
    plan.alertType === 'SNIPER' &&
    (ELITE_MEME_SETUPS.has(plan.setup) || isContSetup(plan.setup)) &&
    !eliteMemeLong
  ) {
    return { created: false, comment: null, skipReason: 'setup' }
  }
  // Elite SNIPER paper: meme LONGs, ALT_JEWEL both sides, or VANE_* only
  if (
    plan.alertType === 'SNIPER' &&
    !eliteMemeLong &&
    !eliteAltJewel &&
    !plan.setup.startsWith('VANE_')
  ) {
    return { created: false, comment: null, skipReason: 'setup' }
  }
  if (eliteAltJewel && plan.side !== 'SHORT' && plan.side !== 'LONG') {
    return { created: false, comment: null, skipReason: 'setup' }
  }
  const list = await listPaperTrades(env)
  const now = Date.now()

  const pruned = list
    .filter((t) => {
      if (t.status !== 'CLOSED') return true
      return now - (t.closedAt ?? t.createdAt) < 24 * 60 * 60_000
    })
    .slice(-40)

  if (activeCount(pruned) >= MAX_ACTIVE) {
    return { created: false, comment: null, skipReason: 'caps' }
  }

  const isMeme = plan.alertType === 'MEME'
  const isEliteMeme = eliteMemeLong
  const isAltJewelPlan = eliteAltJewel
  const isImpulse = isMeme || isEliteMeme || isAltJewelPlan
  if (isMeme) {
    const activeMemes = pruned.filter(
      (t) =>
        t.alertType === 'MEME' &&
        (t.status === 'WAITING' || t.status === 'OPEN')
    )
    if (activeMemes.length >= MAX_ACTIVE_MEME) {
      return { created: false, comment: null, skipReason: 'caps' }
    }
    const flipBypass = plan.entryReasons?.includes('flip_after_wrong_side')
    const recentSame = pruned.find((t) => {
      if (t.symbol !== plan.symbol || t.alertType !== 'MEME') return false
      const last = Math.max(t.createdAt, t.closedAt ?? 0)
      return now - last < MEME_SYMBOL_COOLDOWN_MS
    })
    if (recentSame && !flipBypass) {
      return { created: false, comment: null, skipReason: 'cooldown' }
    }
  }
  if (isEliteMeme) {
    const activeElite = pruned.filter(
      (t) =>
        t.alertType === 'SNIPER' &&
        isEliteMemeLongSetup(t.setup, t.side) &&
        (t.status === 'WAITING' || t.status === 'OPEN')
    )
    if (activeElite.length >= MAX_ACTIVE_ELITE_MEME) {
      return { created: false, comment: null, skipReason: 'caps' }
    }
    const recentSame = pruned.find((t) => {
      if (t.symbol !== plan.symbol) return false
      if (
        t.alertType !== 'SNIPER' ||
        !isEliteMemeLongSetup(t.setup || '', t.side)
      )
        return false
      const last = Math.max(t.createdAt, t.closedAt ?? 0)
      return now - last < MEME_SYMBOL_COOLDOWN_MS
    })
    if (recentSame) {
      return { created: false, comment: null, skipReason: 'cooldown' }
    }
  }
  if (isAltJewelPlan) {
    const activeJewel = pruned.filter(
      (t) =>
        t.setup === ALT_JEWEL_SETUP &&
        (t.status === 'WAITING' || t.status === 'OPEN')
    )
    if (activeJewel.length >= MAX_ACTIVE_ALT_JEWEL) {
      return { created: false, comment: null, skipReason: 'caps' }
    }
    const recentSame = pruned.find((t) => {
      if (t.setup !== ALT_JEWEL_SETUP) return false
      const last = Math.max(t.createdAt, t.closedAt ?? 0)
      return now - last < ALT_JEWEL_COOLDOWN_MS
    })
    if (recentSame) {
      return { created: false, comment: null, skipReason: 'cooldown' }
    }
  }

  const dup = pruned.find(
    (t) =>
      (t.status === 'WAITING' || t.status === 'OPEN') &&
      t.symbol === plan.symbol &&
      t.side === plan.side
  )
  if (dup) return { created: false, comment: null, skipReason: 'dup' }
  // Impulse memes (PEAK SHORT / Elite DUMP LONG): market-mark fill
  let fill = isImpulse ? plan.signalPrice || plan.entryIdeal : null
  let sl = plan.sl
  let tp = plan.tp
  let target1 = plan.target1 ?? null
  let target3 = plan.target3 ?? null
  let entryIdeal = plan.entryIdeal
  let zoneLow = plan.zoneLow
  let zoneHigh = plan.zoneHigh
  if (isImpulse) {
    const isPeak = isPredatorShortSetup(plan.setup, plan.side)
    let mark =
      plan.markPrice && plan.markPrice > 0
        ? plan.markPrice
        : fill && fill > 0
          ? fill
          : null
    let snap: TickerSnap | null = null
    if (!isPeak || !(mark && mark > 0) || isAltJewelPlan) {
      snap = await fetchTickerSnap(plan.symbol)
      mark = snap?.last && snap.last > 0 ? snap.last : mark
    }
    if (!(mark && mark > 0)) {
      return { created: false, comment: null, skipReason: 'bad_mark' }
    }
    fill = mark
    entryIdeal = mark
    if (isAltJewelPlan) {
      // Scalp both sides: TP 0.80% / SL 0.40% @ ×50
      if (plan.side === 'LONG') {
        sl = mark * (1 - ALT_JEWEL_SL_PCT)
        tp = mark * (1 + ALT_JEWEL_TP_PCT)
        zoneLow = Math.min(zoneLow, mark * 0.999)
        zoneHigh = Math.max(zoneHigh, mark)
        if (snap && (snap.last <= sl || snap.low <= sl)) {
          return { created: false, comment: null, skipReason: 'pre_stopped' }
        }
      } else {
        sl = mark * (1 + ALT_JEWEL_SL_PCT)
        tp = mark * (1 - ALT_JEWEL_TP_PCT)
        zoneLow = Math.min(zoneLow, mark)
        zoneHigh = Math.max(zoneHigh, mark * 1.001)
        if (snap && (snap.last >= sl || snap.high >= sl)) {
          return { created: false, comment: null, skipReason: 'pre_stopped' }
        }
      }
      target1 = tp
      target3 = tp
    } else {
      const minSlPct = isPeak ? 0 : 0.01
      if (plan.side === 'LONG') {
        sl = Math.min(plan.sl, mark * (1 - Math.max(minSlPct, 0.0045)))
        if (!(sl < mark * 0.997)) sl = mark * 0.99
        if (snap && (snap.last <= sl || snap.low <= sl)) {
          return { created: false, comment: null, skipReason: 'pre_stopped' }
        }
        zoneLow = Math.min(zoneLow, mark * 0.999)
        zoneHigh = Math.max(zoneHigh, mark)
      } else {
        sl = Math.max(plan.sl, mark * (1 + (isPeak ? 0.01 : minSlPct || 0.01)))
        if (!(sl > mark * 1.003)) sl = mark * 1.01
        if (snap && (snap.last >= sl || snap.high >= sl)) {
          return { created: false, comment: null, skipReason: 'pre_stopped' }
        }
        zoneLow = Math.min(zoneLow, mark)
        zoneHigh = Math.max(zoneHigh, mark * 1.001)
        if (isPeak) sl = mark * 1.01
      }
      const rebased = rebaseMemeLevels({
        entry: mark,
        side: plan.side,
        refEntry: mark,
        refSl: sl,
      })
      sl = rebased.sl
      // Structural meme exits: TP1 0.8% → TP2 2.0%
      if (plan.side === 'LONG') {
        tp = mark * (1 + MEME_TP_PRICE_PCT)
        target1 = mark * (1 + MEME_TP1_PRICE_PCT)
      } else {
        tp = mark * (1 - MEME_TP_PRICE_PCT)
        target1 = mark * (1 - MEME_TP1_PRICE_PCT)
      }
      target3 = tp
    }
  }
  const trade: PaperTrade = {
    id: `${plan.symbol}:${plan.side}:${now}`,
    symbol: plan.symbol,
    side: plan.side,
    setup: plan.setup,
    alertType: plan.alertType,
    signalPrice: plan.signalPrice,
    zoneLow,
    zoneHigh,
    entryIdeal,
    invalidate: plan.invalidate,
    sl,
    tp,
    target1,
    target3,
    status: isImpulse ? 'OPEN' : 'WAITING',
    fillPrice: fill,
    zoneTouchedAt: isImpulse ? now : null,
    zoneTouchPrice: fill,
    peak: fill,
    // Binary meme: no trail shadow — only initial SL or hard TP
    trailingStop:
      isImpulse || isMeme
        ? null
        : fill
          ? plan.side === 'LONG'
            ? fill * 0.982
            : fill * 1.018
          : null,
    createdAt: now,
    openedAt: isImpulse ? now : null,
    expiresAt:
      now +
      (plan.setup === 'LIQUIDATION_ECHO'
        ? OPEN_TTL_ECHO_MS
        : isAltJewelPlan
          ? OPEN_TTL_ALT_JEWEL_MS
          : isImpulse
            ? OPEN_TTL_MEME_MS
            : plan.setup.startsWith('VANE_')
              ? isMacroSetup(plan.setup)
                ? 90 * 60_000
                : isMicroSetup(plan.setup)
                ? 45 * 60_000
                : plan.vanePath === 'FLIP'
                  ? 75 * 60_000
                  : WAITING_TTL_VANE_MS
              : WAITING_TTL_MS),
    closedAt: null,
    lastPulseAt: now,
    closeReason: null,
    beSent: false,
    tpSent: false,
    tp1Sent: false,
    trailMovedSent: false,
    waitingAnnounced: true,
    lastWinPct: null,
    vanePath: plan.vanePath,
    vaneTier: plan.vaneTier,
    vaneScore: plan.vaneScore,
    entryReasons: plan.entryReasons,
    entryNotes: plan.entryNotes,
    qualityTier: plan.qualityTier,
  }

  pruned.push(trade)
  await savePaperTrades(env, pruned)

  const icon = plan.side === 'LONG' ? '🟢' : '🔴'
  const cadence = isMeme ? 'каждые ~2 мин' : 'каждые ~5 мин'
  const isEcho = plan.setup === 'LIQUIDATION_ECHO'
  const isVane = plan.setup.startsWith('VANE_')
  const route: 'meme' | 'sniper' = isMeme ? 'meme' : 'sniper'
  const flipTtl =
    plan.vanePath === 'FLIP' ? 'TTL ретеста ~60–75 мин' : `Сопровождение ${cadence}`
  const ticker = nameOf(plan.symbol).replace('/USDT', '')
  const comment: PaperComment = isMeme
    ? {
        alertType: 'SYSTEM',
        route,
        // Price-first for lock-screen preview (same as PEAK entry alert)
        title: `${fmt(fill!)} ${ticker} · ${plan.side === 'SHORT' ? '🔴' : '🟢'} ${plan.side}`,
        text: isEcho
          ? [
              `⚡ Liquidation Echo · Post-Only fill (maker).`,
              `🎯 ВХОД ${fmt(fill!)} · 🟢 TP ${fmt(tp)} · 🛑 SL ${fmt(sl)}`,
              `⏱ Time-stop 12с → выход лимитом в спред (без market).`,
              `💎 RR ~1:1.6 · unit 10% equity.`,
            ].join('\n')
          : [
              `🎯 ВХОД ${fmt(fill!)}`,
              `🛑 SL ${fmt(sl)} (${pctFromEntry(fill!, sl)})`,
              `💎 TP ${fmt(tp)} (${pctFromEntry(fill!, tp)}) ≈ +${
                isAltJewelPlan ? ALT_JEWEL_TARGET_ROE_PCT : MEME_TARGET_ROE_PCT
              }% @ ×${isAltJewelPlan ? ALT_JEWEL_LEVERAGE : MEME_ASSUMED_LEVERAGE}`,
              `📌 Сетап ${plan.setup} · класс ${plan.qualityTier ?? 'A'}`,
              plan.entryReasons?.length
                ? `⚡ Почему: ${plan.entryReasons
                    .filter(
                      (r) =>
                        !/^(quality|fuel|conf|dist_high|chg24|promote|oi_unknown|lev|roe_target|tp:|sl:)/.test(
                          r
                        )
                    )
                    .slice(0, 6)
                    .join(' · ')}`
                : null,
              isAltJewelPlan
                ? `⚖ ALT JEWEL: SL или TP +${(ALT_JEWEL_TP_PCT * 100).toFixed(2)}% (+${ALT_JEWEL_TARGET_ROE_PCT}% @ ×${ALT_JEWEL_LEVERAGE}). Автономно, без Mini App.`
                : `⚖ Структурный выход: TP1 +${(MEME_TP1_PRICE_PCT * 100).toFixed(1)}% → BE · TP2 +${(MEME_TP_PRICE_PCT * 100).toFixed(1)}% (40% @ ×20). TTL 6ч.`,
              isAltJewelPlan
                ? `📡 Топ‑3 ликвидных альта · короткий скальп.`
                : isPredatorShortSetup(plan.setup, plan.side)
                  ? `🛡 SHORT: TP1 → BE; после MFE≥1% floor BE±0.2%.`
                  : `✂ PUMP/CONT LONG: 10м без MFE≥0.25% → cut dead.`,
              `📡 Сопровождение ${cadence}.`,
            ]
              .filter(Boolean)
              .join('\n'),
        dedupeKey: `paper:fill:${trade.id}`,
        setup: plan.setup,
      }
    : {
        alertType: 'SYSTEM',
        route,
        title: isVane
          ? `${icon} VANE ${plan.vanePath ?? 'HOLD'} ${plan.side} ${nameOf(plan.symbol)}`
          : `${icon} ЗОНА ${nameOf(plan.symbol)} · жду реакцию`,
        text: [
          isVane
            ? `Флюгер: ${plan.vanePath ?? 'HOLD'} · ${plan.vaneTier ?? 'TIER2'} · score ${plan.vaneScore ?? '—'}/100`
            : `Сценарий под наблюдение (как в Mini App): зона → подтверждение → вход.`,
          `Сторона: ${plan.side} · ${plan.setup}`,
          `Зона лимитки: ${fmt(plan.zoneLow)} – ${fmt(plan.zoneHigh)}`,
          `Ориентир: ${fmt(entryIdeal)} · SL ${fmt(sl)} · TP ${fmt(tp)}`,
          plan.side === 'LONG'
            ? `Инвалидация выше ${fmt(plan.invalidate)} — не догоняю.`
            : `Инвалидация ниже ${fmt(plan.invalidate)} — не догоняю.`,
          `Жду касание + реакцию стакана/CVD (${flipTtl}).`,
        ].join('\n'),
        dedupeKey: `paper:wait:${trade.id}`,
      }

  return { created: true, comment }
}

function touchesZone(t: PaperTrade, snap: TickerSnap): boolean {
  return snap.low <= t.zoneHigh && snap.high >= t.zoneLow
}

function clampFill(t: PaperTrade, price: number): number {
  return Math.min(t.zoneHigh, Math.max(t.zoneLow, price))
}

function invalidatedWithoutFill(t: PaperTrade, snap: TickerSnap): boolean {
  if (t.side === 'LONG') return snap.high >= t.invalidate && !touchesZone(t, snap)
  return snap.low <= t.invalidate && !touchesZone(t, snap)
}

function isSqueezeSetup(setup: string): boolean {
  return setup === 'PEAK_FUEL_FAIL'
}

function confirmsMemeSqueeze(
  t: PaperTrade,
  snap: TickerSnap,
  brief: MarketBrief,
  now: number
): boolean {
  // Force ~2m wait after arming — matches user “подожди 2 минуты”
  if (now - t.createdAt < 90_000) return false
  if (!t.zoneTouchedAt) return false
  const bookAligned =
    brief.bookImb != null &&
    (t.side === 'LONG' ? brief.bookImb >= 10 : brief.bookImb <= -10)
  const pressureAligned =
    t.side === 'LONG'
      ? brief.pressure === 'BUYERS'
      : brief.pressure === 'SELLERS'
  const tapeAligned =
    t.side === 'LONG'
      ? brief.move1mPct >= 0.12 && brief.candleBias !== 'DOWN'
      : brief.move1mPct <= -0.12 && brief.candleBias !== 'UP'
  const hold =
    t.side === 'LONG'
      ? snap.last >= t.entryIdeal * 0.997 && snap.low > t.sl
      : snap.last <= t.entryIdeal * 1.003 && snap.high < t.sl
  // Need book OR (pressure+tape), never open on price alone
  return hold && (bookAligned || (pressureAligned && tapeAligned))
}

function confirmsEntry(
  t: PaperTrade,
  snap: TickerSnap,
  brief: MarketBrief,
  now = Date.now()
): boolean {
  if (!t.zoneTouchedAt) return false
  if (isSqueezeSetup(t.setup) && isMemeTrade(t)) {
    return confirmsMemeSqueeze(t, snap, brief, now)
  }
  if (t.setup.startsWith('VANE_')) return confirmsVaneEntry(t, snap, brief)
  const pressureAligned =
    t.side === 'LONG'
      ? brief.pressure === 'BUYERS'
      : brief.pressure === 'SELLERS'
  const tapeAligned =
    t.side === 'LONG'
      ? brief.candleBias === 'UP' && brief.move1mPct > 0
      : brief.candleBias === 'DOWN' && brief.move1mPct < 0
  const bookAligned =
    brief.bookImb != null &&
    (t.side === 'LONG' ? brief.bookImb >= 8 : brief.bookImb <= -8)
  const reclaimed =
    t.side === 'LONG'
      ? snap.last >= t.entryIdeal && snap.last <= t.zoneHigh * 1.003
      : snap.last <= t.entryIdeal && snap.last >= t.zoneLow * 0.997
  return reclaimed && pressureAligned && tapeAligned && bookAligned
}

/** Vane: fill on zone reclaim + (book OR tape+pressure).
 * v4.1: early SCALP impulse fills faster on TOUCH + move ≥0.35%.
 */
function confirmsVaneEntry(
  t: PaperTrade,
  snap: TickerSnap,
  brief: MarketBrief
): boolean {
  if (!t.zoneTouchedAt) return false
  const bookAligned =
    brief.bookImb != null &&
    (t.side === 'LONG' ? brief.bookImb >= 4 : brief.bookImb <= -4)
  const pressureAligned =
    t.side === 'LONG'
      ? brief.pressure !== 'SELLERS'
      : brief.pressure !== 'BUYERS'
  const tapeAligned =
    t.side === 'LONG'
      ? brief.move1mPct >= -0.05 && brief.candleBias !== 'DOWN'
      : brief.move1mPct <= 0.05 && brief.candleBias !== 'UP'
  const inBand =
    snap.last >= t.zoneLow * 0.995 && snap.last <= t.zoneHigh * 1.005
  if (t.vanePath === 'FLIP') {
    return inBand && (bookAligned || (pressureAligned && tapeAligned))
  }

  // MACRO / MICRO / EARLY SCALP: zone + impulse → enter without perfect reclaim
  const isScalp =
    t.setup.startsWith('VANE_SCALP_') ||
    isMicroSetup(t.setup) ||
    isMacroSetup(t.setup)
  const impulseFloor = isMacroSetup(t.setup) ? 0.4 : 0.28
  const impulse =
    t.side === 'LONG'
      ? brief.move1mPct >= impulseFloor || brief.move5mPct >= impulseFloor * 1.4
      : brief.move1mPct <= -impulseFloor ||
        brief.move5mPct <= -impulseFloor * 1.4
  if (isScalp && inBand && impulse && (bookAligned || pressureAligned)) {
    return true
  }

  const reclaimed =
    t.side === 'LONG'
      ? snap.last >= t.entryIdeal * 0.997 && snap.last <= t.zoneHigh * 1.005
      : snap.last <= t.entryIdeal * 1.003 && snap.last >= t.zoneLow * 0.995
  // Need reclaim + at least one flow confirm (not all three)
  return reclaimed && (bookAligned || (pressureAligned && tapeAligned))
}

async function updatePredatorRiskOnClose(
  env: PaperEnv,
  t: PaperTrade,
  exitPrice: number
): Promise<void> {
  if (t.setup !== 'LIQUIDATION_ECHO' || t.fillPrice == null) return
  const kv = env.SUBSCRIBERS
    ? {
        get: (key: string) => env.SUBSCRIBERS!.get(key),
        put: (key: string, value: string) => env.SUBSCRIBERS!.put(key, value),
      }
    : undefined
  const risk = await loadPredatorRisk(kv)
  const pricePnl = pnlPct(t.side, t.fillPrice, exitPrice)
  const margin = Math.max(2, risk.equityUsd * 0.1)
  // 10x: +1.1% price ≈ +11% on margin
  const pnlUsd = margin * (pricePnl / 100) * 10
  const next = applyPredatorOutcome(risk, pnlUsd, pricePnl < -0.15)
  await savePredatorRisk(kv, next)
}

async function updateVaneRiskOnClose(
  env: PaperEnv,
  t: PaperTrade,
  exitPrice: number | null
): Promise<void> {
  if (!t.setup.startsWith('VANE_')) return
  const kv = env.SUBSCRIBERS
    ? {
        get: (key: string) => env.SUBSCRIBERS!.get(key),
        put: (key: string, value: string) => env.SUBSCRIBERS!.put(key, value),
      }
    : undefined
  const risk = await loadVaneRisk(kv)
  // WAIT timeout / invalidate — free slot, no PnL (was sticking openSymbols → silence)
  if (t.fillPrice == null || exitPrice == null) {
    await saveVaneRisk(kv, unregisterVaneSymbol(risk, t.symbol))
    return
  }
  const pricePnl = pnlPct(t.side, t.fillPrice, exitPrice)
  // Approximate margin impact at ~20x for day PnL tracking
  const dayPnlPct =
    pricePnl * 0.2 * ((t.vaneTier === 'TIER1' ? 1.75 : 0.75) / 1.75)
  const next = applyVaneOutcome(risk, {
    symbol: t.symbol,
    pnlPct: dayPnlPct,
    isLoss: pricePnl < -0.1,
  })
  await saveVaneRisk(kv, next)
  if (isMacroSetup(t.setup)) {
    await rememberMacroOutcome(kv, {
      symbol: t.symbol,
      side: t.side,
      pnlPct: pricePnl,
      isLoss: pricePnl < -0.15,
      isWin: pricePnl > 0.35,
    })
  }
}

/** PEAK/meme: last-price only — OHLC same-bar TP-before-SL inflated WR. */
function useLastPriceExits(t: PaperTrade): boolean {
  return isMemeTrade(t) || t.setup === 'PEAK_FUEL_FAIL'
}

function hitTp(t: PaperTrade, snap: TickerSnap): boolean {
  if (useLastPriceExits(t)) {
    if (t.side === 'LONG') return snap.last >= t.tp
    return snap.last <= t.tp
  }
  if (t.side === 'LONG') return snap.high >= t.tp
  return snap.low <= t.tp
}

function hitTp1(t: PaperTrade, snap: TickerSnap): boolean {
  if (!(t.target1 != null && t.target1 > 0)) return false
  if (useLastPriceExits(t)) {
    if (t.side === 'LONG') return snap.last >= t.target1
    return snap.last <= t.target1
  }
  if (t.side === 'LONG') return snap.high >= t.target1
  return snap.low <= t.target1
}

function hitSl(t: PaperTrade, snap: TickerSnap): boolean {
  if (useLastPriceExits(t)) {
    if (t.side === 'LONG') return snap.last <= t.sl
    return snap.last >= t.sl
  }
  if (t.side === 'LONG') return snap.low <= t.sl
  return snap.high >= t.sl
}

function memeFavorPct(t: PaperTrade, price: number): number {
  const fill = t.fillPrice ?? t.entryIdeal
  if (!(fill > 0)) return 0
  return Math.max(0, pnlPct(t.side, fill, price))
}

function isPeakSetup(t: PaperTrade): boolean {
  return isPredatorShortSetup(t.setup, t.side) && t.side === 'SHORT'
}

function memeTp1Price(t: PaperTrade): number | null {
  if (!isMemeTrade(t) || isAltJewel(t) || t.fillPrice == null) return null
  const fill = t.fillPrice
  return t.side === 'LONG'
    ? fill * (1 + MEME_TP1_PRICE_PCT)
    : fill * (1 - MEME_TP1_PRICE_PCT)
}

function hitMemeTp1(t: PaperTrade, snap: TickerSnap): boolean {
  const tp1 = memeTp1Price(t)
  if (tp1 == null) return false
  return t.side === 'LONG' ? snap.high >= tp1 : snap.low <= tp1
}

function memeTrailPct(t: PaperTrade, peakFavorPct: number): number {
  if (isPeakSetup(t)) {
    if (t.tp1Sent || peakFavorPct >= 0.9) return PEAK_TRAIL_RUNNER
    if (peakFavorPct >= PEAK_ARM_PCT) return PEAK_TRAIL_TIGHT
    return PEAK_TRAIL_EARLY
  }
  if (t.tp1Sent || peakFavorPct >= 1.0) return MEME_TRAIL_RUNNER
  if (peakFavorPct >= MEME_ARM_PCT) return MEME_TRAIL_TIGHT
  return MEME_TRAIL_EARLY
}

function microTrailPct(t: PaperTrade, peakFavorPct: number): number {
  if (t.tp1Sent || peakFavorPct >= 0.55) return MICRO_TRAIL_AFTER_TP1
  if (peakFavorPct >= MICRO_BE_MFE_PCT) return MICRO_TRAIL_PCT
  return 0.006
}

function macroTrailPct(t: PaperTrade, peakFavorPct: number): number {
  if (t.tp1Sent || peakFavorPct >= 1.4) return MACRO_TRAIL_AFTER_TP1
  if (peakFavorPct >= MACRO_BE_MFE_PCT) return MACRO_TRAIL_PCT
  return 0.012
}

function updateTrail(t: PaperTrade, price: number): {
  peak: number
  trailingStop: number
  moved: boolean
} {
  let peak = t.peak ?? t.fillPrice ?? t.entryIdeal
  if (t.side === 'LONG' && price > peak) peak = price
  if (t.side === 'SHORT' && price < peak) peak = price

  const peakFavor =
    t.fillPrice != null ? Math.max(0, pnlPct(t.side, t.fillPrice, peak)) : 0
  const trailPct = isMemeTrade(t)
    ? memeTrailPct(t, peakFavor)
    : isMacroSetup(t.setup)
      ? macroTrailPct(t, peakFavor)
      : isMicroSetup(t.setup)
        ? microTrailPct(t, peakFavor)
        : 0.02

  const trailingStop =
    t.side === 'LONG' ? peak * (1 - trailPct) : peak * (1 + trailPct)

  const prev = t.trailingStop
  const moved =
    prev != null &&
    t.fillPrice != null &&
    Math.abs(trailingStop - prev) / t.fillPrice >
      (isMemeTrade(t) || isMicroSetup(t.setup) || isMacroSetup(t.setup)
        ? 0.0015
        : 0.005) &&
    ((t.side === 'LONG' && trailingStop > prev) ||
      (t.side === 'SHORT' && trailingStop < prev))

  return { peak, trailingStop, moved }
}

function trailHit(t: PaperTrade, snap: TickerSnap): boolean {
  if (t.trailingStop == null || t.fillPrice == null || t.peak == null) return false
  const arm = isPeakSetup(t)
    ? PEAK_ARM_PCT
    : isMemeTrade(t)
      ? MEME_ARM_PCT
      : isMacroSetup(t.setup)
        ? MACRO_ARM_PCT
        : isMicroSetup(t.setup)
          ? MICRO_ARM_PCT
          : 0.03
  const px = useLastPriceExits(t)
  if (t.side === 'LONG') {
    const breached = px
      ? snap.last <= t.trailingStop
      : snap.low <= t.trailingStop
    return breached && t.peak > t.fillPrice * (1 + arm)
  }
  const breached = px
    ? snap.last >= t.trailingStop
    : snap.high >= t.trailingStop
  return breached && t.peak < t.fillPrice * (1 - arm)
}

function memeBookExit(
  t: PaperTrade,
  brief: MarketBrief
): { exit: boolean; reason: string } {
  if (!isMemeTrade(t)) return { exit: false, reason: '' }
  const againstBook =
    brief.bookImb != null &&
    (t.side === 'LONG' ? brief.bookImb <= -18 : brief.bookImb >= 18)
  const againstFlow =
    t.side === 'LONG' ? brief.buyShare <= 0.4 : brief.buyShare >= 0.6
  const againstTape =
    t.side === 'LONG' ? brief.move1mPct <= -0.45 : brief.move1mPct >= 0.45
  if (againstBook && againstFlow) {
    return {
      exit: true,
      reason: 'Стакан и агрессивный поток развернулись — выхожу из мема',
    }
  }
  if (againstBook && againstTape) {
    return {
      exit: true,
      reason: 'OBI против + 1м против — импульс мема сломан',
    }
  }
  return { exit: false, reason: '' }
}

/**
 * Monitor example trades; emit market commentary + milestones.
 */
export async function monitorPaperTrades(
  env: PaperEnv
): Promise<PaperComment[]> {
  const list = await listPaperTrades(env)
  const now = Date.now()
  const comments: PaperComment[] = []
  let dirty = false

  const pushComment = (
    t: PaperTrade,
    c: Omit<PaperComment, 'setup' | 'route'> &
      Partial<Pick<PaperComment, 'setup' | 'route'>>
  ) => {
    comments.push({
      ...c,
      setup: c.setup ?? t.setup,
      route:
        c.route ??
        (t.alertType === 'MEME' ? 'meme' : 'sniper'),
    })
  }

  for (const t of list) {
    if (t.status === 'CLOSED') continue

    if (now > t.expiresAt) {
      const wasWaiting = t.status === 'WAITING' || !t.fillPrice
      // Binary open + already green: don't kill — extend and keep hunting TP
      if (
        !wasWaiting &&
        isBinaryRoeExit(t) &&
        t.fillPrice != null &&
        t.status === 'OPEN'
      ) {
        const snapEarly = await fetchTickerSnap(t.symbol)
        if (snapEarly) {
          const u = pnlPct(t.side, t.fillPrice, snapEarly.last)
          const skipPnl = isAltJewel(t)
            ? MEME_TIMEOUT_SKIP_PNL_PCT * 0.4
            : MEME_TIMEOUT_SKIP_PNL_PCT
          const extendMs = isAltJewel(t)
            ? OPEN_TTL_ALT_JEWEL_EXTEND_MS
            : OPEN_TTL_MEME_EXTEND_MS
          if (u >= skipPnl) {
            t.expiresAt = now + extendMs
            dirty = true
            pushComment(t, {
              alertType: 'SYSTEM',
              title: `⏳ Продлил hold ${nameOf(t.symbol)}`,
              text: [
                `uPnL +${u.toFixed(2)}% ≥ ${skipPnl}% — не режу по TTL.`,
                `Жду SL или TP +${(binaryTpPct(t) * 100).toFixed(2)}% (${binaryTargetRoe(t)}% @ ×${binaryLeverage(t)}).`,
              ].join('\n'),
              dedupeKey: `paper:ttl-extend:${t.id}:${Math.floor(now / extendMs)}`,
            })
            // fall through into normal OPEN handling with this snap below
          } else {
            t.status = 'CLOSED'
            t.closedAt = now
            t.closeReason = 'timeout_open'
            dirty = true
            await updateVaneRiskOnClose(env, t, snapEarly.last)
            pushComment(t, {
              alertType: 'SYSTEM',
              title: `⏱ Пример закрыт по времени ${nameOf(t.symbol)}`,
              text: [
                `TTL без цели +${(binaryTpPct(t) * 100).toFixed(2)}% · uPnL ${u.toFixed(2)}%.`,
                `Вход ${fmt(t.fillPrice)} → ${fmt(snapEarly.last)}.`,
              ].join('\n'),
              dedupeKey: `paper:expire:${t.id}`,
            })
            continue
          }
        } else {
          // no ticker — soft-extend once rather than blind-close a green unknown
          t.expiresAt = now + 30 * 60_000
          dirty = true
          continue
        }
      } else {
        t.status = 'CLOSED'
        t.closedAt = now
        t.closeReason = wasWaiting ? 'timeout_waiting' : 'timeout_open'
        dirty = true
        await updateVaneRiskOnClose(env, t, t.fillPrice)
        pushComment(t, {
          alertType: 'SYSTEM',
          title: wasWaiting
            ? `⏱ Пример закрыт: нет входа ${nameOf(t.symbol)}`
            : `⏱ Пример закрыт по времени ${nameOf(t.symbol)}`,
          text: wasWaiting
            ? `Зона не дали — учебная сделка отменена. Жду следующий сетап.`
            : `Держал пример слишком долго — закрываю бумажную позицию.`,
          dedupeKey: `paper:expire:${t.id}`,
        })
        continue
      }
    }

    const snap = await fetchTickerSnap(t.symbol)
    if (!snap) continue

    const brief = await fetchMarketBrief(t.symbol, snap)
    const { winPct, factors } = computeWinPct(t, snap.last, brief)

    if (t.status === 'WAITING') {
      if (invalidatedWithoutFill(t, snap)) {
        t.status = 'CLOSED'
        t.closedAt = now
        t.closeReason = 'invalidate'
        dirty = true
        await updateVaneRiskOnClose(env, t, null)
        pushComment(t, {
          alertType: 'SYSTEM',
          title: `⏭ Пример: пропуск ${nameOf(t.symbol)}`,
          text: [
            `Цена ушла без отката в зону — учебный вход отменяю.`,
            brief.pressureLabel,
            `Вероятность на момент отмены: ${winPct}%`,
            `Сейчас ${fmt(snap.last)} · инвалидация ${fmt(t.invalidate)}`,
          ].join('\n'),
          dedupeKey: `paper:skip:${t.id}`,
        })
        continue
      }

      if (!t.zoneTouchedAt && touchesZone(t, snap)) {
        t.zoneTouchedAt = now
        t.zoneTouchPrice = clampFill(t, snap.last)
        t.lastPulseAt = now
        t.lastWinPct = winPct
        dirty = true
        pushComment(t, {
          alertType: 'SYSTEM',
          title: `👀 Зона коснулась: жду подтверждение ${nameOf(t.symbol)}`,
          text: [
            `Это ещё НЕ вход. Цена коснулась ${fmt(t.zoneTouchPrice)}.`,
            `Открою ${t.side} только после возврата за ${fmt(t.entryIdeal)},`,
            `если свеча, агрессивный поток и OBI одновременно подтвердят направление.`,
            brief.pressureLabel,
          ].join('\n'),
          dedupeKey: `paper:touch:${t.id}`,
        })
        continue
      }

      if (t.zoneTouchedAt) {
        const failedBeforeEntry =
          t.side === 'LONG' ? snap.low <= t.sl : snap.high >= t.sl
        if (failedBeforeEntry) {
          t.status = 'CLOSED'
          t.closedAt = now
          t.closeReason = 'invalidate'
          dirty = true
          await updateVaneRiskOnClose(env, t, null)
          pushComment(t, {
            alertType: 'SYSTEM',
            title: `⏭ Вход отменён ${nameOf(t.symbol)}`,
            text: `После касания зоны подтверждения стакана не было, цена нарушила SL-уровень. Сделка не открывалась.`,
            dedupeKey: `paper:unconfirmed:${t.id}`,
          })
          continue
        }
      }

      if (confirmsEntry(t, snap, brief, now)) {
        const fill = snap.last
        const isMacro = isMacroSetup(t.setup)
        const isMicro = isMicroSetup(t.setup)
        t.status = 'OPEN'
        t.fillPrice = fill
        t.openedAt = now
        t.expiresAt =
          now +
          (isMacro
            ? OPEN_TTL_MACRO_MS
            : isMicro
              ? OPEN_TTL_MICRO_MS
              : OPEN_TTL_MS)
        t.peak = fill
        t.trailingStop = isMacro
          ? t.side === 'LONG'
            ? fill * (1 - 0.012)
            : fill * (1 + 0.012)
          : isMicro
            ? t.side === 'LONG'
              ? fill * (1 - 0.006)
              : fill * (1 + 0.006)
            : t.side === 'LONG'
              ? fill * 0.98
              : fill * 1.02
        t.lastWinPct = winPct
        t.lastPulseAt = now
        dirty = true
        pushComment(t, {
          alertType: 'SYSTEM',
          title: `✅ Пример: вошёл ${t.side} ${nameOf(t.symbol)}`,
          text: [
            isMacro
              ? `MACRO вход: зона + импульс · ловим тело хода.`
              : isMicro
                ? `MICRO вход: зона + импульс · Post-Only paper.`
                : `ВХОД ПОДТВЕРЖДЁН: ретест удержан, свеча + поток сделок + OBI совпали.`,
            `Вход: ${fmt(fill)} · SL ${fmt(t.sl)} · TP1 ${t.target1 != null ? fmt(t.target1) : '—'} · TP ${fmt(t.tp)}`,
            `Стартовая вероятность успеха: ${winPct}%`,
            brief.pressureLabel,
            `Дальше веду комментарии по рынку ${isMemeTrade(t) ? '≈каждые 2 мин' : '≈каждые 5 мин'}.`,
          ].join('\n'),
          dedupeKey: `paper:fill:${t.id}`,
        })
        continue
      }

      // Waiting commentary on cadence
      const lastPulse = t.lastPulseAt ?? t.createdAt
      if (now - lastPulse >= pulseMs(t)) {
        const prevWin = t.lastWinPct
        t.lastPulseAt = now
        t.lastWinPct = winPct
        dirty = true
        pushComment(
          t,
          buildCommentary({
            t,
            price: snap.last,
            brief,
            winPct,
            prevWin,
            factors,
            phase: 'WAITING',
          })
        )
      }
      continue
    }

    // OPEN milestones + commentary
    let fill = t.fillPrice!
    const ageMs = t.openedAt != null ? now - t.openedAt : now - t.createdAt
    const binaryRoe = isBinaryRoeExit(t)

    // Live-migrate open binary papers to TP2 + structural TP1 + TTL floor
    if (binaryRoe && t.fillPrice != null) {
      const tpPct = binaryTpPct(t)
      const wantTp =
        t.side === 'LONG'
          ? t.fillPrice * (1 + tpPct)
          : t.fillPrice * (1 - tpPct)
      const wantTp1 = isAltJewel(t)
        ? wantTp
        : t.side === 'LONG'
          ? t.fillPrice * (1 + MEME_TP1_PRICE_PCT)
          : t.fillPrice * (1 - MEME_TP1_PRICE_PCT)
      const tpDrift =
        Math.abs(t.tp - wantTp) / Math.max(t.fillPrice, 1e-12) > 0.001
      const opened = t.openedAt ?? t.createdAt
      const wantExp =
        opened + (isAltJewel(t) ? OPEN_TTL_ALT_JEWEL_MS : OPEN_TTL_MEME_MS)
      if (
        tpDrift ||
        t.trailingStop != null ||
        (t.target1 != null &&
          Math.abs(t.target1 - wantTp1) / Math.max(t.fillPrice, 1e-12) > 0.001)
      ) {
        t.tp = wantTp
        t.target1 = wantTp1
        t.target3 = wantTp
        t.trailingStop = null
        dirty = true
      }
      if (t.expiresAt < wantExp) {
        t.expiresAt = wantExp
        dirty = true
      }
    }

    // Track peak OBI (favorable) for structural flip exit after TP1
    if (
      binaryRoe &&
      !isAltJewel(t) &&
      brief.bookImb != null &&
      Number.isFinite(brief.bookImb)
    ) {
      const fav =
        t.side === 'LONG' ? brief.bookImb : -brief.bookImb
      const prevPeak = t.peakObi
      if (prevPeak == null || fav > prevPeak) {
        t.peakObi = fav
        dirty = true
      }
    }

    // Structural TP1 (memes): lock BE, keep runner to TP2 — do not full-close
    if (
      binaryRoe &&
      !isAltJewel(t) &&
      !t.tp1Sent &&
      hitMemeTp1(t, snap)
    ) {
      t.tp1Sent = true
      const beSl =
        t.side === 'LONG'
          ? fill * (1 - MEME_TP1_BE_BUF)
          : fill * (1 + MEME_TP1_BE_BUF)
      const tightened = t.side === 'LONG' ? beSl > t.sl : beSl < t.sl
      if (tightened) t.sl = beSl
      t.beSent = true
      dirty = true
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `① TP1 +${(MEME_TP1_PRICE_PCT * 100).toFixed(1)}% ${nameOf(t.symbol)}`,
        text: [
          `Частичный профит ~40% позиции · SL → BE (${fmt(t.sl)}).`,
          `Держу runner до TP2 +${(binaryTpPct(t) * 100).toFixed(1)}% (≈ +${binaryTargetRoe(t)}% @ ×${binaryLeverage(t)}).`,
        ].join('\n'),
        dedupeKey: `paper:tp1:${t.id}`,
      })
      // continue managing same tick for TP2 / SL
    }

    // After TP1: OBI flipped ≥15 pts from peak favorable → exit runner
    if (
      binaryRoe &&
      !isAltJewel(t) &&
      t.tp1Sent &&
      !t.tpSent &&
      t.peakObi != null &&
      brief.bookImb != null
    ) {
      const favNow = t.side === 'LONG' ? brief.bookImb : -brief.bookImb
      if (t.peakObi - favNow >= 15) {
        t.status = 'CLOSED'
        t.closedAt = now
        t.closeReason = 'obi_flip'
        t.tpSent = true
        dirty = true
        await updatePredatorRiskOnClose(env, t, snap.last)
        await updateVaneRiskOnClose(env, t, snap.last)
        const uPnL = pnlPct(t.side, fill, snap.last)
        pushComment(t, {
          alertType: 'SYSTEM',
          title: `↩ OBI flip выход ${nameOf(t.symbol)}`,
          text: [
            `После TP1 OBI развернулся ≥15 пт от пика (peak ${t.peakObi.toFixed(0)} → now ${favNow.toFixed(0)}).`,
            `Закрыл runner · uPnL ${uPnL.toFixed(2)}%.`,
          ].join('\n'),
          dedupeKey: `paper:obi-flip:${t.id}`,
        })
        continue
      }
    }

    // Binary: hard TP2 (full close)
    if (binaryRoe && hitTp(t, snap) && !t.tpSent) {
      t.tpSent = true
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'tp'
      dirty = true
      const exit =
        t.side === 'LONG' ? Math.max(snap.last, t.tp) : Math.min(snap.last, t.tp)
      await updatePredatorRiskOnClose(env, t, exit)
      await updateVaneRiskOnClose(env, t, exit)
      const px = pnlPct(t.side, fill, exit)
      const lev = binaryLeverage(t)
      const roe = binaryTargetRoe(t)
      const tpPct = binaryTpPct(t)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `🎯 +${roe}% @ ×${lev} ${nameOf(t.symbol)}`,
        text: [
          isAltJewel(t)
            ? `TP ${(tpPct * 100).toFixed(2)}% цены. Выход: цель.`
            : `TP2 ${(tpPct * 100).toFixed(2)}% цены${t.tp1Sent ? ' после TP1/BE' : ''}. Структурный выход.`,
          `Вход ${fmt(fill)} → ~${fmt(exit)} · ${px.toFixed(2)}% цены ≈ ${(px * lev).toFixed(0)}% @ ×${lev}`,
        ].join('\n'),
        dedupeKey: `paper:tp:${t.id}`,
      })
      continue
    }

    // PEAK: invalidate late chase — never rebase fill/levels (that manufactured WINs).
    if (
      !binaryRoe &&
      isPeakSetup(t) &&
      ageMs < 180_000 &&
      Math.abs(fill - t.signalPrice) / Math.max(fill, 1e-12) < 0.002
    ) {
      const favorPct = pnlPct(t.side, fill, snap.last)
      const pastTp =
        t.side === 'SHORT' ? snap.last <= t.tp : snap.last >= t.tp
      if ((pastTp && favorPct >= 1.0) || favorPct >= 1.4) {
        t.status = 'CLOSED'
        t.closedAt = now
        t.closeReason = 'stale_entry'
        dirty = true
        await updateVaneRiskOnClose(env, t, snap.last)
        pushComment(t, {
          alertType: 'SYSTEM',
          title: `⏳ PEAK опоздал ${nameOf(t.symbol)}`,
          text: [
            `Цена уже ушла до первого сопровождения (лаг cron/TG).`,
            `Скан ${fmt(fill)} → сейчас ${fmt(snap.last)} (${favorPct >= 0 ? '+' : ''}${favorPct.toFixed(2)}%) — не считаю WIN.`,
            `Жду следующий пик без догона.`,
          ].join('\n'),
          dedupeKey: `paper:stale:${t.id}`,
        })
        continue
      }
    }

    const trail = binaryRoe
      ? {
          peak:
            t.side === 'LONG'
              ? Math.max(t.peak ?? fill, snap.last)
              : Math.min(t.peak ?? fill, snap.last),
          trailingStop: null as number | null,
          moved: false,
        }
      : updateTrail(t, snap.last)
    if (trail.peak !== t.peak || trail.trailingStop !== t.trailingStop) {
      t.peak = trail.peak
      t.trailingStop = trail.trailingStop
      dirty = true
    }

    const prevWin = t.lastWinPct
    const r = riskUnit(t)
    const unreal = pnlPct(t.side, fill, snap.last)
    const favorR =
      r > 0 ? (Math.abs(snap.last - fill) / r) * (unreal >= 0 ? 1 : -1) : 0
    const peakMfe =
      t.peak != null ? Math.max(0, pnlPct(t.side, fill, t.peak)) : 0
    const mfeNow = Math.max(peakMfe, Math.max(0, unreal))

    // PEAK soft floor: after MFE≥1% lock SL to BE±0.2% (prevent CYS/BTR give-back)
    if (
      binaryRoe &&
      isPeakSetup(t) &&
      mfeNow >= PEAK_FLOOR_MFE_PCT &&
      !hitTp(t, snap)
    ) {
      const floorSl =
        t.side === 'SHORT'
          ? fill * (1 + PEAK_FLOOR_BE_BUF)
          : fill * (1 - PEAK_FLOOR_BE_BUF)
      const tightened =
        t.side === 'SHORT' ? floorSl < t.sl : floorSl > t.sl
      if (tightened) {
        t.sl = floorSl
        dirty = true
        if (!t.beSent) {
          t.beSent = true
          pushComment(t, {
            alertType: 'SYSTEM',
            title: `🛡 PEAK floor BE ${nameOf(t.symbol)}`,
            text: [
              `MFE ${mfeNow.toFixed(2)}% ≥ ${PEAK_FLOOR_MFE_PCT}% — стоп в BE±${(PEAK_FLOOR_BE_BUF * 100).toFixed(1)}% (${fmt(floorSl)}).`,
              `Цель всё ещё TP +${(binaryTpPct(t) * 100).toFixed(2)}% · без trail.`,
            ].join('\n'),
            dedupeKey: `paper:peak-floor:${t.id}`,
          })
        }
      }
    }

    // PUMP dead-entry: 10м+ без MFE ≥0.25% — не держать до полного SL
    if (
      binaryRoe &&
      t.setup === 'PUMP_CONTINUE' &&
      ageMs >= PUMP_DEAD_AFTER_MS &&
      mfeNow < PUMP_DEAD_MFE_PCT &&
      !hitTp(t, snap) &&
      !hitSl(t, snap)
    ) {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'dead_entry'
      dirty = true
      await updateVaneRiskOnClose(env, t, snap.last)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `✂ PUMP мёртвый вход ${nameOf(t.symbol)}`,
        text: [
          `${Math.round(PUMP_DEAD_AFTER_MS / 60_000)}+ мин · MFE ${mfeNow.toFixed(2)}% < ${PUMP_DEAD_MFE_PCT}% — режу (не binary-hold).`,
          `Вход ${fmt(fill)} → ${fmt(snap.last)} · ${unreal.toFixed(2)}%`,
        ].join('\n'),
        dedupeKey: `paper:pump-dead:${t.id}`,
      })
      continue
    }

    // Dead-entry cut off in binary ROE mode — hold to SL or hard TP only
    if (
      !binaryRoe &&
      isMemeTrade(t) &&
      t.openedAt != null &&
      now - t.openedAt >= 4 * 60_000 &&
      now - t.openedAt < 20 * 60_000 &&
      unreal < 0.35 &&
      (t.peak == null ||
        Math.abs(pnlPct(t.side, fill, t.peak)) < 0.35) &&
      !hitTp(t, snap) &&
      !hitSl(t, snap)
    ) {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'dead_entry'
      dirty = true
      await updateVaneRiskOnClose(env, t, snap.last)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `✂ MEME мёртвый вход ${nameOf(t.symbol)}`,
        text: [
          `4+ мин без MFE ≥0.35% — режу (журнал: такие LOSS почти всегда).`,
          `Вход ${fmt(fill)} → ${fmt(snap.last)} · ${unreal.toFixed(2)}%`,
        ].join('\n'),
        dedupeKey: `paper:dead:${t.id}`,
      })
      continue
    }

    if (!binaryRoe && trail.moved && !t.trailMovedSent) {
      t.trailMovedSent = true
      dirty = true
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `📈 Пример: трейл ${nameOf(t.symbol)}`,
        text: [
          `Пик обновился — подтягиваю тень стопа ≈ ${fmt(trail.trailingStop)}.`,
          `uPnL ${unreal.toFixed(2)}% · вероятность ${winPct}%`,
          brief.pressureLabel,
        ].join('\n'),
        dedupeKey: `paper:trail:${t.id}:${Math.floor(now / 300_000)}`,
      })
    }

    // PEAK autopsy: BE earlier (0.35R / ~0.4% MFE) — 74% losses were give-backs
    const beR = isPeakSetup(t)
      ? PEAK_BE_R
      : isMemeTrade(t)
        ? 0.5
        : isMacroSetup(t.setup)
          ? MACRO_BE_R
          : isMicroSetup(t.setup)
            ? MICRO_BE_R
            : 0.6
    const favorPct = memeFavorPct(t, snap.last)
    const peakEarlyBe =
      !binaryRoe &&
      isPeakSetup(t) &&
      favorPct >= PEAK_ARM_PCT &&
      favorR >= 0.28
    const memeEarlyBe =
      !binaryRoe &&
      isMemeTrade(t) &&
      !isPeakSetup(t) &&
      favorPct >= MEME_ARM_PCT &&
      favorR >= 0.35
    const microEarlyBe =
      isMicroSetup(t.setup) &&
      favorPct >= MICRO_BE_MFE_PCT &&
      favorR >= MICRO_BE_R * 0.85
    const macroEarlyBe =
      isMacroSetup(t.setup) &&
      favorPct >= MACRO_BE_MFE_PCT &&
      favorR >= MACRO_BE_R * 0.85
    if (
      !binaryRoe &&
      !t.beSent &&
      (favorR >= beR || peakEarlyBe || memeEarlyBe || microEarlyBe || macroEarlyBe)
    ) {
      t.beSent = true
      // SHORT hitSl = last >= sl. SL below fill instantly dies on any bounce to entry.
      if (isPeakSetup(t) && t.side === 'SHORT') {
        if (favorPct >= 0.009 && snap.last < fill * 0.997) {
          t.sl = fill * (1 - 0.002)
        } else {
          t.sl = fill // flat BE — only stop if fully given back
        }
        // If price already back ≥ entry, keep small protective stop above
        if (!(snap.last < fill)) t.sl = fill * 1.0035
      } else if (isPeakSetup(t) && t.side === 'LONG') {
        t.sl = fill * (1 + 0.0015)
      } else {
        t.sl = fill
      }
      dirty = true
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `🛡 Пример: BE ${nameOf(t.symbol)}`,
        text: [
          isPeakSetup(t)
            ? `PEAK +${favorPct.toFixed(2)}% — стоп в BE (${fmt(t.sl)}), веду дальше.`
            : isMacroSetup(t.setup)
              ? `MACRO +${favorPct.toFixed(2)}% — стоп в BE (${fmt(fill)}).`
              : isMicroSetup(t.setup)
                ? `MICRO +${favorPct.toFixed(2)}% — стоп в BE (${fmt(fill)}).`
                : isMemeTrade(t)
                  ? `Прогресс +${favorPct.toFixed(2)}% / ${favorR.toFixed(2)}R — стоп в безубыток (${fmt(fill)}).`
                  : `Есть +${beR}R — стоп в безубыток (${fmt(fill)}).`,
          `Вероятность ${winPct}% · ${brief.pressureLabel}`,
          `Цель всё ещё ${fmt(t.tp)}${t.target1 ? ` · TP1 ${fmt(t.target1)}` : ''}.`,
        ].join('\n'),
        dedupeKey: `paper:be:${t.id}`,
      })
    }

    // TP1 ≈ R=1: lock BE + tighten trail (MICRO + MACRO; meme = binary ROE, skip)
    if (
      !binaryRoe &&
      (isMemeTrade(t) || isMicroSetup(t.setup) || isMacroSetup(t.setup)) &&
      !t.tp1Sent &&
      hitTp1(t, snap) &&
      !hitTp(t, snap)
    ) {
      t.tp1Sent = true
      t.beSent = true
      // After TP1: LONG SL above fill; SHORT SL below fill only if price still in profit
      if (t.side === 'LONG') {
        t.sl = fill * 1.001
      } else if (isPeakSetup(t)) {
        t.sl = snap.last < fill * 0.997 ? fill * (1 - 0.0015) : fill
        if (!(snap.last < t.sl)) t.sl = fill * 1.002
      } else {
        t.sl = fill * 0.999
      }
      const peak = t.peak ?? snap.last
      const tight = isMacroSetup(t.setup)
        ? MACRO_TRAIL_AFTER_TP1
        : isMicroSetup(t.setup)
          ? MICRO_TRAIL_AFTER_TP1
          : isPeakSetup(t)
            ? PEAK_TRAIL_RUNNER
            : MEME_TRAIL_RUNNER
      t.trailingStop =
        t.side === 'LONG' ? peak * (1 - tight) : peak * (1 + tight)
      dirty = true
      const label = isMacroSetup(t.setup)
        ? 'MACRO'
        : isMicroSetup(t.setup)
          ? 'MICRO'
          : 'MEME'
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `🎯 ${label} TP1 ${nameOf(t.symbol)}`,
        text: [
          `TP1 ${fmt(t.target1)} взят — логически 35% закрыты.`,
          `Стоп в BE (${fmt(fill)}), трейл ужесточён ≈ ${fmt(t.trailingStop)}.`,
          `Runner держим до TP2 ${fmt(t.tp)}.`,
          brief.pressureLabel,
        ].join('\n'),
        dedupeKey: `paper:tp1:${t.id}`,
      })
    }

    // Predator: 12s time-stop → maker exit at Best Ask (long) / Best Bid (short).
    if (
      t.setup === 'LIQUIDATION_ECHO' &&
      t.openedAt != null &&
      now - t.openedAt >= ECHO_TIME_STOP_MS &&
      !hitTp(t, snap) &&
      !hitSl(t, snap)
    ) {
      const exit =
        t.side === 'LONG'
          ? snap.ask1 > 0
            ? snap.ask1
            : snap.last
          : snap.bid1 > 0
            ? snap.bid1
            : snap.last
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'time_stop'
      dirty = true
      await updatePredatorRiskOnClose(env, t, exit)
      await updateVaneRiskOnClose(env, t, exit)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `⏱ PREDATOR time-stop ${nameOf(t.symbol)}`,
        text: [
          `12с без TP — maker exit в спред (не market).`,
          `Вход ${fmt(fill)} → ${fmt(exit)} · ${pnlPct(t.side, fill, exit).toFixed(2)}%`,
        ].join('\n'),
        dedupeKey: `paper:timestop:${t.id}`,
      })
      continue
    }

    const bookFlip = binaryRoe
      ? { exit: false, reason: '' }
      : memeBookExit(t, brief)
    if (bookFlip.exit && t.setup !== 'LIQUIDATION_ECHO') {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'trail'
      dirty = true
      await updateVaneRiskOnClose(env, t, snap.last)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `⏹ MEME выход ${nameOf(t.symbol)}`,
        text: [
          bookFlip.reason,
          `Вход ${fmt(fill)} → ${fmt(snap.last)} · ${unreal.toFixed(2)}%`,
          brief.pressureLabel,
        ].join('\n'),
        dedupeKey: `paper:bookflip:${t.id}`,
      })
      continue
    }

    // SL before TP — same-bar ambiguity must not become WIN.
    if (hitSl(t, snap)) {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'sl'
      dirty = true
      await updatePredatorRiskOnClose(env, t, t.sl)
      await updateVaneRiskOnClose(env, t, t.sl)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `🛑 ${t.setup === 'LIQUIDATION_ECHO' ? 'PREDATOR' : 'Пример'}: стоп ${nameOf(t.symbol)}`,
        text: [
          binaryRoe
            ? `SL. Бинарный выход: либо стоп, либо +${binaryTargetRoe(t)}% @ ×${binaryLeverage(t)}. Без догона.`
            : `Стоп (Last Price). Без догона.`,
          `Результат ${pnlPct(t.side, fill, t.sl).toFixed(2)}%`,
          brief.pressureLabel,
        ]
          .filter(Boolean)
          .join('\n'),
        dedupeKey: `paper:sl:${t.id}`,
        setup: t.setup,
      })
      continue
    }

    if (hitTp(t, snap) && !t.tpSent) {
      t.tpSent = true
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'tp'
      dirty = true
      const exit =
        t.side === 'LONG' ? Math.max(snap.last, t.tp) : Math.min(snap.last, t.tp)
      await updatePredatorRiskOnClose(env, t, exit)
      await updateVaneRiskOnClose(env, t, exit)
      const px = pnlPct(t.side, fill, exit)
      const lev = binaryLeverage(t)
      const roe = binaryTargetRoe(t)
      const tpPct = binaryTpPct(t)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: binaryRoe
          ? `🎯 +${roe}% @ ×${lev} ${nameOf(t.symbol)}`
          : `🎯 ${t.setup === 'LIQUIDATION_ECHO' ? 'PREDATOR' : t.setup.startsWith('VANE_') ? 'VANE' : 'Пример'}: цель ${nameOf(t.symbol)}`,
        text: binaryRoe
          ? [
              `TP ${(tpPct * 100).toFixed(2)}% цены. Без trail/BE/догона.`,
              `Вход ${fmt(fill)} → ~${fmt(exit)} · ${px.toFixed(2)}% ≈ ${(px * lev).toFixed(0)}% @ ×${lev}`,
            ].join('\n')
          : [
              `Закрыто по TP (Last Price).`,
              `Вход ${fmt(fill)} → ~${fmt(exit)} · ${px.toFixed(2)}%`,
              brief.pressureLabel,
            ].join('\n'),
        dedupeKey: `paper:tp:${t.id}`,
      })
      continue
    }

    if (!binaryRoe && trailHit(t, snap)) {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'trail'
      dirty = true
      const exit = t.trailingStop ?? snap.last
      await updateVaneRiskOnClose(env, t, exit)
      pushComment(t, {
        alertType: 'SYSTEM',
        title: `🚨 Пример: трейл-выход ${nameOf(t.symbol)}`,
        text: [
          `Тень стопа пробита — фиксирую пример.`,
          `Результат ${pnlPct(t.side, fill, exit).toFixed(2)}% · win% был ${winPct}%`,
          brief.pressureLabel,
        ].join('\n'),
        dedupeKey: `paper:trailhit:${t.id}`,
      })
      continue
    }

    const lastPulse = t.lastPulseAt ?? t.openedAt ?? t.createdAt
    if (now - lastPulse >= pulseMs(t)) {
      t.lastPulseAt = now
      t.lastWinPct = winPct
      dirty = true
      pushComment(
        t,
        buildCommentary({
          t,
          price: snap.last,
          brief,
          winPct,
          prevWin,
          factors,
          phase: 'OPEN',
        })
      )
    }
  }

  if (dirty) await savePaperTrades(env, list)
  for (const c of comments) {
    if (c.route) continue
    const trade = list.find((p) => c.dedupeKey.includes(p.id))
    c.route = trade?.alertType === 'SNIPER' ? 'sniper' : 'meme'
  }
  return comments
}

export function formatTradesStatus(list: PaperTrade[]): string {
  const live = list.filter((t) => t.status === 'WAITING' || t.status === 'OPEN')
  if (!live.length) {
    return 'Сейчас учебных (бумажных) сделок нет.\nЖду следующий сигнал сканера.'
  }
  const lines = ['Примеры сделок (бумажные):', '']
  for (const t of live) {
    const st = t.status === 'WAITING' ? '⏳ жду вход' : '✅ в позиции'
    const fill = t.fillPrice != null ? ` @ ${fmt(t.fillPrice)}` : ''
    const cad = t.alertType === 'MEME' ? '2м' : '5м'
    const win = t.lastWinPct != null ? ` · P≈${t.lastWinPct}%` : ''
    lines.push(
      `${st} · ${t.side} ${nameOf(t.symbol)} · ${t.setup} · ${cad}${fill}${win}`,
      `  зона ${fmt(t.zoneLow)}–${fmt(t.zoneHigh)} · SL ${fmt(t.sl)} · TP ${fmt(t.tp)}`
    )
  }
  return lines.join('\n')
}
