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

const MEXC = 'https://contract.mexc.com'

/**
 * Liquidity floors — obscure / region-missing listings rarely sit in top volume.
 * RF MEXC search usually shows liquid USDT-M perps only.
 */
const MIN_MEME_QUOTE_VOL = 1_000_000
const MIN_MOVER_QUOTE_VOL = 5_000_000
const MIN_OPEN_INTEREST = 5_000
/** Only alert from top-N liquid USDT perps by 24h quote volume */
const TOP_LIQUID_PERPS = 120

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
  tradePlan?: TradePlanPayload
  /** Price already left zone — auto-create pullback watches for subscribers */
  needsPullbackWatch?: boolean
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
  const base = candles.slice(-25, -1)
  const avg = base.reduce((s, c) => s + c[5], 0) / base.length
  if (avg <= 0) return { detected: false, mult: 0, movePct: 0 }
  const last = candles[candles.length - 1]
  const mult = last[5] / avg
  const movePct = ((last[4] - last[1]) / last[1]) * 100
  return {
    detected: mult >= 3 && Math.abs(movePct) >= 1.2,
    mult,
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
  atr: number
): { sl: number; tp: number } {
  const risk = Math.max(atr * 1.4, entry * 0.008)
  const reward = Math.max(atr * 2.4, entry * 0.015)
  if (side === 'LONG') {
    return { sl: entry - risk, tp: entry + reward }
  }
  return { sl: entry + risk, tp: entry - reward }
}

/**
 * Не «вход по рынку сейчас», а зона лимита на откат.
 * К моменту Telegram цена на мемах уже другая — chase запрещён.
 */
