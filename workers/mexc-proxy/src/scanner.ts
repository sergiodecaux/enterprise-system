/**
 * 24/7 lightweight scanner for MEXC futures → Telegram alerts.
 * Only emits symbols that are active/tradeable on MEXC contract API.
 * Runs on Cloudflare Cron (every 2 minutes).
 */

import {
  calibrateWinPct,
  isSetupBlocked,
  isSetupBoosted,
  type BotAdaptiveGates,
  type WinPctCalibrationEntry,
} from './botJournal'
import { detectMarketRegime, regimeAllows, type MarketRegime } from './regime'
import { assessBookToxicity } from './bookToxicity'
import { BOT_ENGINE } from './botEngine'
import {
  analyzeConfluence,
  buildBotScoreCard,
} from './confluence'
import {
  assessZoneFuel,
  buildHtfLiquidityMap,
  findSmartZone,
  zoneProbabilityAdj,
  type SmartZonePlan,
} from './liquidityZones'
import {
  contextProbabilityAdj,
  getMarketContext,
  type MarketContext,
} from './marketContext'
import {
  buildGlobalScanContext,
  globalAllowsStyle,
  globalProbabilityFactors,
  type GlobalScanContext,
} from './globalScanContext'
import { readCandleTape, isImpulseLate } from './candleTape'
import { assessMemeAntiManipulation } from './memeAntiManipulation'

const MEXC = 'https://contract.mexc.com'

/**
 * Liquidity floors — obscure / region-missing listings rarely sit in top volume.
 * RF MEXC search usually shows liquid USDT-M perps only.
 */
const MIN_MEME_QUOTE_VOL = 150_000
const MIN_MOVER_QUOTE_VOL = 3_000_000
const MIN_OPEN_INTEREST = 4_000
/** Only alert from top-N liquid USDT perps by 24h quote volume */
const TOP_LIQUID_PERPS = 200
const memeOiHistory = new Map<string, { oi: number; at: number }>()

function observeMemeOi(symbol: string, oi: number): number | null {
  if (!(oi > 0)) return null
  const now = Date.now()
  const previous = memeOiHistory.get(symbol)
  memeOiHistory.set(symbol, { oi, at: now })
  if (!previous || now - previous.at > 15 * 60_000 || !(previous.oi > 0)) {
    return null
  }
  return ((oi - previous.oi) / previous.oi) * 100
}

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

export interface TradePlanPayload {
  side: 'LONG' | 'SHORT'
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
  /** SSL / BSL / ATR — same vocabulary as Mini App */
  zoneSource?: 'SSL' | 'BSL' | 'SWING' | 'ATR'
  zoneStrength?: number
  zoneTouches?: number
  targetLabel?: string
  zonePhase?: 'FAR' | 'APPROACH' | 'TOUCH'
}

export interface ScanAlert {
  type: 'SNIPER' | 'MEME'
  title: string
  text: string
  dedupeKey: string
  score: number
  /** Display win probability used for ranking */
  winPct: number
  style: 'SCALP' | 'INTRADAY' | 'SWING' | 'OTHER'
  align: 'WITH_TREND' | 'COUNTER'
  /** Alignment with BTC D/4H/1H global picture (for INTRA/SWING ranking) */
  globalAlignScore?: number
  tradePlan?: TradePlanPayload
  /** Price already left zone — auto-create pullback watches for subscribers */
  needsPullbackWatch?: boolean
  /** Chased SNIPER: no TG entry alert — only pullback watch handoff */
  watchOnly?: boolean
}

interface TickerRow {
  symbol: string
  lastPrice: number
  riseFallRate: number
  volume24: number
  amount24?: number
  holdVol?: number
  fundingRate?: number
  high24Price?: number
  lower24Price?: number
  bid1?: number
  ask1?: number
  fairPrice?: number
  indexPrice?: number
}

interface ContractDetail {
  symbol: string
  displayNameEn?: string
  state?: number
  isHidden?: boolean
  apiAllowed?: boolean
  quoteCoin?: string
  settleCoin?: string
  futureType?: number
  type?: number
  preMarket?: boolean
  maxVol?: number
  minVol?: number
  openingTime?: number
  appraisal?: number
  automaticDelivery?: number
  showBeforeOpen?: boolean
}

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

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

function isStrictPerpetualContract(c: ContractDetail | null | undefined): boolean {
  if (!c?.symbol?.endsWith('_USDT')) return false
  if (c.state !== 0) return false
  if (c.isHidden) return false
  if (c.apiAllowed === false) return false
  if (c.preMarket) return false
  if (c.quoteCoin && c.quoteCoin !== 'USDT') return false
  if (c.settleCoin && c.settleCoin !== 'USDT') return false
  if (c.futureType != null && c.futureType !== 1) return false
  if (c.type != null && c.type !== 1) return false
  if (c.maxVol != null && c.maxVol <= 0) return false
  if (c.appraisal) return false
  if (c.automaticDelivery) return false
  const opening = Number(c.openingTime ?? 0)
  if (opening > Date.now()) return false
  const name = String(c.displayNameEn ?? '').toUpperCase()
  // Must be labeled perpetual (excludes delivery / odd products)
  if (!name.includes('PERPETUAL')) return false
  return true
}

/**
 * Active USDT-M perpetuals from contract detail catalog.
 */
async function fetchTradableSymbols(): Promise<Set<string>> {
  const json = await mexcJson<{ data: ContractDetail | ContractDetail[] }>(
    '/api/v1/contract/detail'
  )
  if (!json?.data) return new Set()
  const rows = Array.isArray(json.data) ? json.data : [json.data]
  const out = new Set<string>()
  for (const c of rows) {
    if (isStrictPerpetualContract(c)) out.add(c.symbol)
  }
  return out
}

async function fetchTickers(): Promise<TickerRow[]> {
  const json = await mexcJson<{ data: TickerRow | TickerRow[] }>(
    '/api/v1/contract/ticker'
  )
  if (!json?.data) return []
  return Array.isArray(json.data) ? json.data : [json.data]
}

/**
 * Live gate: detail + ticker book + funding rate endpoint.
 * Funding rate exists only for real perpetuals that are open for trading.
 */
