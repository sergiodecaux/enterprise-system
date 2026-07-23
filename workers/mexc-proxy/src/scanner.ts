/**
 * 24/7 lightweight scanner for MEXC futures → Telegram alerts.
 * Only emits symbols that are active/tradeable on MEXC contract API.
 * Runs on Cloudflare Cron (every 2 minutes).
 */

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
  tradePlan?: TradePlanPayload
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

  if (side === 'LONG') {
    const zoneLow = signalPrice - pull
    const zoneHigh = signalPrice + chase * 0.2
    const entryIdeal = (zoneLow + Math.min(signalPrice, zoneHigh)) / 2
    const invalidate = signalPrice + chase
    const { sl, tp } = buildLevels('LONG', entryIdeal, atr)
    return { signalPrice, entryIdeal, zoneLow, zoneHigh, invalidate, sl, tp }
  }

  const zoneHigh = signalPrice + pull
  const zoneLow = signalPrice - chase * 0.2
  const entryIdeal = (zoneHigh + Math.max(signalPrice, zoneLow)) / 2
  const invalidate = signalPrice - chase
  const { sl, tp } = buildLevels('SHORT', entryIdeal, atr)
  return { signalPrice, entryIdeal, zoneLow, zoneHigh, invalidate, sl, tp }
}

/** Map raw score → display win% (calibrated band, not historical WR) */
function winPctFromScore(score: number): number {
  return Math.round(Math.min(82, Math.max(55, 48 + score * 0.35)))
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
  extras?: string[]
}): { title: string; text: string } {
  const name = opts.symbol.replace('_USDT', '/USDT')
  const icon = opts.side === 'LONG' ? '🟢' : '🔴'
  const rr =
    Math.abs(opts.entryIdeal - opts.sl) > 0
      ? Math.abs(opts.tp - opts.entryIdeal) / Math.abs(opts.entryIdeal - opts.sl)
      : 0
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const chaseRule =
    opts.side === 'LONG'
      ? `Не входить / не догонять выше ${fmt(opts.invalidate)}`
      : `Не входить / не догонять ниже ${fmt(opts.invalidate)}`

  const title = `${icon} ${opts.side} ${name} · ${opts.setup}`
  const text = [
    `Биржа: MEXC Futures`,
    `Контракт: ${opts.symbol}`,
    `Сигнал @ ${now}`,
    '',
    `Цена сигнала: ${fmt(opts.signalPrice)} (уже могла уйти)`,
    `Тип входа: ЛИМИТ на откат — не маркет-chase`,
    `Зона входа: ${fmt(opts.zoneLow)} – ${fmt(opts.zoneHigh)}`,
    `Лимитка (ориентир): ${fmt(opts.entryIdeal)}`,
    chaseRule,
    '',
    `Стоп: ${fmt(opts.sl)} (${pct(opts.entryIdeal, opts.sl)})`,
    `Цель: ${fmt(opts.tp)} (${pct(opts.entryIdeal, opts.tp)})`,
    `Победа: ${opts.winPct}%`,
    `R:R 1:${rr.toFixed(1)}`,
    '',
    `Причина: ${opts.reason}`,
    ...(opts.extras?.length ? ['', ...opts.extras] : []),
    '',
    '⚠️ Мем/импульс: если цена уже вне зоны — пропуск, жди откат или следующий сигнал.',
    'Ищи в MEXC → Фьючерсы → USDT-M → точное имя контракта выше.',
  ].join('\n')

  return { title, text }
}

function isMemeCandidate(t: TickerRow, tradable: Set<string>): boolean {
  if (!tradable.has(t.symbol)) return false
  if (!t.symbol.endsWith('_USDT')) return false
  if (BLUE_CHIPS.has(t.symbol)) return false
  const price = Number(t.lastPrice)
  const vol = quoteVol(t)
  return price > 0 && price <= 25 && vol >= MIN_MEME_QUOTE_VOL
}

/**
 * Full 24/7 scan cycle. Returns alerts to broadcast.
 * @param gates optional adaptive filters from bot journal outcomes
 */