function buildEntryPlan(
  side: Side,
  signalPrice: number,
  atr: number
): {
  signalPrice: number
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
} {
  const pull = Math.max(atr * 0.7, signalPrice * 0.008)
  const chase = Math.max(atr * 0.35, signalPrice * 0.005)
  // Zone is a true pullback area — current print is intentionally outside
  const cushion = Math.max(atr * 0.12, signalPrice * 0.0015)

  if (side === 'LONG') {
    const zoneHigh = signalPrice - cushion
    const zoneLow = signalPrice - pull
    const entryIdeal = (zoneLow + zoneHigh) / 2
    const invalidate = signalPrice + chase
    const { sl, tp } = buildLevels('LONG', entryIdeal, atr)
    return { signalPrice, entryIdeal, zoneLow, zoneHigh, invalidate, sl, tp }
  }

  const zoneLow = signalPrice + cushion
  const zoneHigh = signalPrice + pull
  const entryIdeal = (zoneLow + zoneHigh) / 2
  const invalidate = signalPrice - chase
  const { sl, tp } = buildLevels('SHORT', entryIdeal, atr)
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

/** Hard floor — bot only emits setups with win% ≥ 60 */
const MIN_WIN_PCT = 60

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
  softForMeme = false
): { score: number; note: string } | null {
  let s = score
  const notes: string[] = []

  if (bookImb != null) {
    const aligned =
      (side === 'LONG' && bookImb >= 18) || (side === 'SHORT' && bookImb <= -18)
    const against =
      (side === 'LONG' && bookImb <= (softForMeme ? -32 : -25)) ||
      (side === 'SHORT' && bookImb >= (softForMeme ? 32 : 25))
    if (against) {
      return null
    }
    if (aligned) {
      s += 6
      notes.push(`Стакан за вход (OBI ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%)`)
    } else {
      notes.push(`Стакан нейтрален (OBI ${bookImb >= 0 ? '+' : ''}${bookImb.toFixed(0)}%)`)
    }
  } else {
    notes.push('Стакан: нет данных')
  }

  if (!isBtc && rs != null) {
    const weakCut = softForMeme ? -10 : -6
    const strongCut = softForMeme ? 10 : 6
    if (side === 'LONG') {
      if (rs <= weakCut) return null
      if (rs >= 3) {
        s += Math.min(8, 3 + rs * 0.4)
        notes.push(coinStrengthLabel(rs, false))
      } else if (rs < -1.5) {
        s -= softForMeme ? 2 : 4
        notes.push(coinStrengthLabel(rs, false))
      } else {
        notes.push(coinStrengthLabel(rs, false))
      }
    } else {
      if (rs >= strongCut) return null
      if (rs <= -3) {
        s += Math.min(8, 3 + Math.abs(rs) * 0.4)
        notes.push(coinStrengthLabel(rs, false))
      } else if (rs > 1.5) {
        s -= softForMeme ? 2 : 4
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
 * Map raw score → display win% (calibrated band, not historical WR).
 * WITH_TREND gets a bump; COUNTER must earn a higher raw score to clear 60%.
 */
function winPctFromScore(
  score: number,
  align: TrendAlign = 'WITH_TREND',
  style: TradeStyle = 'INTRADAY'
): number {
  let base = 42 + score * 0.4
  if (align === 'WITH_TREND') base += 5
  else base -= 3
  if (style === 'SWING') base += 2
  if (style === 'SCALP') base -= 1
  return Math.round(Math.min(88, Math.max(0, base)))
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
  chased: boolean
  extras?: string[]
}): { title: string; text: string } {
  const name = opts.symbol.replace('_USDT', '/USDT')
  const icon = opts.side === 'LONG' ? '🟢' : '🔴'
  const tag = styleHashTag(opts.style, opts.type)
  const rr =
    Math.abs(opts.entryIdeal - opts.sl) > 0
      ? Math.abs(opts.tp - opts.entryIdeal) / Math.abs(opts.entryIdeal - opts.sl)
      : 0
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const chaseRule =
    opts.side === 'LONG'
      ? `Не входить / не догонять выше ${fmt(opts.invalidate)}`
      : `Не входить / не догонять ниже ${fmt(opts.invalidate)}`

  const title = `${tag} ${icon} ${opts.side} ${name} · ${styleLabel(opts.style)} · ${opts.setup}`

  const entryBlock = opts.chased
    ? [
        `⚠️ Цена УЖЕ ушла от зоны — НЕ ДОГОНЯТЬ.`,
        `Жди откат в зону: ${fmt(opts.zoneLow)} – ${fmt(opts.zoneHigh)}`,
        `Лимитка: ${fmt(opts.entryIdeal)} · ${chaseRule}`,
        `Бот ставит авто-watch на откат (оповещу при касании).`,
      ]
    : [
        `Тип входа: ЛИМИТ на откат — не маркет-chase`,
        `Зона входа: ${fmt(opts.zoneLow)} – ${fmt(opts.zoneHigh)}`,
        `Лимитка (ориентир): ${fmt(opts.entryIdeal)}`,
        chaseRule,
      ]

  const text = [
    tag,
    `Биржа: MEXC Futures · ${opts.symbol}`,
    `Стиль: ${styleLabel(opts.style)} · ${alignLabel(opts.align)} · ${opts.type}`,
    `Сигнал @ ${now}`,
    '',
    'Почему сейчас:',
    ...opts.whyNow.map((l) => `• ${l}`),
    '',
    `Цена сигнала: ${fmt(opts.signalPrice)}`,
    ...entryBlock,
    '',
    `Стоп: ${fmt(opts.sl)} (${pct(opts.entryIdeal, opts.sl)})`,
    `Цель: ${fmt(opts.tp)} (${pct(opts.entryIdeal, opts.tp)})`,
    `Победа: ${opts.winPct}% (мин. ${MIN_WIN_PCT}%) · R:R 1:${rr.toFixed(1)}`,
    '',
    `Причина: ${opts.reason}`,
    '',
    'Контекст:',
    ...opts.contextLines.map((l) => `· ${l}`),
    ...(opts.extras?.length ? ['', ...opts.extras] : []),
    '',
    opts.chased
      ? '⏳ Только лимит в зоне. Вне зоны — пропуск.'
      : '⚠️ Если цена выйдет из зоны до входа — не догонять, ждать откат.',
  ].join('\n')

  return { title, text }
}

function isMemeCandidate(t: TickerRow, tradable: Set<string>): boolean {
  if (!tradable.has(t.symbol)) return false
  if (!t.symbol.endsWith('_USDT')) return false
  if (BLUE_CHIPS.has(t.symbol)) return false
  const price = Number(t.lastPrice)
  const vol = quoteVol(t)
  // Memes / micro-caps: allow up to $50 (was $25 — cut many liquid names)
  return price > 0 && price <= 50 && vol >= MIN_MEME_QUOTE_VOL
}

/**
 * Full 24/7 scan cycle. Returns alerts to broadcast.
 * @param gates optional adaptive filters from bot journal outcomes
 */
export async function runMarketScan(
  gates?: BotAdaptiveGates | null
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

  const memes = liquidUniverse
    .filter((t) => isMemeCandidate(t, liquidSet))
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 14)

  const movers = liquidUniverse
    .filter((t) => quoteVol(t) >= MIN_MOVER_QUOTE_VOL)
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 8)

  // Always scan majors (BTC + liquid alts) for SNIPER — not only when they
  // appear in the top movers list (otherwise quiet BTC weeks = zero alerts).
  const majors = liquidUniverse
    .filter((t) => BLUE_CHIPS.has(t.symbol))
    .slice(0, 12)

  const alerts: ScanAlert[] = []
  const seen = new Set<string>()

  // BTC 1h once per cycle — relative strength + market regime
  const btc1h = await fetchKlines('BTC_USDT', 'Min60', 48)
  const btcRegime: MarketRegime = detectMarketRegime(btc1h)
  const winCal: WinPctCalibrationEntry[] = gates?.winPctBySetup ?? []

  const analyze = async (t: TickerRow, preferMeme: boolean) => {
    if (seen.has(t.symbol)) return
    seen.add(t.symbol)
    if (!liquidSet.has(t.symbol)) return

    const isMajor = BLUE_CHIPS.has(t.symbol)
    const isBtc = t.symbol === 'BTC_USDT'
    const candles = await fetchKlines(t.symbol, 'Min1', 120)
    // No candles = not really tradeable / bad symbol
    if (candles.length < 40) return

    if (toxicChop(candles)) return

    const price = Number(t.lastPrice)
    if (!(price > 0)) return

    const chg = Number(t.riseFallRate) * 100
    const funding = Number(t.fundingRate ?? 0)
    const fundingPct = funding * 100
    const atr = calcAtr(candles)
    if (!(atr > 0)) return

    // Global (4h) + mid (1h) + local (15m) — always for majors/movers; memes get 15m+1h
    let bias15: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT'
    let bias1h: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT'
    let bias4h: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT'
    let c1h: Candle[] = []
    {
      const tasks: Promise<Candle[]>[] = [
        fetchKlines(t.symbol, 'Min15', 64),
        fetchKlines(t.symbol, 'Min60', 48),
      ]
      if (!preferMeme || isMajor) {
        tasks.push(fetchKlines(t.symbol, 'Hour4', 42))
      }
      const frames = await Promise.all(tasks)
      bias15 = tfBias(frames[0])
      c1h = frames[1]
      bias1h = tfBias(c1h)
      if (frames[2]) bias4h = tfBias(frames[2])
    }
    const htfBias =
      bias4h !== 'FLAT' ? bias4h : bias1h !== 'FLAT' ? bias1h : bias15

    const bookImb = await fetchBookImbalance(t.symbol)
    const rs = isBtc ? null : relStrengthVsBtc(c1h, btc1h)
    const toxCache = new Map<Side, Awaited<ReturnType<typeof assessBookToxicity>>>()

    const spike = volumeSpike(candles)
    const ignition = flatlineIgnition(candles)
    const highBroken = brokeLocalHigh(candles)
    const closes = candles.map((c) => c[4])
    const rsi = calcRsi(closes)
    const backside = lowerHighAndBreak(candles) && rsi > 70
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
        type === 'MEME'
      )
      if (!regimeGate.ok) return
      scoreAdj = regimeGate.scoreAdj

      const gated = applyBookAndStrength(
        side,
        scoreAdj,
        bookImb,
        rs,
        isBtc,
        type === 'MEME'
      )
      if (!gated) return
      scoreAdj = gated.score

      // Spoof / iceberg — veto toxic books, soft-penalize warnings
      let tox = toxCache.get(side)
      if (!tox) {
        tox = await assessBookToxicity({
          symbol: t.symbol,
          side,
          mid: price,
          mexcJson,
        })
        toxCache.set(side, tox)
      }
      if (tox.toxic) return
      if (tox.scorePenalty > 0) {
        scoreAdj = Math.max(0, scoreAdj - tox.scorePenalty)
      }

      // Adaptive gates from bot journal — block weak tags only, not whole families
      if (gates) {
        if (isSetupBlocked(gates, setup, composite) && scoreAdj < 95) return
        const min =
          type === 'MEME' ? gates.minMemeScore : gates.minSniperScore
        const boost = isSetupBoosted(gates, setup, composite) ? -4 : 0
        if (scoreAdj < min + boost) return
      }

      const priorWin = winPctFromScore(scoreAdj, align, style)
      const cal = calibrateWinPct(priorWin, composite, winCal)
      // Soft floor: cold streak must not silence healthy high-score tags
      let winPct = cal.winPct
      if (
        winPct < MIN_WIN_PCT &&
        priorWin >= MIN_WIN_PCT &&
        scoreAdj >= (type === 'MEME' ? 76 : 84)
      ) {
        winPct = MIN_WIN_PCT
      }
      if (winPct < MIN_WIN_PCT) return

      // Final live check — detail + book + funding endpoint
      if (!(await isSymbolTradableNow(t.symbol, minVol))) return

      const plan = buildEntryPlan(side, price, atr)
      const chased = isPriceChased(side, price, plan.zoneLow, plan.zoneHigh)

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

      const whyNow: string[] = [
        reason.length > 140 ? `${reason.slice(0, 137)}…` : reason,
        `Bias 1h ${bias1h} / 4h ${bias4h} · режим BTC ${btcRegime}`,
        ctx.pullback
          ? `Локальный откат 15m (${bias15}) в глобальный ${ctx.global} — зона лимитки.`
          : `Сигнал ${align === 'WITH_TREND' ? 'по тренду' : 'контртренд'} · стиль ${styleLabel(style)}.`,
      ].slice(0, 3)

      const contextLines = [
        `1h bias: ${bias1h} · 4h bias: ${bias4h} · 15m: ${bias15}`,
        `OBI: ${obiStr} · RS: ${rsStr}`,
        `Режим рынка: ${btcRegime}`,
        gated.note,
        `Тренд: глобальный ${ctx.global} · локальный ${ctx.local}${
          ctx.pullback ? ' · откат в тренд' : ''
        }`,
        cal.source === 'PRIOR'
          ? `Win% модель ${priorWin}% (журнал: мало данных)`
          : `Win% ${winPct}% = модель ${priorWin}% ⊕ журнал ${cal.sampleN} (${cal.source})`,
        `24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · Vol ≈ $${(volUsd / 1e6).toFixed(2)}M · RSI ${rsi.toFixed(0)} · FR ${fundingPct.toFixed(3)}%`,
        ...tox.notes,
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
        needsPullbackWatch: chased,
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
        },
      })
    }

    // ── SHORT SQUEEZE → LONG (INTRADAY / COUNTER to short bias) ────
    const deeplyNeg = fundingPct <= -0.05 || fundingPct * 3 <= -0.15
    if (
      deeplyNeg &&
      highBroken &&
      (spike.detected || chg >= 8)
    ) {
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
      return
    }
    // Soft squeeze only if gates do not require high break
    if (
      deeplyNeg &&
      !highBroken &&
      (spike.detected || chg >= 10) &&
      !gates?.requireHighBrokenForSqueeze
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
      return
    }

    // ── IGNITION → LONG SCALP ──────────────────────────────────────
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
      return
    }

    // ── VOLUME PUMP / DUMP · SCALP ─────────────────────────────────
    const spikeMultMin = preferMeme ? 3.2 : isMajor ? 2.8 : 4
    const spikeMoveMin = preferMeme ? 1.5 : isMajor ? 1.2 : 2
    if (
      spike.detected &&
      spike.mult >= spikeMultMin &&
      Math.abs(spike.movePct) >= spikeMoveMin
    ) {
      const isLong = spike.movePct > 0
      const side: Side = isLong ? 'LONG' : 'SHORT'
      const align = classifyAlign(side, bias15 !== 'FLAT' ? bias15 : htfBias)
      // Counter scalp needs stronger spike
      const baseScore = Math.min(
        95,
        (preferMeme ? 62 : 58) + spike.mult * 5
      )
      const score = align === 'COUNTER' ? baseScore + 6 : baseScore
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
      return
    }

    // ── MAJOR / ALT · INTRADAY WITH TREND ───────────────────────────
    if (!preferMeme && (isMajor || volUsd >= MIN_MOVER_QUOTE_VOL)) {
      const sessionMove = Math.abs(chg)
      const trendSide: Side | null =
        bias1h === 'BULL' || (bias1h === 'FLAT' && bias15 === 'BULL')
          ? 'LONG'
          : bias1h === 'BEAR' || (bias1h === 'FLAT' && bias15 === 'BEAR')
            ? 'SHORT'
            : null

      if (
        trendSide &&
        sessionMove >= 1.8 &&
        ((trendSide === 'LONG' && rsi >= 52 && rsi <= 72 && chg > 0) ||
          (trendSide === 'SHORT' && rsi <= 48 && rsi >= 28 && chg < 0))
      ) {
        await push(
          trendSide,
          trendSide === 'LONG' ? 'TREND_LONG' : 'TREND_SHORT',
          Math.min(90, 68 + sessionMove * 1.2),
          `Интрадей по тренду ${t.symbol}: 1h ${bias1h}, 15m ${bias15}, 24h ${
            chg >= 0 ? '+' : ''
          }${chg.toFixed(1)}%, RSI ${rsi.toFixed(0)}.`,
          ['BTC/alt liquid · SNIPER · WITH_TREND'],
          'SNIPER',
          `cron:intra_trend:${t.symbol}:${trendSide}`,
          'INTRADAY',
          'WITH_TREND'
        )
        return
      }

      // ── INTRADAY COUNTER (exhaustion) ─────────────────────────────
      if (
        htfBias !== 'FLAT' &&
        sessionMove >= 4 &&
        ((htfBias === 'BULL' && rsi >= 74 && chg > 0) ||
          (htfBias === 'BEAR' && rsi <= 26 && chg < 0))
      ) {
        const side: Side = htfBias === 'BULL' ? 'SHORT' : 'LONG'
        await push(
          side,
          'EXHAUST',
          Math.min(92, 72 + sessionMove),
          `Интрадей против тренда: HTF ${htfBias}, RSI ${rsi.toFixed(
            0
          )}, 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% — перегрев / истощение.`,
          ['COUNTER · только при win% ≥ 60'],
          'SNIPER',
          `cron:intra_counter:${t.symbol}:${side}`,
          'INTRADAY',
          'COUNTER'
        )
        return
      }

      // ── SWING WITH TREND (4h) ─────────────────────────────────────
      if (
        bias4h !== 'FLAT' &&
        sessionMove >= 2.2 &&
        ((bias4h === 'BULL' && chg > 0 && rsi >= 50 && rsi <= 68) ||
          (bias4h === 'BEAR' && chg < 0 && rsi <= 50 && rsi >= 32))
      ) {
        const side: Side = bias4h === 'BULL' ? 'LONG' : 'SHORT'
        await push(
          side,
          side === 'LONG' ? 'SWING_LONG' : 'SWING_SHORT',
          Math.min(91, 70 + sessionMove),
          `Свинг по тренду 4h ${bias4h}: 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(
            1
          )}%, RSI ${rsi.toFixed(0)}.`,
          ['SWING · WITH_TREND · majors/liquid alts'],
          'SNIPER',
          `cron:swing_trend:${t.symbol}:${side}`,
          'SWING',
          'WITH_TREND'
        )
        return
      }

      // ── SWING COUNTER (mean reversion at extremes) ───────────────
      if (
        bias4h !== 'FLAT' &&
        sessionMove >= 6 &&
        ((bias4h === 'BULL' && rsi >= 78) || (bias4h === 'BEAR' && rsi <= 22))
      ) {
        const side: Side = bias4h === 'BULL' ? 'SHORT' : 'LONG'
        await push(
          side,
          'SWING_FADE',
          Math.min(93, 76 + sessionMove * 0.6),
          `Свинг против тренда: 4h ${bias4h}, экстремальный RSI ${rsi.toFixed(
            0
          )}, ход ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% — fade только при высокой уверенности.`,
          ['SWING · COUNTER'],
          'SNIPER',
          `cron:swing_counter:${t.symbol}:${side}`,
          'SWING',
          'COUNTER'
        )
        return
      }
    }

    // ── LEGACY MAJOR PULSE (fallback) ──────────────────────────────
    if (!preferMeme && isMajor) {
      const impulse = Math.abs(spike.movePct)
      const sessionMove = Math.abs(chg)
      if (
        (spike.detected && impulse >= 0.8 && sessionMove >= 2) ||
        (sessionMove >= 4 && rsi > 62 && chg > 0) ||
        (sessionMove >= 4 && rsi < 38 && chg < 0)
      ) {
        const isLong = chg >= 0
        const side: Side = isLong ? 'LONG' : 'SHORT'
        await push(
          side,
          isLong ? 'TREND_LONG' : 'TREND_SHORT',
          Math.min(88, 66 + sessionMove),
          `Major pulse ${t.symbol}: 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%, RSI ${rsi.toFixed(0)}${
            spike.detected ? `, объём ×${spike.mult.toFixed(1)}` : ''
          }.`,
          ['Blue-chip / liquid alt · SNIPER'],
          'SNIPER',
          `cron:major:${t.symbol}:${isLong ? 'L' : 'S'}`,
          'INTRADAY'
        )
        return
      }
    }

    // ── BACKSIDE SHORT · SCALP/INTRA COUNTER ───────────────────────
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
    }
  }

  for (const t of memes) {
    await analyze(t, true)
    await new Promise((r) => setTimeout(r, 80))
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
 * Pick best actionable set:
 * - Top 3 SCALP by win% on BTC+alts (SNIPER)
 * - Best INTRADAY (up to 2)
 * - Best SWING (1)
 * - Top MEME (up to 2)
 */
export function rankAndSelectAlerts(alerts: ScanAlert[]): ScanAlert[] {
  const byWin = (a: ScanAlert, b: ScanAlert) =>
    b.winPct - a.winPct || b.score - a.score

  const sniper = alerts.filter((a) => a.type === 'SNIPER')
  const meme = alerts.filter((a) => a.type === 'MEME')

  const scalp = sniper
    .filter((a) => a.style === 'SCALP')
    .sort(byWin)
    .slice(0, 3)
  const intra = sniper
    .filter((a) => a.style === 'INTRADAY')
    .sort(byWin)
    .slice(0, 2)
  const swing = sniper
    .filter((a) => a.style === 'SWING')
    .sort(byWin)
    .slice(0, 1)
  const memeTop = meme.sort(byWin).slice(0, 2)

  // If scalp empty but we have OTHER/SNIPER without style tag, fill from score
  const picked = [...scalp, ...intra, ...swing, ...memeTop]
  if (picked.length === 0) {
    return [...alerts].sort(byWin).slice(0, 5)
  }

  // Prefixed ranking note on scalp titles for clarity
  return picked.map((a, i) => {
    if (a.style !== 'SCALP' || a.type !== 'SNIPER') return a
    const rank = scalp.indexOf(a) + 1
    if (rank <= 0) return a
    return {
      ...a,
      title: `🏆 СКАЛЬП #${rank}/${scalp.length} · ${a.title.replace(/^🏆 СКАЛЬП #\d+\/\d+ · /, '')}`,
      text: [
        `Рейтинг скальп (BTC+альты): #${rank} из топ-${scalp.length} по win% (${a.winPct}%).`,
        '',
        a.text,
      ].join('\n'),
    }
  })
}