async function isSymbolTradableNow(
  symbol: string,
  minQuoteVol: number
): Promise<boolean> {
  const [detailJson, tickerJson, fundingJson] = await Promise.all([
    mexcJson<{ data: ContractDetail }>(
      `/api/v1/contract/detail?symbol=${symbol}`
    ),
    mexcJson<{ data: TickerRow | TickerRow[] }>(
      `/api/v1/contract/ticker?symbol=${symbol}`
    ),
    mexcJson<{ data: { symbol?: string; fundingRate?: number } }>(
      `/api/v1/contract/funding_rate/${symbol}`
    ),
  ])

  if (!isStrictPerpetualContract(detailJson?.data)) return false

  const row = Array.isArray(tickerJson?.data)
    ? tickerJson?.data[0]
    : tickerJson?.data
  if (!row || row.symbol !== symbol) return false

  const price = Number(row.lastPrice)
  const bid = Number(row.bid1 ?? 0)
  const ask = Number(row.ask1 ?? 0)
  const amount = Number(row.amount24 ?? 0)
  const oi = Number(row.holdVol ?? 0)

  if (!(price > 0)) return false
  if (!(bid > 0) || !(ask > 0)) return false
  if (ask < bid) return false
  if (amount < minQuoteVol) return false
  if (oi < MIN_OPEN_INTEREST) return false
  // fundingRate field must be present on perpetual ticker
  if (row.fundingRate == null || Number.isNaN(Number(row.fundingRate))) {
    return false
  }

  const fr = fundingJson?.data
  if (!fr || fr.symbol !== symbol || fr.fundingRate == null) return false

  return true
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const json = await mexcJson<{
    data: {
      time: number[]
      open: number[]
      high: number[]
      low: number[]
      close: number[]
      vol: number[]
    }
  }>(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`)

  const d = json?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  for (let i = 0; i < d.time.length; i++) {
    out.push([
      d.time[i] * 1000,
      Number(d.open[i]),
      Number(d.high[i]),
      Number(d.low[i]),
      Number(d.close[i]),
      Number(d.vol[i] ?? 0),
    ])
  }
  return out
}

function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gains += d
    else losses -= d
  }
  const ag = gains / period
  const al = losses / period
  if (al === 0) return 100
  const rs = ag / al
  return 100 - 100 / (1 + rs)
}

function calcAtr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    const tr = Math.max(
      c[2] - c[3],
      Math.abs(c[2] - prev[4]),
      Math.abs(c[3] - prev[4])
    )
    sum += tr
  }
  return sum / period
}

function volumeSpike(candles: Candle[]): {
  detected: boolean
  mult: number
  movePct: number
} {
  if (candles.length < 30) return { detected: false, mult: 0, movePct: 0 }
  const closed = candles.length >= 2 ? candles.slice(0, -1) : candles
  if (closed.length < 26) return { detected: false, mult: 0, movePct: 0 }
  // Baseline excludes the recent window we scan for spikes
  const base = closed.slice(-30, -8)
  if (base.length < 10) return { detected: false, mult: 0, movePct: 0 }
  const avg = base.reduce((s, c) => s + c[5], 0) / base.length
  if (avg <= 0) return { detected: false, mult: 0, movePct: 0 }

  // Best spike among last ~8 closed minutes (cron is */2 — don't miss the pump bar)
  let best = { mult: 0, movePct: 0 }
  for (const c of closed.slice(-8)) {
    const mult = c[5] / avg
    const movePct = c[1] > 0 ? ((c[4] - c[1]) / c[1]) * 100 : 0
    if (mult > best.mult) best = { mult, movePct }
  }
  return {
    detected: best.mult >= 1.8 && Math.abs(best.movePct) >= 0.5,
    mult: best.mult,
    movePct: best.movePct,
  }
}

/** Net move over last N closed 1m bars — catches pumps mid-run */
function burstMove(
  candles: Candle[],
  bars = 5
): { detected: boolean; movePct: number } {
  const closed = candles.length >= 2 ? candles.slice(0, -1) : candles
  if (closed.length < bars + 1) return { detected: false, movePct: 0 }
  const slice = closed.slice(-bars)
  const a = slice[0]![1]
  const b = slice[slice.length - 1]![4]
  if (!(a > 0)) return { detected: false, movePct: 0 }
  const movePct = ((b - a) / a) * 100
  return {
    detected: Math.abs(movePct) >= 2.5,
    movePct,
  }
}

function flatlineIgnition(candles: Candle[]): {
  detected: boolean
  mult: number
  movePct: number
} {
  if (candles.length < 90) return { detected: false, mult: 0, movePct: 0 }
  const last = candles[candles.length - 1]
  const dead = candles.slice(-361, -1)
  if (dead.length < 60) return { detected: false, mult: 0, movePct: 0 }
  const high = Math.max(...dead.map((c) => c[2]))
  const low = Math.min(...dead.map((c) => c[3]))
  const mid = (high + low) / 2
  const corridor = mid > 0 ? ((high - low) / mid) * 100 : 100
  const avgVol = dead.reduce((s, c) => s + c[5], 0) / dead.length
  const hourly = avgVol * 60
  if (hourly <= 0 || corridor > 8) return { detected: false, mult: 0, movePct: 0 }
  const mult = last[5] / hourly
  const movePct = Math.abs((last[4] - last[1]) / last[1]) * 100
  return {
    detected: mult >= 12 && movePct >= 1.2 && movePct <= 6,
    mult,
    movePct,
  }
}

function toxicChop(candles: Candle[]): boolean {
  if (candles.length < 20) return false
  const w = candles.slice(-20)
  let wick = 0
  let range = 0
  for (const c of w) {
    const r = c[2] - c[3]
    if (r <= 0) continue
    const body = Math.abs(c[4] - c[1])
    wick += r - body
    range += r
  }
  return range > 0 && wick / range >= 0.72
}

function brokeLocalHigh(candles: Candle[]): boolean {
  if (candles.length < 22) return false
  const prior = candles.slice(-21, -1)
  const last = candles[candles.length - 1]
  const ph = Math.max(...prior.map((c) => c[2]))
  return last[4] > ph || last[2] > ph
}

function lowerHighAndBreak(candles: Candle[]): boolean {
  if (candles.length < 25) return false
  const w = candles.slice(-20)
  const highs: number[] = []
  for (let i = 2; i < w.length - 2; i++) {
    if (
      w[i][2] >= w[i - 1][2] &&
      w[i][2] >= w[i - 2][2] &&
      w[i][2] >= w[i + 1][2] &&
      w[i][2] >= w[i + 2][2]
    ) {
      highs.push(w[i][2])
    }
  }
  if (highs.length < 2) return false
  const lh = highs[highs.length - 1] < highs[highs.length - 2]
  const last = candles[candles.length - 1]
  const priorLow = Math.min(...w.slice(0, -1).map((c) => c[3]))
  return lh && last[4] < priorLow
}

function fmt(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(6)
  return p.toFixed(8)
}

function pct(from: number, to: number): string {
  if (!from) return '—'
  const p = ((to - from) / from) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
}

function quoteVol(t: TickerRow): number {
  return Number(t.amount24 ?? 0) || Number(t.volume24 ?? 0) * Number(t.lastPrice || 0)
}

function buildLevels(
  side: Side,
  entry: number,
  atr: number,
  style: TradeStyle = 'INTRADAY'
): { sl: number; tp: number } {
  // SCALP: tighter risk/reward; SWING: wider
  const riskMult = style === 'SCALP' ? 0.9 : style === 'SWING' ? 1.8 : 1.4
  const rewardMult = style === 'SCALP' ? 1.5 : style === 'SWING' ? 3.2 : 2.4
  const riskFloor = style === 'SCALP' ? 0.004 : style === 'SWING' ? 0.012 : 0.008
  const rewardFloor = style === 'SCALP' ? 0.007 : style === 'SWING' ? 0.022 : 0.015
  const risk = Math.max(atr * riskMult, entry * riskFloor)
  const reward = Math.max(atr * rewardMult, entry * rewardFloor)
  if (side === 'LONG') {
    return { sl: entry - risk, tp: entry + reward }
  }
  return { sl: entry + risk, tp: entry - reward }
}

interface MemeTargetPlan {
  tp1: number
  tp2: number
  tp3: number
  source1: string
  source2: string
  source3: string
}

function buildMemeTargetPlan(
  side: Side,
  entry: number,
  sl: number,
  atr: number,
  candles: Candle[],
  style: TradeStyle
): MemeTargetPlan {
  const riskPct = entry > 0 ? (Math.abs(entry - sl) / entry) * 100 : 0
  const atrPct = entry > 0 ? (atr / entry) * 100 : 0
  const floors =
    style === 'SCALP'
      ? [0.8, 1.8, 3.2]
      : style === 'SWING'
        ? [2, 5, 8]
        : [1.2, 2.8, 5]
  const caps =
    style === 'SCALP' ? [2, 4.5, 7] : style === 'SWING' ? [4, 9, 14] : [3, 6, 10]
  const riskMultiples = [1.2, 2.4, 4]
  const atrMultiples = [1.2, 2.5, 4]
  const closed = candles.length >= 2 ? candles.slice(0, -1) : candles
  const recent = closed.slice(-90)
  const rawLevels = recent.flatMap((c) =>
    side === 'LONG' ? [c[2]] : [c[3]]
  )

  const target = (
    index: number,
    previous: number | null
  ): { price: number; source: string } => {
    const previousPct =
      previous == null
        ? 0
        : side === 'LONG'
          ? ((previous - entry) / entry) * 100
          : ((entry - previous) / entry) * 100
    const desiredPct = Math.min(
      caps[index]!,
      Math.max(
        floors[index]!,
        riskPct * riskMultiples[index]!,
        atrPct * atrMultiples[index]!,
        previousPct + (index === 1 ? 0.8 : index === 2 ? 1.2 : 0)
      )
    )
    const projected =
      side === 'LONG'
        ? entry * (1 + desiredPct / 100)
        : entry * (1 - desiredPct / 100)
    const minDistance = desiredPct
    const maxDistance = caps[index]!
    const candidates = rawLevels
      .map((price) => ({
        price,
        distance:
          side === 'LONG'
            ? ((price - entry) / entry) * 100
            : ((entry - price) / entry) * 100,
      }))
      .filter(
        (level) =>
          level.distance >= minDistance &&
          level.distance <= maxDistance &&
          (previous == null ||
            (side === 'LONG'
              ? level.price > previous * 1.001
              : level.price < previous * 0.999))
      )
      .sort((a, b) => a.distance - b.distance)
    const liquidity = candidates[0]
    return liquidity
      ? { price: liquidity.price, source: 'локальная ликвидность' }
      : { price: projected, source: 'ATR/импульс' }
  }

  const t1 = target(0, null)
  const t2 = target(1, t1.price)
  const t3 = target(2, t2.price)
  return {
    tp1: t1.price,
    tp2: t2.price,
    tp3: t3.price,
    source1: t1.source,
    source2: t2.source,
    source3: t3.source,
  }
}

/**
 * Не «вход по рынку сейчас», а зона лимита на откат.
 * К моменту Telegram цена на мемах уже другая — chase запрещён.
 */
function buildEntryPlan(
  side: Side,
  signalPrice: number,
  atr: number,
  style: TradeStyle = 'INTRADAY'
): {
  signalPrice: number
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
} {
  const pullMult = style === 'SCALP' ? 0.45 : style === 'SWING' ? 1.1 : 0.7
  const pullFloor = style === 'SCALP' ? 0.004 : style === 'SWING' ? 0.012 : 0.008
  const pull = Math.max(atr * pullMult, signalPrice * pullFloor)
  const chase = Math.max(atr * 0.35, signalPrice * 0.005)
  // Zone is a true pullback area — current print is intentionally outside
  const cushion = Math.max(atr * 0.12, signalPrice * 0.0015)

  if (side === 'LONG') {
    const zoneHigh = signalPrice - cushion
    const zoneLow = signalPrice - pull
    const entryIdeal = (zoneLow + zoneHigh) / 2
    const invalidate = signalPrice + chase
    const { sl, tp } = buildLevels('LONG', entryIdeal, atr, style)
    return { signalPrice, entryIdeal, zoneLow, zoneHigh, invalidate, sl, tp }
  }

  const zoneLow = signalPrice + cushion
  const zoneHigh = signalPrice + pull
  const entryIdeal = (zoneLow + zoneHigh) / 2
  const invalidate = signalPrice - chase
  const { sl, tp } = buildLevels('SHORT', entryIdeal, atr, style)
  return { signalPrice, entryIdeal, zoneLow, zoneHigh, invalidate, sl, tp }
}

/** Price already left the limit zone → do not chase, wait pullback */
function isPriceChased(
  side: Side,
  price: number,
  zoneLow: number,
  zoneHigh: number
): boolean {
  if (side === 'LONG') return price > zoneHigh
  return price < zoneLow
}

/** Hard floor — sniper ≥60; meme rescue lower when impulse strong */
const MIN_WIN_PCT = 60
const MIN_WIN_PCT_MEME = 48

export type ScanMode = 'all' | 'meme' | 'sniper'

type TradeStyle = 'SCALP' | 'INTRADAY' | 'SWING'
type TrendAlign = 'WITH_TREND' | 'COUNTER'

function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function tfBias(candles: Candle[]): 'BULL' | 'BEAR' | 'FLAT' {
  if (candles.length < 25) return 'FLAT'
  const closes = candles.map((c) => c[4])
  const last = closes[closes.length - 1]
  const mid = sma(closes, 20)
  const rsi = calcRsi(closes)
  const look = Math.min(8, closes.length - 1)
  const mom =
    look > 0 && closes[closes.length - 1 - look] > 0
      ? ((last - closes[closes.length - 1 - look]) /
          closes[closes.length - 1 - look]) *
        100
      : 0
  if (last > mid * 1.0015 && rsi >= 53 && mom >= 0.12) return 'BULL'
  if (last < mid * 0.9985 && rsi <= 47 && mom <= -0.12) return 'BEAR'
  return 'FLAT'
}

function classifyAlign(
  side: Side,
  htf: 'BULL' | 'BEAR' | 'FLAT'
): TrendAlign {
  if (htf === 'FLAT') return 'WITH_TREND'
  if (
    (side === 'LONG' && htf === 'BULL') ||
    (side === 'SHORT' && htf === 'BEAR')
  ) {
    return 'WITH_TREND'
  }
  return 'COUNTER'
}

/**
 * Global = 4h (fallback 1h). Local = 15m.
 * Pullback: local against global but side follows global → still WITH_TREND.
 */
function resolveTrendContext(
  side: Side,
  bias15: 'BULL' | 'BEAR' | 'FLAT',
  bias1h: 'BULL' | 'BEAR' | 'FLAT',
  bias4h: 'BULL' | 'BEAR' | 'FLAT'
): { global: 'BULL' | 'BEAR' | 'FLAT'; local: 'BULL' | 'BEAR' | 'FLAT'; align: TrendAlign; pullback: boolean } {
  const global =
    bias4h !== 'FLAT' ? bias4h : bias1h !== 'FLAT' ? bias1h : bias15
  const local = bias15 !== 'FLAT' ? bias15 : bias1h
  const align = classifyAlign(side, global)
  const pullback =
    align === 'WITH_TREND' &&
    global !== 'FLAT' &&
    local !== 'FLAT' &&
    local !== global
  return { global, local, align, pullback }
}

/** Order-book imbalance −100…+100 (bids heavy → +) */
async function fetchBookImbalance(symbol: string): Promise<number | null> {
  const json = await mexcJson<{
    data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
  }>(`/api/v1/contract/depth/${symbol}?limit=20`)
  const asks = json?.data?.asks ?? []
  const bids = json?.data?.bids ?? []
  if (!asks.length || !bids.length) return null
  let askVol = 0
  let bidVol = 0
  for (const a of asks) askVol += Number(a[1] ?? 0)
  for (const b of bids) bidVol += Number(b[1] ?? 0)
  const tot = askVol + bidVol
  if (!(tot > 0)) return null
  return ((bidVol - askVol) / tot) * 100
}

/** Alt relative strength vs BTC over ~24×1h bars (pct points) */
function relStrengthVsBtc(alt1h: Candle[], btc1h: Candle[], lookback = 24): number | null {
  if (alt1h.length < lookback + 1 || btc1h.length < lookback + 1) return null
  const a = alt1h.slice(-(lookback + 1))
  const b = btc1h.slice(-(lookback + 1))
  const a0 = a[0][4]
  const b0 = b[0][4]
  if (!(a0 > 0) || !(b0 > 0)) return null
  const altChg = ((a[a.length - 1][4] - a0) / a0) * 100
  const btcChg = ((b[b.length - 1][4] - b0) / b0) * 100
  return altChg - btcChg
}

function coinStrengthLabel(rs: number | null, isBtc: boolean): string {
  if (isBtc) return 'BTC (якорь рынка)'
  if (rs == null) return 'RS vs BTC: н/д'
  if (rs >= 6) return `Сильная vs BTC (+${rs.toFixed(1)}%)`
  if (rs >= 3) return `Сильнее BTC (+${rs.toFixed(1)}%)`
  if (rs <= -6) return `Слабая vs BTC (${rs.toFixed(1)}%)`
  if (rs <= -3) return `Слабее BTC (${rs.toFixed(1)}%)`
  return `Корреляция с BTC (${rs >= 0 ? '+' : ''}${rs.toFixed(1)}%)`
}

/**
 * Score nudge from book + relative strength. Returns null if entry vetoed.
 */
function applyBookAndStrength(
  side: Side,
  score: number,
  bookImb: number | null,
  rs: number | null,
  isBtc: boolean,
  softMode: 'hard' | 'meme' | 'major' = 'hard'
): { score: number; note: string } | null {
  let s = score
  const notes: string[] = []
  const soft = softMode !== 'hard'
  // Meme: kill against sooner; require clearer alignment to boost
  const bookAgainst =
    softMode === 'meme' ? 22 : softMode === 'major' ? 32 : 22
  const bookAlign =
    softMode === 'meme' ? 15 : softMode === 'major' ? 14 : 18
  const rsWeak = softMode === 'meme' ? -14 : softMode === 'major' ? -10 : -6
  const rsStrong = softMode === 'meme' ? 14 : softMode === 'major' ? 10 : 6

  if (bookImb != null) {
    const aligned =
      (side === 'LONG' && bookImb >= bookAlign) ||
      (side === 'SHORT' && bookImb <= -bookAlign)
    const against =
      (side === 'LONG' && bookImb <= -bookAgainst) ||
      (side === 'SHORT' && bookImb >= bookAgainst)
    if (against) {
      // Meme: hard-kill if book clearly against (was soft → spam)
      if (softMode === 'meme') {
        return null
      }
      if (soft) {
        s -= 6
        notes.push(
          `Стакан против (OBI ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%) −6`
        )
      } else {
        return null
      }
    } else if (aligned) {
      s += softMode === 'meme' ? 6 : softMode === 'major' ? 5 : 6
      notes.push(`Стакан за вход (OBI ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%)`)
    } else {
      // Meme: neutral book is weak — haircut, caller may still require align
      if (softMode === 'meme') {
        s -= 4
        notes.push(
          `Стакан нейтрален (OBI ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%) −4`
        )
      } else {
        notes.push(`Стакан нейтрален (OBI ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%)`)
      }
    }
  } else {
    if (softMode === 'meme') {
      // No book → no meme alert (стакан обязателен)
      return null
    }
    notes.push('Стакан: нет данных')
  }

  if (!isBtc && rs != null) {
    if (side === 'LONG') {
      if (rs <= rsWeak) {
        if (soft) {
          s -= softMode === 'meme' ? 4 : 5
          notes.push(coinStrengthLabel(rs, false))
        } else return null
      } else if (rs >= 3) {
        s += Math.min(8, 3 + rs * 0.4)
        notes.push(coinStrengthLabel(rs, false))
      } else if (rs < -1.5) {
        s -= soft ? 2 : 4
        notes.push(coinStrengthLabel(rs, false))
      } else {
        notes.push(coinStrengthLabel(rs, false))
      }
    } else {
      if (rs >= rsStrong) {
        if (soft) {
          s -= softMode === 'meme' ? 4 : 5
          notes.push(coinStrengthLabel(rs, false))
        } else return null
      } else if (rs <= -3) {
        s += Math.min(8, 3 + Math.abs(rs) * 0.4)
        notes.push(coinStrengthLabel(rs, false))
      } else if (rs > 1.5) {
        s -= soft ? 2 : 4
        notes.push(coinStrengthLabel(rs, false))
      } else {
        notes.push(coinStrengthLabel(rs, false))
      }
    }
  } else if (isBtc) {
    notes.push(coinStrengthLabel(null, true))
  }

  return { score: Math.min(99, Math.max(0, s)), note: notes.join(' · ') }
}

function styleLabel(style: TradeStyle): string {
  if (style === 'SCALP') return 'СКАЛЬП'
  if (style === 'INTRADAY') return 'ИНТРАДЕЙ'
  return 'СВИНГ'
}

function alignLabel(align: TrendAlign): string {
  return align === 'WITH_TREND' ? 'по тренду' : 'против тренда'
}

/**
 * Explicit probability model for SCALP / INTRA / SWING × TREND / COUNTER.
 * Returns win% + factor lines shown in Telegram so the number is auditable.
 */
function computeSetupProbability(opts: {
  score: number
  align: TrendAlign
  style: TradeStyle
  regime: MarketRegime
  pullback: boolean
  bookImb: number | null
  rs: number | null
  isBtc: boolean
  rsi: number
  side: Side
  symbol?: string
  zone?: SmartZonePlan | null
  zoneFuelAdj?: number
  zoneFactors?: string[]
  marketCtx?: MarketContext | null
}): { winPct: number; factors: string[] } {
  const factors: string[] = []
  // Base from raw setup score (58→~65%, 90→~78%)
  let p = 48 + opts.score * 0.32
  factors.push(`база от score ${opts.score}: ${Math.round(p)}%`)

  if (opts.align === 'WITH_TREND') {
    p += opts.style === 'SCALP' ? 4 : 6
    factors.push(`+${opts.style === 'SCALP' ? 4 : 6}% по тренду`)
  } else {
    p -= opts.style === 'SCALP' ? 2 : 1
    factors.push(`−${opts.style === 'SCALP' ? 2 : 1}% контртренд (нужен сильный setup)`)
  }

  if (opts.style === 'SCALP') {
    p -= 1
    factors.push('−1% горизонт скальп (шумнее)')
  } else if (opts.style === 'SWING') {
    p += 2
    factors.push('+2% горизонт свинг')
  } else {
    factors.push('интрадей: без штрафа горизонта')
  }

  if (opts.pullback && opts.align === 'WITH_TREND') {
    p += 3
    factors.push('+3% откат в тренд')
  }

  if (opts.regime === 'TRENDING_STRONG' && opts.align === 'WITH_TREND') {
    p += 3
    factors.push('+3% режим TRENDING_STRONG')
  } else if (opts.regime === 'TRENDING_WEAK' && opts.align === 'WITH_TREND') {
    p += 1
    factors.push('+1% режим TRENDING_WEAK')
  } else if (opts.regime === 'VOLATILE_CHOP') {
    p -= opts.align === 'COUNTER' ? 4 : 2
    factors.push(
      opts.align === 'COUNTER' ? '−4% chop + контртренд' : '−2% режим VOLATILE_CHOP'
    )
  } else if (opts.regime === 'RANGING' && opts.style === 'SCALP') {
    p -= 1
    factors.push('−1% range + скальп')
  }

  if (opts.bookImb != null) {
    const aligned =
      (opts.side === 'LONG' && opts.bookImb >= 18) ||
      (opts.side === 'SHORT' && opts.bookImb <= -18)
    const against =
      (opts.side === 'LONG' && opts.bookImb <= -12) ||
      (opts.side === 'SHORT' && opts.bookImb >= 12)
    if (aligned) {
      p += 3
      factors.push(`+3% OBI за вход (${opts.bookImb >= 0 ? '+' : ''}${opts.bookImb.toFixed(0)}%)`)
    } else if (against) {
      p -= 3
      factors.push(`−3% OBI против (${opts.bookImb >= 0 ? '+' : ''}${opts.bookImb.toFixed(0)}%)`)
    }
  }

  if (!opts.isBtc && opts.rs != null) {
    if (opts.side === 'LONG' && opts.rs >= 3) {
      p += Math.min(4, 1 + opts.rs * 0.25)
      factors.push(`+RS vs BTC ${opts.rs.toFixed(1)}pp`)
    } else if (opts.side === 'SHORT' && opts.rs <= -3) {
      p += Math.min(4, 1 + Math.abs(opts.rs) * 0.25)
      factors.push(`+RS слабость vs BTC ${opts.rs.toFixed(1)}pp`)
    } else if (opts.side === 'LONG' && opts.rs <= -4) {
      p -= 3
      factors.push(`−3% слабый RS ${opts.rs.toFixed(1)}pp`)
    } else if (opts.side === 'SHORT' && opts.rs >= 4) {
      p -= 3
      factors.push(`−3% сильный RS против шорта ${opts.rs.toFixed(1)}pp`)
    }
  }

  // RSI confirmation / exhaustion
  if (opts.align === 'WITH_TREND') {
    if (opts.side === 'LONG' && opts.rsi >= 52 && opts.rsi <= 68) {
      p += 2
      factors.push(`+2% RSI в трендовой зоне (${opts.rsi.toFixed(0)})`)
    } else if (opts.side === 'SHORT' && opts.rsi <= 48 && opts.rsi >= 32) {
      p += 2
      factors.push(`+2% RSI в трендовой зоне (${opts.rsi.toFixed(0)})`)
    } else if (
      (opts.side === 'LONG' && opts.rsi >= 78) ||
      (opts.side === 'SHORT' && opts.rsi <= 22)
    ) {
      p -= 4
      factors.push(`−4% RSI перегрет для тренда (${opts.rsi.toFixed(0)})`)
    }
  } else {
    if (
      (opts.side === 'SHORT' && opts.rsi >= 72) ||
      (opts.side === 'LONG' && opts.rsi <= 28)
    ) {
      p += 4
      factors.push(`+4% RSI exhaustion для контртренда (${opts.rsi.toFixed(0)})`)
    }
  }

  // Mini App–parity: SSL/BSL strength + fuel
  if (opts.zoneFactors?.length) {
    p += opts.zoneFuelAdj ?? 0
    factors.push(...opts.zoneFactors)
  } else {
    const z = zoneProbabilityAdj(opts.zone ?? null, null)
    p += z.adj
    factors.push(...z.factors)
  }

  // Fear&Greed / coin news / BTC.D
  if (opts.marketCtx) {
    const cx = contextProbabilityAdj({
      side: opts.side,
      isBtc: opts.isBtc,
      symbol: opts.symbol,
      ctx: opts.marketCtx,
    })
    p += cx.adj
    factors.push(...cx.factors)
  }

  const winPct = Math.round(Math.min(88, Math.max(0, p)))
  return { winPct, factors: factors.slice(0, 10) }
}

function styleHashTag(
  style: TradeStyle,
  type: 'SNIPER' | 'MEME'
): string {
  if (type === 'MEME') return '#MEME'
  if (style === 'SCALP') return '#SCALP'
  if (style === 'SWING') return '#SWING'
  return '#INTRA'
}

function formatTradeAlert(opts: {
  side: Side
  symbol: string
  signalPrice: number
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
  winPct: number
  reason: string
  setup: string
  style: TradeStyle
  align: TrendAlign
  type: 'SNIPER' | 'MEME'
  whyNow: string[]
  contextLines: string[]
  probFactors: string[]
  chased: boolean
  zoneLines?: string[]
  targetLines?: string[]
  extras?: string[]
}): { title: string; text: string } {
  const name = opts.symbol.replace('_USDT', '/USDT')
  const icon = opts.side === 'LONG' ? '🟢' : '🔴'
  const tag = styleHashTag(opts.style, opts.type)
  const alignTag = opts.align === 'WITH_TREND' ? '#TREND' : '#COUNTER'
  const rr =
    Math.abs(opts.entryIdeal - opts.sl) > 0
      ? Math.abs(opts.tp - opts.entryIdeal) / Math.abs(opts.entryIdeal - opts.sl)
      : 0
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const chaseRule =
    opts.side === 'LONG'
      ? `Не входить / не догонять выше ${fmt(opts.invalidate)}`
      : `Не входить / не догонять ниже ${fmt(opts.invalidate)}`

  const title = `${tag} ${alignTag} ${icon} ${opts.side} ${name} · ${opts.winPct}% · ${opts.setup}`

  const entryBlock = opts.chased
    ? [
        `⚠️ Цена УЖЕ ушла от зоны — НЕ ДОГОНЯТЬ.`,
        `Жди откат в зону: ${fmt(opts.zoneLow)} – ${fmt(opts.zoneHigh)}`,
        `Лимитка: ${fmt(opts.entryIdeal)} · ${chaseRule}`,
        `Бот ставит авто-watch на откат (оповещу при касании).`,
      ]
    : [
        `Тип входа: ЛИМИТ на зону ликвидности — не маркет-chase`,
        `Зона входа: ${fmt(opts.zoneLow)} – ${fmt(opts.zoneHigh)}`,
        `Лимитка (ориентир): ${fmt(opts.entryIdeal)}`,
        chaseRule,
      ]

  const text = [
    `${tag} ${alignTag}`,
    `Сигнал: ${icon} ${opts.side} ${name}`,
    `Стиль: ${styleLabel(opts.style)} · ${alignLabel(opts.align)} · ${opts.type}`,
    `Вероятность: ${opts.winPct}% (порог ${MIN_WIN_PCT}%) · R:R 1:${rr.toFixed(1)}`,
    `Сигнал @ ${now}`,
    '',
    ...(opts.zoneLines?.length
      ? ['Анализ зоны (как в приложении):', ...opts.zoneLines.map((l) => `• ${l}`), '']
      : []),
    'Как посчитана вероятность:',
    ...opts.probFactors.map((l) => `• ${l}`),
    '',
    'Почему сейчас:',
    ...opts.whyNow.map((l) => `• ${l}`),
    '',
    `Цена сигнала: ${fmt(opts.signalPrice)}`,
    ...entryBlock,
    '',
    `Стоп: ${fmt(opts.sl)} (${pct(opts.entryIdeal, opts.sl)})`,
    ...(opts.targetLines?.length
      ? opts.targetLines
      : [
          `Цель (ближ. ликвидность): ${fmt(opts.tp)} (${pct(opts.entryIdeal, opts.tp)})`,
        ]),
    '',
    `Причина: ${opts.reason}`,
    '',
    'Контекст:',
    ...opts.contextLines.map((l) => `· ${l}`),
    ...(opts.extras?.length ? ['', ...opts.extras] : []),
    '',
    opts.chased
      ? '⏳ Только лимит в зоне. Вне зоны — пропуск.'
      : '⚠️ Подход → реакция/стакан → топливо до цели. Не догонять вне зоны.',
    '',
    `⚙ ${BOT_ENGINE.id} · ${BOT_ENGINE.label}`,
  ].join('\n')

  return { title, text }
}

function isMemeCandidate(t: TickerRow, tradable: Set<string>): boolean {
  if (!tradable.has(t.symbol)) return false
  if (!t.symbol.endsWith('_USDT')) return false
  if (BLUE_CHIPS.has(t.symbol)) return false
  const price = Number(t.lastPrice)
  const vol = quoteVol(t)
  // Memes / micro-caps — price ceiling was killing many liquid pumps
  return price > 0 && price <= 250 && vol >= MIN_MEME_QUOTE_VOL
}

/**
 * Full 24/7 scan cycle. Returns alerts to broadcast.
 * @param gates optional adaptive filters from bot journal outcomes
 * @param mode 'meme' = only meme universe (fast path for early TG send)
 */
export async function runMarketScan(
  gates?: BotAdaptiveGates | null,
  mode: ScanMode = 'all'
): Promise<ScanAlert[]> {
  const [tradable, tickers] = await Promise.all([
    fetchTradableSymbols(),
    fetchTickers(),
  ])
  if (!tickers.length || tradable.size === 0) return []

  // Liquid USDT-M perps only (top by quote volume) — matches what RF search shows
  const liquidUniverse = tickers
    .filter((t) => {
      if (!tradable.has(t.symbol)) return false
      if (!t.symbol.endsWith('_USDT')) return false
      if (t.symbol.includes('USDC')) return false
      const price = Number(t.lastPrice)
      const bid = Number(t.bid1 ?? 0)
      const ask = Number(t.ask1 ?? 0)
      const oi = Number(t.holdVol ?? 0)
      const vol = quoteVol(t)
      if (!(price > 0)) return false
      if (!(bid > 0) || !(ask > 0)) return false
      if (t.fundingRate == null) return false
      if (oi < MIN_OPEN_INTEREST) return false
      if (vol < MIN_MEME_QUOTE_VOL) return false
      return true
    })
    .sort((a, b) => quoteVol(b) - quoteVol(a))
    .slice(0, TOP_LIQUID_PERPS)

  const liquidSet = new Set(liquidUniverse.map((t) => t.symbol))

  // MEME universe: hottest 24h movers — NOT limited to top-volume slice only
  // (pumps often sit outside top-200 by quote vol until after the move).
  const memes = tickers
    .filter((t) => {
      if (!tradable.has(t.symbol)) return false
      if (!t.symbol.endsWith('_USDT')) return false
      if (t.symbol.includes('USDC')) return false
      if (BLUE_CHIPS.has(t.symbol)) return false
      const price = Number(t.lastPrice)
      const vol = quoteVol(t)
      const chgAbs = Math.abs(Number(t.riseFallRate) * 100)
      if (!(price > 0) || price > 250) return false
      if (vol < MIN_MEME_QUOTE_VOL) return false
      // Need a real move — filter noise before spending book/toxicity
      return chgAbs >= 6
    })
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 8)

  const movers = liquidUniverse
    .filter((t) => quoteVol(t) >= MIN_MOVER_QUOTE_VOL)
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 14)

  // Always scan majors (BTC + liquid alts) for SNIPER — not only when they
  // appear in the top movers list (otherwise quiet BTC weeks = zero alerts).
  const majors = liquidUniverse
    .filter((t) => BLUE_CHIPS.has(t.symbol))
    .slice(0, 16)

  const alerts: ScanAlert[] = []
  const seen = new Set<string>()
  const memeDeepSymbols = new Set<string>()

  // BTC HTF once per cycle — global picture for INTRA / SWING
  const [btc1h, btc4h, btc1d] =
    mode === 'meme'
      ? [await fetchKlines('BTC_USDT', 'Min60', 48), [], []]
      : await Promise.all([
          fetchKlines('BTC_USDT', 'Min60', 48),
          fetchKlines('BTC_USDT', 'Hour4', 90),
          fetchKlines('BTC_USDT', 'Day1', 60),
        ])
  const btcRegime: MarketRegime = detectMarketRegime(btc1h)
  const winCal: WinPctCalibrationEntry[] = gates?.winPctBySetup ?? []
  const marketCtx = await getMarketContext()
  const globalCtx: GlobalScanContext = buildGlobalScanContext({
    btc1h,
    btc4h,
    btc1d,
    marketCtx,
  })

  const analyze = async (t: TickerRow, preferMeme: boolean) => {
    if (seen.has(t.symbol)) return
    seen.add(t.symbol)
    // Sniper must be in liquid universe; memes may come from hotter mover list
    if (!preferMeme && !liquidSet.has(t.symbol)) return

    const isMajor = BLUE_CHIPS.has(t.symbol)
    const isBtc = t.symbol === 'BTC_USDT'
    const candles = await fetchKlines(t.symbol, 'Min1', 120)
    // No candles = not really tradeable / bad symbol
    if (candles.length < 40) return

    // Toxic chop: skip thin alts only (majors wick in trend)
    if (!preferMeme && !isMajor && toxicChop(candles)) return

    const price = Number(t.lastPrice)
    if (!(price > 0)) return

    const chg = Number(t.riseFallRate) * 100
    const funding = Number(t.fundingRate ?? 0)
    const fundingPct = funding * 100
    const oiChangePct = preferMeme
      ? observeMemeOi(t.symbol, Number(t.holdVol ?? 0))
      : null
    const atr = calcAtr(candles)
    if (!(atr > 0)) return

    // Bias: 15m/1h timing; Zones: ALWAYS 4H + Daily (never 15m as zone source)
    // MEME fast path: skip HTF klines — otherwise 28×4 requests kill the cron.
    let bias15: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT'
    let bias1h: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT'
    let bias4h: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT'
    let c1h: Candle[] = []
    let c4h: Candle[] = []
    let c1d: Candle[] = []
    if (preferMeme) {
      bias15 = chg >= 2 ? 'BULL' : chg <= -2 ? 'BEAR' : 'FLAT'
      bias1h = bias15
      bias4h = 'FLAT'
    } else {
      const frames = await Promise.all([
        fetchKlines(t.symbol, 'Min15', 64),
        fetchKlines(t.symbol, 'Min60', 48),
        fetchKlines(t.symbol, 'Hour4', 90),
        fetchKlines(t.symbol, 'Day1', 60),
      ])
      bias15 = tfBias(frames[0])
      c1h = frames[1]
      bias1h = tfBias(c1h)
      c4h = frames[2]
      bias4h = tfBias(c4h)
      c1d = frames[3]
    }
    const htfBias =
      bias4h !== 'FLAT' ? bias4h : bias1h !== 'FLAT' ? bias1h : bias15

    // Load depth only when this symbol actually has a trigger. All meme movers
    // still get the cheap candle scan; only the hottest three candidates spend
    // the deep-book request budget before Telegram delivery.
    let bookImb: number | null = null
    let bookLoaded = false
    const rs = isBtc || preferMeme ? null : relStrengthVsBtc(c1h, btc1h)
    const liqMap = preferMeme
      ? {
          equalHighs: [] as never[],
          equalLows: [] as never[],
          nearestBSL: null,
          nearestSSL: null,
          liquidityBoost: 0,
          primaryTf: '4H' as const,
        }
      : buildHtfLiquidityMap({
          candles4h: c4h,
          candles1d: c1d,
          candles1h: c1h,
          price,
        })
    const toxCache = new Map<Side, Awaited<ReturnType<typeof assessBookToxicity>>>()

    const spike = volumeSpike(candles)
    const burst = burstMove(candles, 5)
    const ignition = preferMeme
      ? { detected: false, mult: 0, movePct: 0 }
      : flatlineIgnition(candles)
    const highBroken = brokeLocalHigh(candles)
    const closes = candles.map((c) => c[4])
    const rsi = calcRsi(closes)
    const backside = !preferMeme && lowerHighAndBreak(candles) && rsi > 70
    const volUsd = quoteVol(t)
    const minVol = preferMeme ? MIN_MEME_QUOTE_VOL : MIN_MOVER_QUOTE_VOL

    const push = async (
      side: Side,
      setup: string,
      score: number,
      reason: string,
      extras: string[],
      type: 'SNIPER' | 'MEME',
      dedupeKey: string,
      style: TradeStyle,
      alignOverride?: TrendAlign
    ) => {
      if (!bookLoaded) {
        if (type === 'MEME') {
          if (
            !memeDeepSymbols.has(t.symbol) &&
            memeDeepSymbols.size >= 2
          ) {
            return
          }
          memeDeepSymbols.add(t.symbol)
        }
        bookImb = await fetchBookImbalance(t.symbol)
        bookLoaded = true
      }
      const ctx = resolveTrendContext(side, bias15, bias1h, bias4h)
      const align = alignOverride ?? ctx.align
      const composite = `${setup}_${style}_${align === 'WITH_TREND' ? 'TREND' : 'COUNTER'}`

      // Counter-trend needs a stronger raw score before win% mapping
      let scoreAdj =
        align === 'COUNTER' ? score : Math.min(99, score + (style === 'SWING' ? 2 : 0))
      if (ctx.pullback && align === 'WITH_TREND') {
        scoreAdj = Math.min(99, scoreAdj + 4) // HTF trend + LTF pullback
      }

      const regimeGate = regimeAllows(
        btcRegime,
        style,
        align,
        scoreAdj,
        type === 'MEME' || isMajor
      )
      if (!regimeGate.ok) return
      scoreAdj = regimeGate.scoreAdj

      // Global BTC picture — hard gate for SNIPER INTRA/SWING only.
      // MEME (pump/squeeze/ignition) is LTF impulse: soft score nudge, never silence.
      let globalAlignScore = 0
      if (type === 'MEME') {
        const soft = globalAllowsStyle({
          g: globalCtx,
          side,
          style,
          align,
          score: scoreAdj,
          isBtc,
        })
        globalAlignScore = soft.alignScore
        // Keep meme alive even if global says no — mild haircut only
        if (!soft.ok) {
          scoreAdj = Math.max(0, scoreAdj - 3)
        } else {
          scoreAdj = soft.scoreAdj
        }
      } else {
        const globalGate = globalAllowsStyle({
          g: globalCtx,
          side,
          style,
          align,
          score: scoreAdj,
          isBtc,
        })
        if (!globalGate.ok) return
        scoreAdj = globalGate.scoreAdj
        globalAlignScore = globalGate.alignScore
      }

      const gated = applyBookAndStrength(
        side,
        scoreAdj,
        bookImb,
        rs,
        isBtc,
        type === 'MEME' ? 'meme' : isMajor ? 'major' : 'hard'
      )
      if (!gated) return
      scoreAdj = gated.score

      // Spoof / iceberg — sniper hard; meme soft-kill on toxic, always assess
      let tox: Awaited<ReturnType<typeof assessBookToxicity>> = {
        toxic: false,
        scorePenalty: 0,
        notes: [],
        persistentBook: 'UNKNOWN',
      }
      {
        let cached = toxCache.get(side)
        if (!cached) {
          cached = await assessBookToxicity({
            symbol: t.symbol,
            side,
            mid: price,
            mexcJson,
          })
          toxCache.set(side, cached)
        }
        tox = cached
        if (tox.toxic) {
          if (type !== 'MEME' || tox.persistentBook === 'AGAINST') {
            return
          }
          // A single vanishing wall is noisy on memes: penalize it, but only
          // persistent pressure against the trade is a hard veto.
        }
        if (tox.scorePenalty > 0) {
          const penalty =
            type === 'MEME' ? Math.min(12, tox.scorePenalty) : tox.scorePenalty
          scoreAdj = Math.max(0, scoreAdj - penalty)
        }
      }

      const tape = readCandleTape(candles, side)
      const antiManip =
        type === 'MEME'
          ? assessMemeAntiManipulation({
              side,
              sessionChangePct: chg,
              candles,
              bookImbalance: bookImb,
              persistentBook: tox.persistentBook,
              tapePattern: tape.pattern,
              oiChangePct,
              fundingPct,
            })
          : null
      if (antiManip && !antiManip.ok) return
      if (antiManip?.evidence) {
        scoreAdj = Math.min(99, scoreAdj + Math.min(5, antiManip.evidence))
      }

      // ── Zones + tape ──────────────────────────────────────────────
      const smart = findSmartZone(side, price, liqMap, atr, {
        relaxed: isMajor || type === 'MEME',
      })
      const waitingPullback =
        smart != null &&
        (smart.phase === 'FAR' ||
          smart.phase === 'APPROACH' ||
          isPriceChased(side, price, smart.zoneLow, smart.zoneHigh))

      if (type === 'MEME') {
        if (isImpulseLate(candles, side, 6.5)) return
        // Need candle confirm OR strong book alignment
        const bookAligned =
          bookImb != null &&
          ((side === 'LONG' && bookImb >= 15) ||
            (side === 'SHORT' && bookImb <= -15))
        if (!tape.ok && !bookAligned) return
        if (!tape.ok) scoreAdj = Math.max(0, scoreAdj - 6)
        else scoreAdj = Math.min(99, Math.max(0, scoreAdj + tape.scoreAdj))
      } else {
        const lateThr = isMajor ? 3.2 : 2.4
        if (!waitingPullback) {
          if (tape.late) return
          if (isImpulseLate(candles, side, lateThr)) return
          if (!tape.ok) return
        } else if (smart?.phase === 'TOUCH' && !tape.ok) {
          return
        }
        scoreAdj = Math.min(99, Math.max(0, scoreAdj + tape.scoreAdj))

        if (!smart) return
        const minStr = isMajor ? 4 : 5
        if (smart.strength < minStr) return
        scoreAdj = Math.min(
          99,
          scoreAdj +
            Math.round(liqMap.liquidityBoost * 3) +
            (smart.tf === '1D' ? 4 : 2)
        )
      }

      const fuel = smart
        ? assessZoneFuel({
            side,
            price,
            zoneLow: smart.zoneLow,
            zoneHigh: smart.zoneHigh,
            candles1m: candles,
            bookImb,
          })
        : null
      // SNIPER strength already gated above; meme uses zone only as fuel nudge

      // Adaptive journal: blocked tags — SNIPER only.
      // MEME cold-streak blocks were silencing the whole impulse channel.
      if (gates) {
        if (
          type === 'SNIPER' &&
          isSetupBlocked(gates, setup, composite) &&
          scoreAdj < 95
        ) {
          return
        }
      }
      if (fuel) scoreAdj = Math.max(0, Math.min(99, scoreAdj + fuel.scoreAdj))

      // Mini App confluence: OB / FVG / raid / absorption + ScoreCard
      const conf = analyzeConfluence({
        candles4h: c4h,
        candles1m: candles,
        side,
        price,
      })
      if (conf.raid.detected) {
        scoreAdj = Math.min(99, scoreAdj + Math.round(conf.raid.scoreBoost * 2))
      }
      if (
        conf.absorption.detected &&
        (conf.absorption.sideHint == null || conf.absorption.sideHint === side)
      ) {
        scoreAdj = Math.min(99, scoreAdj + 4)
      }
      if (conf.inOrderBlock) scoreAdj = Math.min(99, scoreAdj + 3)
      if (conf.inFvg) scoreAdj = Math.min(99, scoreAdj + 2)

      const atrPreview = buildEntryPlan(side, price, atr, style)
      const entryPx = smart ? smart.limitEntry : atrPreview.entryIdeal
      const slPx = smart ? smart.invalidate : atrPreview.sl
      const tpPx = smart ? smart.target : atrPreview.tp

      const scoreCard = buildBotScoreCard({
        side,
        style,
        bias4h,
        bias1h,
        align,
        regime: btcRegime,
        bookImb,
        raid: conf.raid,
        absorption: conf.absorption,
        inOrderBlock: conf.inOrderBlock,
        inFvg: conf.inFvg,
        hasHtfZone: Boolean(smart),
        zoneStrength: smart?.strength ?? 0,
        entry: entryPx,
        sl: slPx,
        tp: tpPx,
        toxicBook: false,
      })
      // MEME: need solid score + book already gated
      if (type === 'MEME' && scoreAdj < 70) return
      if (type === 'SNIPER' && !scoreCard.ready) return
      if (
        type === 'SNIPER' &&
        scoreCard.grade === 'B' &&
        !(isMajor && scoreAdj >= 70)
      ) {
        return
      }
      if (scoreCard.grade === 'A+') scoreAdj = Math.min(99, scoreAdj + 4)
      else if (scoreCard.grade === 'A') scoreAdj = Math.min(99, scoreAdj + 2)
      else if (scoreCard.grade === 'B') scoreAdj = Math.min(99, scoreAdj + 1)

      // Min score AFTER boosts
      if (gates && type === 'SNIPER') {
        const min = Math.min(gates.minSniperScore, isMajor ? 76 : 80)
        const boost = isSetupBoosted(gates, setup, composite) ? -4 : 0
        if (scoreAdj < min + boost) return
      }
      if (gates && type === 'MEME') {
        const min = Math.min(gates.minMemeScore, 72)
        if (scoreAdj < min) return
      }

      const zAdj = zoneProbabilityAdj(smart, fuel)
      const gProb = globalProbabilityFactors({
        g: globalCtx,
        side,
        style,
        alignScore: globalAlignScore,
      })
      const prior = computeSetupProbability({
        score: scoreAdj,
        align,
        style,
        regime: btcRegime,
        pullback: ctx.pullback || smart?.phase === 'APPROACH',
        bookImb,
        rs,
        isBtc,
        rsi,
        side,
        symbol: t.symbol,
        zone: smart,
        zoneFuelAdj: zAdj.adj,
        zoneFactors: zAdj.factors,
        marketCtx,
      })
      const priorWin = Math.max(
        20,
        Math.min(92, prior.winPct + gProb.adj)
      )
      let cal = calibrateWinPct(priorWin, composite, winCal)
      const winFloor = type === 'MEME' ? MIN_WIN_PCT_MEME : MIN_WIN_PCT
      let winPct = cal.winPct
      // Meme confidence stays conservative until enough real outcomes exist.
      if (type === 'MEME') {
        const memePrior = Math.max(
          winFloor,
          Math.min(72, Math.round(38 + scoreAdj * 0.34))
        )
        cal = calibrateWinPct(memePrior, composite, winCal)
        const cap = cal.sampleN >= 20 ? 78 : 72
        winPct = Math.min(cap, cal.winPct)
      } else if (
        winPct < winFloor &&
        priorWin >= winFloor &&
        scoreAdj >= 84
      ) {
        winPct = winFloor
      }
      if (winPct < winFloor) return
      // INTRA/SWING SNIPER: prefer setups that agree with global picture
      if (
        type === 'SNIPER' &&
        (style === 'INTRADAY' || style === 'SWING') &&
        align === 'WITH_TREND' &&
        globalAlignScore < 1 &&
        winPct < (isMajor ? 64 : 72)
      ) {
        return
      }

      // Final live check — skip for MEME (3 extra API calls were killing throughput)
      if (type !== 'MEME' && !(await isSymbolTradableNow(t.symbol, minVol))) {
        return
      }

      const atrPlan = buildEntryPlan(side, price, atr, style)
      const memeTargets =
        type === 'MEME' && !smart
          ? buildMemeTargetPlan(
              side,
              atrPlan.entryIdeal,
              atrPlan.sl,
              atr,
              candles,
              style
            )
          : null
      const plan = smart
        ? {
            signalPrice: price,
            entryIdeal: smart.limitEntry,
            zoneLow: smart.zoneLow,
            zoneHigh: smart.zoneHigh,
            invalidate: smart.invalidate,
            sl: smart.invalidate,
            tp: smart.target,
          }
        : memeTargets
          ? {
              ...atrPlan,
              tp: memeTargets.tp2,
              target1: memeTargets.tp1,
              target3: memeTargets.tp3,
            }
          : atrPlan
      const chased =
        type === 'MEME'
          ? false
          : isPriceChased(side, price, plan.zoneLow, plan.zoneHigh)
      const watchOnly = false
      const targetLines = memeTargets
        ? [
            `TP1 35%: ${fmt(memeTargets.tp1)} (${pct(plan.entryIdeal, memeTargets.tp1)}) · ${memeTargets.source1}`,
            `TP2 45%: ${fmt(memeTargets.tp2)} (${pct(plan.entryIdeal, memeTargets.tp2)}) · ${memeTargets.source2}`,
            `TP3 runner 20%: ${fmt(memeTargets.tp3)} (${pct(plan.entryIdeal, memeTargets.tp3)}) · ${memeTargets.source3}`,
            `Держать до TP2, пока OBI/лента за ${side}; после TP1 стоп → BE.`,
          ]
        : undefined

      const obiStr =
        bookImb == null
          ? 'n/a'
          : `${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%`
      const rsStr =
        isBtc || rs == null
          ? isBtc
            ? 'BTC (база)'
            : 'n/a'
          : `${rs >= 0 ? '+' : ''}${rs.toFixed(1)}pp vs BTC 24h`

      const zoneLines = smart
        ? [
            ...smart.reasoning,
            ...(fuel?.lines ?? []),
            `ScoreCard ${scoreCard.grade}: ${scoreCard.total}/${scoreCard.max} (${scoreCard.percent}%)`,
            ...scoreCard.factors.slice(0, 6),
            ...conf.lines,
            `Цель полёта: ${smart.targetLabel}`,
          ]
        : [
            '⚠️ Нет HTF SSL/BSL 4H+ — только meme/ATR fallback',
            `ScoreCard ${scoreCard.grade}: ${scoreCard.total}/${scoreCard.max}`,
            ...conf.lines,
          ]

      const whyNow: string[] = [
        smart
          ? `${smart.tf} ${smart.source} ${smart.phase} · сила ${smart.strength}/10`
          : reason.length > 140
            ? `${reason.slice(0, 137)}…`
            : reason,
        globalCtx.summary,
        `Монета: 1h ${bias1h} / 4h ${bias4h} · BTC align ${globalAlignScore >= 0 ? '+' : ''}${globalAlignScore}`,
      ].slice(0, 3)

      const probFactors = [
        ...prior.factors,
        ...gProb.factors.slice(0, 3),
        cal.source === 'PRIOR'
          ? `журнал: мало данных → модель ${priorWin}%`
          : `журнал ⊕ ${cal.sampleN} сделок (${cal.source}): ${priorWin}% → ${winPct}%`,
      ]

      const contextLines = [
        ...globalCtx.lines,
        `Монета 1h: ${bias1h} · 4h: ${bias4h} · 15m: ${bias15}`,
        `OBI: ${obiStr} · RS: ${rsStr}`,
        `Режим BTC 1H: ${btcRegime} · 4H: ${globalCtx.regime4h}`,
        ...marketCtx.lines.filter((l) => !globalCtx.lines.includes(l)),
        gated.note,
        `Тренд: глобальный ${ctx.global} · локальный ${ctx.local}${
          ctx.pullback ? ' · откат в тренд' : ''
        }`,
        `Ликвидность HTF: SSL ${
          liqMap.nearestSSL
            ? `${liqMap.nearestSSL.tf} ×${liqMap.nearestSSL.touches} ${liqMap.nearestSSL.strength}`
            : '—'
        } · BSL ${
          liqMap.nearestBSL
            ? `${liqMap.nearestBSL.tf} ×${liqMap.nearestBSL.touches} ${liqMap.nearestBSL.strength}`
            : '—'
        } · boost ${liqMap.liquidityBoost.toFixed(2)}`,
        `24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · Vol ≈ $${(volUsd / 1e6).toFixed(2)}M · RSI ${rsi.toFixed(0)} · FR ${fundingPct.toFixed(3)}%`,
        ...tox.notes,
        ...(antiManip?.notes ?? []),
        `Свечи: ${tape.pattern} — ${tape.note}`,
        ...extras,
      ]

      const msg = formatTradeAlert({
        side,
        symbol: t.symbol,
        signalPrice: plan.signalPrice,
        entryIdeal: plan.entryIdeal,
        zoneLow: plan.zoneLow,
        zoneHigh: plan.zoneHigh,
        invalidate: plan.invalidate,
        sl: plan.sl,
        tp: plan.tp,
        winPct,
        reason,
        setup,
        style,
        align,
        type,
        whyNow,
        contextLines,
        probFactors,
        zoneLines,
        targetLines,
        chased,
      })
      alerts.push({
        type,
        title: msg.title,
        text: msg.text,
        dedupeKey,
        score: scoreAdj,
        winPct,
        style,
        align,
        globalAlignScore,
        watchOnly,
        // MEME always gets server follow-up watch (стакан/реакция после сигнала)
        needsPullbackWatch:
          type === 'MEME' ||
          watchOnly ||
          chased ||
          smart?.phase === 'FAR' ||
          smart?.phase === 'APPROACH',
        tradePlan: {
          side,
          symbol: t.symbol,
          setup: composite,
          signalPrice: plan.signalPrice,
          entryIdeal: plan.entryIdeal,
          zoneLow: plan.zoneLow,
          zoneHigh: plan.zoneHigh,
          invalidate: plan.invalidate,
          sl: plan.sl,
          tp: plan.tp,
          target1: 'target1' in plan ? plan.target1 : undefined,
          target3: 'target3' in plan ? plan.target3 : undefined,
          zoneSource: smart?.source ?? 'ATR',
          zoneStrength: smart?.strength,
          zoneTouches: smart?.touches,
          targetLabel: smart?.targetLabel,
          zonePhase: smart?.phase,
        },
      })
    }

    // ── SHORT SQUEEZE → LONG (MEME / COUNTER) ──────────────────────
    const deeplyNeg = fundingPct <= -0.05 || fundingPct * 3 <= -0.15
    if (deeplyNeg && highBroken && (spike.detected || chg >= 8)) {
      await push(
        'LONG',
        'SQUEEZE',
        90,
        `Short squeeze: funding ${fundingPct.toFixed(3)}%, пробой локального хая${
          spike.detected ? `, объём ×${spike.mult.toFixed(1)}` : ''
        }. Толпа в шортах — давление вверх.`,
        [],
        'MEME',
        `cron:squeeze:${t.symbol}`,
        'INTRADAY',
        'COUNTER'
      )
      // Also offer a scalp continuation if impulse is hot
      if (spike.detected && spike.mult >= 3) {
        await push(
          'LONG',
          'SQUEEZE',
          88,
          `Squeeze-скальп: объём ×${spike.mult.toFixed(1)}, funding ${fundingPct.toFixed(3)}%.`,
          [],
          'MEME',
          `cron:squeeze_scalp:${t.symbol}`,
          'SCALP',
          'COUNTER'
        )
      }
      if (preferMeme) return
    } else if (
      deeplyNeg &&
      !highBroken &&
      (spike.detected || chg >= 10)
    ) {
      await push(
        'LONG',
        'SQUEEZE',
        84,
        `Short squeeze (мягкий): funding ${fundingPct.toFixed(3)}% без пробоя хая.`,
        [],
        'MEME',
        `cron:squeeze_soft:${t.symbol}`,
        'INTRADAY',
        'COUNTER'
      )
      if (preferMeme) return
    }

    // ── IGNITION → SCALP (+ optional INTRA) ────────────────────────
    if (ignition.detected) {
      await push(
        'LONG',
        'IGNITION',
        86,
        `Flatline ignition: объём ×${ignition.mult.toFixed(0)} от часовой базы, импульс ${ignition.movePct.toFixed(1)}% после сжатия.`,
        [],
        'MEME',
        `cron:ignition:${t.symbol}`,
        'SCALP'
      )
      if (ignition.movePct >= 2.5) {
        await push(
          'LONG',
          'IGNITION',
          84,
          `Ignition → интрадей продолжение: импульс ${ignition.movePct.toFixed(1)}%.`,
          [],
          'MEME',
          `cron:ignition_intra:${t.symbol}`,
          'INTRADAY'
        )
      }
      if (preferMeme) return
    }

    // ── VOLUME PUMP / DUMP · SCALP ─────────────────────────────────
    const spikeMultMin = preferMeme ? 2.6 : isMajor ? 2.2 : 4
    const spikeMoveMin = preferMeme ? 1.0 : isMajor ? 0.7 : 2
    if (
      spike.detected &&
      spike.mult >= spikeMultMin &&
      Math.abs(spike.movePct) >= spikeMoveMin
    ) {
      const isLong = spike.movePct > 0
      const side: Side = isLong ? 'LONG' : 'SHORT'
      const align = classifyAlign(side, bias15 !== 'FLAT' ? bias15 : htfBias)
      const baseScore = Math.min(95, (preferMeme ? 74 : 58) + spike.mult * 4)
      const score = align === 'COUNTER' ? baseScore + 4 : baseScore
      await push(
        side,
        isLong ? 'PUMP' : 'DUMP',
        score,
        `Всплеск объёма ×${spike.mult.toFixed(1)} за 1м, движение ${
          spike.movePct >= 0 ? '+' : ''
        }${spike.movePct.toFixed(2)}% · ${alignLabel(align)}.`,
        [],
        preferMeme ? 'MEME' : 'SNIPER',
        `cron:spike:${t.symbol}:${isLong ? 'PUMP' : 'DUMP'}`,
        'SCALP',
        align
      )
      if (preferMeme) return
    }

    // ── MEME 5m burst — only strong + book will still gate in push ─
    if (preferMeme && burst.detected && Math.abs(burst.movePct) >= 3.5) {
      const isLong = burst.movePct > 0
      const side: Side = isLong ? 'LONG' : 'SHORT'
      await push(
        side,
        isLong ? 'PUMP' : 'DUMP',
        Math.min(88, 72 + Math.abs(burst.movePct)),
        `Импульс 5м ${burst.movePct >= 0 ? '+' : ''}${burst.movePct.toFixed(1)}% · 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%.`,
        ['#MEME #BURST'],
        'MEME',
        `cron:meme_burst:${t.symbol}:${isLong ? 'L' : 'S'}`,
        'SCALP',
        'WITH_TREND'
      )
      return
    }

    // ── MEME session — only big day movers (book/tape gate in push) ─
    if (preferMeme && Math.abs(chg) >= 12 && chg > 0 && rsi >= 52) {
      await push(
        'LONG',
        'PUMP',
        Math.min(86, 70 + Math.abs(chg) * 0.25),
        `Мем-ход +${chg.toFixed(1)}% / 24h, RSI ${rsi.toFixed(0)}${
          spike.detected ? `, объём ×${spike.mult.toFixed(1)}` : ''
        }.`,
        ['#MEME #SESSION'],
        'MEME',
        `cron:meme_session:${t.symbol}:L`,
        'SCALP',
        'WITH_TREND'
      )
      return
    }
    if (preferMeme && Math.abs(chg) >= 14 && chg < 0 && rsi <= 48) {
      await push(
        'SHORT',
        'DUMP',
        Math.min(86, 70 + Math.abs(chg) * 0.2),
        `Мем-дамп ${chg.toFixed(1)}% / 24h, RSI ${rsi.toFixed(0)}.`,
        ['#MEME #SESSION'],
        'MEME',
        `cron:meme_session:${t.symbol}:S`,
        'SCALP',
        'WITH_TREND'
      )
      return
    }

    // ── MAJORS / LIQUID: explicit SCALP & INTRA × TREND / COUNTER ──
    if (!preferMeme && (isMajor || volUsd >= MIN_MOVER_QUOTE_VOL)) {
      const sessionMove = Math.abs(chg)
      const trendSide: Side | null =
        bias1h === 'BULL' || (bias1h === 'FLAT' && bias15 === 'BULL')
          ? 'LONG'
          : bias1h === 'BEAR' || (bias1h === 'FLAT' && bias15 === 'BEAR')
            ? 'SHORT'
            : null

      // SCALP WITH_TREND — short impulse in direction of 15m/1h
      const scalpMoveMin = isMajor ? 0.7 : 1.2
      if (
        trendSide &&
        ((trendSide === 'LONG' && bias15 === 'BULL' && rsi >= 48 && rsi <= 72) ||
          (trendSide === 'SHORT' && bias15 === 'BEAR' && rsi <= 52 && rsi >= 28)) &&
        (spike.detected || sessionMove >= scalpMoveMin)
      ) {
        await push(
          trendSide,
          trendSide === 'LONG' ? 'SCALP_LONG' : 'SCALP_SHORT',
          Math.min(92, 70 + sessionMove * 1.5 + (spike.detected ? 4 : 0)),
          `Скальп по тренду: 15m ${bias15}, 1h ${bias1h}, RSI ${rsi.toFixed(0)}, 24h ${
            chg >= 0 ? '+' : ''
          }${chg.toFixed(1)}%${spike.detected ? `, объём ×${spike.mult.toFixed(1)}` : ''}.`,
          ['#SCALP #TREND'],
          'SNIPER',
          `cron:scalp_trend:${t.symbol}:${trendSide}`,
          'SCALP',
          'WITH_TREND'
        )
      }

      // SCALP COUNTER — local exhaustion vs HTF
      if (
        htfBias !== 'FLAT' &&
        sessionMove >= (isMajor ? 1.6 : 2.5) &&
        ((htfBias === 'BULL' && rsi >= (isMajor ? 68 : 72) && chg > 0) ||
          (htfBias === 'BEAR' && rsi <= (isMajor ? 32 : 28) && chg < 0))
      ) {
        const side: Side = htfBias === 'BULL' ? 'SHORT' : 'LONG'
        await push(
          side,
          'SCALP_FADE',
          Math.min(93, 74 + sessionMove),
          `Скальп против тренда: HTF ${htfBias}, RSI ${rsi.toFixed(0)} — локальный fade, не свинг.`,
          ['#SCALP #COUNTER'],
          'SNIPER',
          `cron:scalp_counter:${t.symbol}:${side}`,
          'SCALP',
          'COUNTER'
        )
      }

      // INTRADAY WITH_TREND
      if (
        trendSide &&
        sessionMove >= (isMajor ? 1.0 : 1.8) &&
        ((trendSide === 'LONG' && rsi >= 50 && rsi <= 74 && chg > 0) ||
          (trendSide === 'SHORT' && rsi <= 50 && rsi >= 26 && chg < 0))
      ) {
        await push(
          trendSide,
          trendSide === 'LONG' ? 'TREND_LONG' : 'TREND_SHORT',
          Math.min(90, 68 + sessionMove * 1.2),
          `Интрадей по тренду ${t.symbol}: 1h ${bias1h}, 15m ${bias15}, 24h ${
            chg >= 0 ? '+' : ''
          }${chg.toFixed(1)}%, RSI ${rsi.toFixed(0)}.`,
          ['#INTRA #TREND'],
          'SNIPER',
          `cron:intra_trend:${t.symbol}:${trendSide}`,
          'INTRADAY',
          'WITH_TREND'
        )
      }

      // INTRADAY COUNTER (exhaustion)
      if (
        htfBias !== 'FLAT' &&
        sessionMove >= (isMajor ? 2.2 : 3.5) &&
        ((htfBias === 'BULL' && rsi >= (isMajor ? 68 : 72) && chg > 0) ||
          (htfBias === 'BEAR' && rsi <= (isMajor ? 32 : 28) && chg < 0))
      ) {
        const side: Side = htfBias === 'BULL' ? 'SHORT' : 'LONG'
        await push(
          side,
          'EXHAUST',
          Math.min(92, 72 + sessionMove),
          `Интрадей против тренда: HTF ${htfBias}, RSI ${rsi.toFixed(
            0
          )}, 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% — перегрев / истощение.`,
          ['#INTRA #COUNTER'],
          'SNIPER',
          `cron:intra_counter:${t.symbol}:${side}`,
          'INTRADAY',
          'COUNTER'
        )
      }

      // SWING WITH TREND — coin 4h + BTC Daily/4H global picture
      if (
        bias4h !== 'FLAT' &&
        sessionMove >= (isMajor ? 1.0 : 1.6) &&
        ((bias4h === 'BULL' && chg > 0 && rsi >= 46 && rsi <= 72) ||
          (bias4h === 'BEAR' && chg < 0 && rsi <= 54 && rsi >= 28))
      ) {
        const side: Side = bias4h === 'BULL' ? 'LONG' : 'SHORT'
        const globalOk =
          globalCtx.preferSwingSide == null ||
          globalCtx.preferSwingSide === side ||
          globalCtx.btcGlobal === 'FLAT'
        if (globalOk) {
          await push(
            side,
            side === 'LONG' ? 'SWING_LONG' : 'SWING_SHORT',
            Math.min(
              93,
              72 +
                sessionMove +
                (globalCtx.preferSwingSide === side ? 4 : 0) +
                (globalCtx.dayColor === (side === 'LONG' ? 'GREEN' : 'RED')
                  ? 3
                  : 0)
            ),
            `Свинг по глобали: BTC D ${globalCtx.btcBias1d}/${globalCtx.dayColor}, 4H ${globalCtx.btcBias4h}; монета 4h ${bias4h}, 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%, RSI ${rsi.toFixed(0)}.`,
            ['#SWING #TREND', '#GLOBAL'],
            'SNIPER',
            `cron:swing_trend:${t.symbol}:${side}`,
            'SWING',
            'WITH_TREND'
          )
        }
      }

      // SWING COUNTER — only with extreme RSI + F&G (gated in globalAllowsStyle)
      if (
        bias4h !== 'FLAT' &&
        sessionMove >= (isMajor ? 3.5 : 6) &&
        ((bias4h === 'BULL' && rsi >= (isMajor ? 72 : 78)) ||
          (bias4h === 'BEAR' && rsi <= (isMajor ? 28 : 22)))
      ) {
        const side: Side = bias4h === 'BULL' ? 'SHORT' : 'LONG'
        await push(
          side,
          'SWING_FADE',
          Math.min(93, 76 + sessionMove * 0.6),
          `Свинг против тренда: 4h ${bias4h}, экстремальный RSI ${rsi.toFixed(
            0
          )}, ход ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%.`,
          ['#SWING #COUNTER'],
          'SNIPER',
          `cron:swing_counter:${t.symbol}:${side}`,
          'SWING',
          'COUNTER'
        )
      }

      // GLOBAL INTRA — BTC 4H picture + coin pullback into HTF zone
      const gIntra = globalCtx.preferIntraSide
      if (
        gIntra &&
        (bias4h === (gIntra === 'LONG' ? 'BULL' : 'BEAR') ||
          bias1h === (gIntra === 'LONG' ? 'BULL' : 'BEAR') ||
          (bias15 !== (gIntra === 'LONG' ? 'BULL' : 'BEAR') &&
            bias4h === (gIntra === 'LONG' ? 'BULL' : 'BEAR')))
      ) {
        const pullbackIntoTrend =
          (gIntra === 'LONG' &&
            (bias15 === 'BEAR' || bias15 === 'FLAT') &&
            rsi <= 55) ||
          (gIntra === 'SHORT' &&
            (bias15 === 'BULL' || bias15 === 'FLAT') &&
            rsi >= 45)
        if (pullbackIntoTrend || sessionMove >= 1.2) {
          await push(
            gIntra,
            gIntra === 'LONG' ? 'GLOBAL_INTRA_LONG' : 'GLOBAL_INTRA_SHORT',
            Math.min(
              92,
              74 +
                (pullbackIntoTrend ? 5 : 0) +
                (globalCtx.h4Color === (gIntra === 'LONG' ? 'GREEN' : 'RED')
                  ? 3
                  : 0) +
                Math.min(6, sessionMove)
            ),
            `Интрадей от глобали BTC: 4H ${globalCtx.btcBias4h}/${globalCtx.h4Color}, D ${globalCtx.btcBias1d}; монета ждёт зону (${bias15}/${bias1h}), RSI ${rsi.toFixed(0)}.`,
            ['#INTRA #TREND', '#GLOBAL'],
            'SNIPER',
            `cron:global_intra:${t.symbol}:${gIntra}`,
            'INTRADAY',
            'WITH_TREND'
          )
        }
      }

      // GLOBAL SWING — Daily BTC closed in direction + coin HTF agrees
      const gSwing = globalCtx.preferSwingSide
      if (
        gSwing &&
        bias4h === (gSwing === 'LONG' ? 'BULL' : 'BEAR') &&
        (globalCtx.dayColor === (gSwing === 'LONG' ? 'GREEN' : 'RED') ||
          globalCtx.btcBias1d === (gSwing === 'LONG' ? 'BULL' : 'BEAR'))
      ) {
        await push(
          gSwing,
          gSwing === 'LONG' ? 'GLOBAL_SWING_LONG' : 'GLOBAL_SWING_SHORT',
          Math.min(
            94,
            76 +
              (globalCtx.regime4h === 'TRENDING_STRONG' ? 4 : 0) +
              (globalCtx.dayColor === (gSwing === 'LONG' ? 'GREEN' : 'RED')
                ? 3
                : 0)
          ),
          `Свинг от глобали: день BTC ${globalCtx.dayColor}, D-bias ${globalCtx.btcBias1d}, 4H ${globalCtx.btcBias4h}/${globalCtx.regime4h}; монета 4h ${bias4h}.`,
          ['#SWING #TREND', '#GLOBAL'],
          'SNIPER',
          `cron:global_swing:${t.symbol}:${gSwing}`,
          'SWING',
          'WITH_TREND'
        )
      }
    }

    // ── LEGACY MAJOR PULSE (fallback if nothing else fired for symbol) ─
    if (
      !preferMeme &&
      isMajor &&
      !alerts.some((a) => a.tradePlan?.symbol === t.symbol)
    ) {
      const impulse = Math.abs(spike.movePct)
      const sessionMove = Math.abs(chg)
      if (
        (spike.detected && impulse >= 0.5 && sessionMove >= 1.2) ||
        (sessionMove >= 2.5 && rsi > 58 && chg > 0) ||
        (sessionMove >= 2.5 && rsi < 42 && chg < 0)
      ) {
        const isLong = chg >= 0
        const side: Side = isLong ? 'LONG' : 'SHORT'
        const align = classifyAlign(side, htfBias)
        await push(
          side,
          isLong ? 'TREND_LONG' : 'TREND_SHORT',
          Math.min(88, 66 + sessionMove),
          `Major pulse ${t.symbol}: 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%, RSI ${rsi.toFixed(0)}${
            spike.detected ? `, объём ×${spike.mult.toFixed(1)}` : ''
          }.`,
          ['Blue-chip fallback'],
          'SNIPER',
          `cron:major:${t.symbol}:${isLong ? 'L' : 'S'}`,
          'INTRADAY',
          align
        )
      }
    }

    // ── BACKSIDE SHORT · INTRA / SWING COUNTER ─────────────────────
    if (backside && chg >= 25) {
      await push(
        'SHORT',
        'BACKSIDE',
        82,
        `Backside short: +${chg.toFixed(0)}% за 24ч, RSI ${rsi.toFixed(
          0
        )}, lower high + слом структуры. Топливо сквиза выгорает.`,
        [
          fundingPct > -0.01
            ? 'Funding нормализовался'
            : `FR ещё ${fundingPct.toFixed(3)}% — осторожно`,
        ],
        preferMeme ? 'MEME' : 'SNIPER',
        `cron:backside:${t.symbol}`,
        chg >= 40 ? 'SWING' : 'INTRADAY',
        'COUNTER'
      )
      if (chg >= 30 && rsi >= 75) {
        await push(
          'SHORT',
          'BACKSIDE',
          80,
          `Backside-скальп: локальный fade после +${chg.toFixed(0)}%.`,
          [],
          preferMeme ? 'MEME' : 'SNIPER',
          `cron:backside_scalp:${t.symbol}`,
          'SCALP',
          'COUNTER'
        )
      }
    }
  }

  if (mode !== 'sniper') {
    for (const t of memes) {
      await analyze(t, true)
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  if (mode === 'meme') {
    return rankAndSelectAlerts(alerts.filter((a) => a.type === 'MEME'))
  }
  for (const t of majors) {
    await analyze(t, false)
    await new Promise((r) => setTimeout(r, 70))
  }
  for (const t of movers) {
    await analyze(t, false)
    await new Promise((r) => setTimeout(r, 80))
  }

  return rankAndSelectAlerts(alerts)
}

/**
 * Pick clear corridors so лента always covers styles × trend:
 * - SCALP WITH_TREND (2) + SCALP COUNTER (1)
 * - INTRA WITH_TREND (2) + INTRA COUNTER (1)
 * - SWING best (1)
 * - MEME top (2)
 */
export function rankAndSelectAlerts(alerts: ScanAlert[]): ScanAlert[] {
  const byWin = (a: ScanAlert, b: ScanAlert) =>
    (b.globalAlignScore ?? 0) - (a.globalAlignScore ?? 0) ||
    b.winPct - a.winPct ||
    b.score - a.score

  const sniper = alerts.filter((a) => a.type === 'SNIPER')
  const meme = alerts.filter((a) => a.type === 'MEME')

  const pick = (
    pool: ScanAlert[],
    style: ScanAlert['style'],
    align: ScanAlert['align'] | null,
    n: number
  ) =>
    pool
      .filter(
        (a) => a.style === style && (align == null || a.align === align)
      )
      .sort(byWin)
      .slice(0, n)

  const slots: ScanAlert[] = [
    ...pick(sniper, 'SCALP', 'WITH_TREND', 2),
    ...pick(sniper, 'SCALP', 'COUNTER', 1),
    ...pick(sniper, 'INTRADAY', 'WITH_TREND', 2),
    ...pick(sniper, 'INTRADAY', 'COUNTER', 1),
    ...pick(sniper, 'SWING', 'WITH_TREND', 2),
    ...pick(sniper, 'SWING', 'COUNTER', 1),
    ...meme
      .sort((a, b) => b.score - a.score || b.winPct - a.winPct)
      .slice(0, 2),
  ]

  // Dedupe by dedupeKey while preserving slot order
  const seen = new Set<string>()
  const picked: ScanAlert[] = []
  for (const a of slots) {
    if (seen.has(a.dedupeKey)) continue
    seen.add(a.dedupeKey)
    picked.push(a)
  }

  // Always try to keep ≥1 blue-chip / BTC sniper in the лента
  const isBlue = (a: ScanAlert) => {
    const sym = a.tradePlan?.symbol ?? ''
    return (
      sym === 'BTC_USDT' ||
      sym === 'ETH_USDT' ||
      BLUE_CHIPS.has(sym)
    )
  }
  if (!picked.some((a) => a.type === 'SNIPER' && isBlue(a))) {
    const blue = [...sniper].filter(isBlue).sort(byWin)[0]
    if (blue && !seen.has(blue.dedupeKey)) {
      seen.add(blue.dedupeKey)
      picked.unshift(blue)
    }
  }

  // Fill empty corridors from leftover snipers by win%
  if (picked.length < 4) {
    for (const a of [...sniper].sort(byWin)) {
      if (seen.has(a.dedupeKey)) continue
      seen.add(a.dedupeKey)
      picked.push(a)
      if (picked.length >= 6) break
    }
  }

  if (picked.length === 0) {
    return [...alerts].sort(byWin).slice(0, 5)
  }

  return picked.map((a) => {
    const corridor =
      a.type === 'MEME'
        ? 'MEME'
        : `${a.style === 'INTRADAY' ? 'INTRA' : a.style} · ${
            a.align === 'WITH_TREND' ? 'по тренду' : 'против тренда'
          }`
    return {
      ...a,
      title: a.title.startsWith('🎯')
        ? a.title
        : `🎯 ${corridor} · ${a.winPct}% · ${a.title}`,
      text: [
        `Коридор: ${corridor} · вероятность ${a.winPct}%`,
        '',
        a.text,
      ].join('\n'),
    }
  })
}