export async function runMarketScan(gates?: {
  minMemeScore: number
  minSniperScore: number
  blockedSetups: string[]
  boostedSetups: string[]
  requireHighBrokenForSqueeze: boolean
} | null): Promise<ScanAlert[]> {
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
    .slice(0, 8)

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

  const analyze = async (t: TickerRow, preferMeme: boolean) => {
    if (seen.has(t.symbol)) return
    seen.add(t.symbol)
    if (!liquidSet.has(t.symbol)) return

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
      dedupeKey: string
    ) => {
      // Adaptive gates from bot journal outcomes
      if (gates) {
        if (gates.blockedSetups.includes(setup) && score < 95) return
        const min =
          type === 'MEME' ? gates.minMemeScore : gates.minSniperScore
        const boost = gates.boostedSetups.includes(setup) ? -4 : 0
        if (score < min + boost) return
      }

      // Final live check — detail + book + funding endpoint
      if (!(await isSymbolTradableNow(t.symbol, minVol))) return

      const plan = buildEntryPlan(side, price, atr)
      const winPct = winPctFromScore(score)
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
        extras: [
          ...extras,
          `24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · Vol ≈ $${(volUsd / 1e6).toFixed(2)}M`,
          `RSI ${rsi.toFixed(0)} · FR ${fundingPct.toFixed(3)}%`,
          `MEXC USDT-M Perpetual ✓ (top ${TOP_LIQUID_PERPS} by volume)`,
        ],
      })
      alerts.push({
        type,
        title: msg.title,
        text: msg.text,
        dedupeKey,
        score,
        tradePlan: {
          side,
          symbol: t.symbol,
          setup,
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

    // ── SHORT SQUEEZE → LONG ───────────────────────────────────────
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
        `cron:squeeze:${t.symbol}`
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
        82,
        `Short squeeze (мягкий): funding ${fundingPct.toFixed(3)}% без пробоя хая.`,
        [],
        'MEME',
        `cron:squeeze_soft:${t.symbol}`
      )
      return
    }

    // ── IGNITION → LONG ────────────────────────────────────────────
    if (ignition.detected) {
      await push(
        'LONG',
        'IGNITION',
        85,
        `Flatline ignition: объём ×${ignition.mult.toFixed(0)} от часовой базы, импульс ${ignition.movePct.toFixed(1)}% после сжатия.`,
        [],
        'MEME',
        `cron:ignition:${t.symbol}`
      )
      return
    }

    // ── VOLUME PUMP / DUMP ─────────────────────────────────────────
    const isMajor = BLUE_CHIPS.has(t.symbol)
    const spikeMultMin = isMajor && !preferMeme ? 2.8 : 4
    const spikeMoveMin = isMajor && !preferMeme ? 1.2 : 2
    if (
      spike.detected &&
      spike.mult >= spikeMultMin &&
      Math.abs(spike.movePct) >= spikeMoveMin
    ) {
      const isLong = spike.movePct > 0
      await push(
        isLong ? 'LONG' : 'SHORT',
        isLong ? 'PUMP' : 'DUMP',
        Math.min(95, 55 + spike.mult * 5),
        `Всплеск объёма ×${spike.mult.toFixed(1)} за 1м, движение ${
          spike.movePct >= 0 ? '+' : ''
        }${spike.movePct.toFixed(2)}%.`,
        [],
        preferMeme ? 'MEME' : 'SNIPER',
        `cron:spike:${t.symbol}:${isLong ? 'PUMP' : 'DUMP'}`
      )
      return
    }

    // ── MAJOR TREND PULSE (BTC / liquid alts) ───────────────────────
    // Quieter markets: still emit SNIPER when 1m impulse + session move align
    if (!preferMeme && isMajor) {
      const impulse = Math.abs(spike.movePct)
      const sessionMove = Math.abs(chg)
      if (
        (spike.detected && impulse >= 0.8 && sessionMove >= 2) ||
        (sessionMove >= 4 && rsi > 62 && chg > 0) ||
        (sessionMove >= 4 && rsi < 38 && chg < 0)
      ) {
        const isLong = chg >= 0
        await push(
          isLong ? 'LONG' : 'SHORT',
          isLong ? 'TREND_LONG' : 'TREND_SHORT',
          Math.min(88, 62 + sessionMove),
          `Major pulse ${t.symbol}: 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%, RSI ${rsi.toFixed(0)}${
            spike.detected ? `, объём ×${spike.mult.toFixed(1)}` : ''
          }.`,
          ['Blue-chip / liquid alt · SNIPER'],
          'SNIPER',
          `cron:major:${t.symbol}:${isLong ? 'L' : 'S'}`
        )
        return
      }
    }

    // ── BACKSIDE SHORT ─────────────────────────────────────────────
    if (backside && chg >= 25) {
      await push(
        'SHORT',
        'BACKSIDE',
        80,
        `Backside short: +${chg.toFixed(0)}% за 24ч, RSI ${rsi.toFixed(
          0
        )}, lower high + слом структуры. Топливо сквиза выгорает.`,
        [
          fundingPct > -0.01
            ? 'Funding нормализовался'
            : `FR ещё ${fundingPct.toFixed(3)}% — осторожно`,
        ],
        preferMeme ? 'MEME' : 'SNIPER',
        `cron:backside:${t.symbol}`
      )
    }
  }

  for (const t of memes) {
    await analyze(t, true)
    await new Promise((r) => setTimeout(r, 120))
  }
  for (const t of majors) {
    await analyze(t, false)
    await new Promise((r) => setTimeout(r, 100))
  }
  for (const t of movers) {
    await analyze(t, false)
    await new Promise((r) => setTimeout(r, 120))
  }

  return alerts.sort((a, b) => b.score - a.score).slice(0, 5)
}
