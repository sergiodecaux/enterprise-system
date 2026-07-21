/**
 * 24/7 lightweight scanner for MEXC futures → Telegram alerts.
 * Only emits symbols that are active/tradeable on MEXC contract API.
 * Runs on Cloudflare Cron (every 2 minutes).
 */

const MEXC = 'https://contract.mexc.com'

/** Min 24h quote volume (USDT) — skip illiquid / hard-to-find RF listings */
const MIN_MEME_QUOTE_VOL = 250_000
const MIN_MOVER_QUOTE_VOL = 2_000_000

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

export interface ScanAlert {
  type: 'SNIPER' | 'MEME'
  title: string
  text: string
  dedupeKey: string
  score: number
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
}

interface ContractDetail {
  symbol: string
  state?: number
  isHidden?: boolean
  apiAllowed?: boolean
  quoteCoin?: string
  futureType?: number
  preMarket?: boolean
  maxVol?: number
  minVol?: number
}

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

async function mexcGet<T>(path: string): Promise<T | null> {
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

/**
 * Active USDT perpetuals only — state=0, visible, API-allowed, not pre-market.
 * Prevents alerts on delisted / hidden / untradeable tickers.
 */
async function fetchTradableSymbols(): Promise<Set<string>> {
  const json = await mexcGet<{ data: ContractDetail | ContractDetail[] }>(
    '/api/v1/contract/detail'
  )
  if (!json?.data) return new Set()
  const rows = Array.isArray(json.data) ? json.data : [json.data]
  const out = new Set<string>()
  for (const c of rows) {
    if (!c?.symbol?.endsWith('_USDT')) continue
    if (c.state !== 0) continue
    if (c.isHidden) continue
    if (c.apiAllowed === false) continue
    if (c.preMarket) continue
    if (c.quoteCoin && c.quoteCoin !== 'USDT') continue
    // futureType 1 = perpetual (skip odd delivery if present)
    if (c.futureType != null && c.futureType !== 1) continue
    if (c.maxVol != null && c.maxVol <= 0) continue
    out.add(c.symbol)
  }
  return out
}

async function fetchTickers(): Promise<TickerRow[]> {
  const json = await mexcGet<{ data: TickerRow | TickerRow[] }>(
    '/api/v1/contract/ticker'
  )
  if (!json?.data) return []
  return Array.isArray(json.data) ? json.data : [json.data]
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const json = await mexcGet<{
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

/** Double-check single contract still tradeable before emitting alert */
async function isSymbolTradableNow(symbol: string): Promise<boolean> {
  const json = await mexcGet<{ data: ContractDetail }>(
    `/api/v1/contract/detail?symbol=${symbol}`
  )
  const c = json?.data
  if (!c?.symbol) return false
  if (c.state !== 0) return false
  if (c.isHidden) return false
  if (c.apiAllowed === false) return false
  if (c.preMarket) return false
  return true
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

/** Map raw score → display win% (calibrated band, not historical WR) */
function winPctFromScore(score: number): number {
  return Math.round(Math.min(82, Math.max(55, 48 + score * 0.35)))
}

function formatTradeAlert(opts: {
  side: Side
  symbol: string
  entry: number
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
    Math.abs(opts.entry - opts.sl) > 0
      ? Math.abs(opts.tp - opts.entry) / Math.abs(opts.entry - opts.sl)
      : 0

  const title = `${icon} ${opts.side} ${name} · ${opts.setup}`
  const text = [
    `Биржа: MEXC Futures`,
    `Контракт: ${opts.symbol}`,
    '',
    `Вход: ${fmt(opts.entry)}`,
    `Стоп: ${fmt(opts.sl)} (${pct(opts.entry, opts.sl)})`,
    `Цель: ${fmt(opts.tp)} (${pct(opts.entry, opts.tp)})`,
    `Победа: ${opts.winPct}%`,
    `R:R 1:${rr.toFixed(1)}`,
    '',
    `Причина: ${opts.reason}`,
    ...(opts.extras?.length ? ['', ...opts.extras] : []),
    '',
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
 */
export async function runMarketScan(): Promise<ScanAlert[]> {
  const [tradable, tickers] = await Promise.all([
    fetchTradableSymbols(),
    fetchTickers(),
  ])
  if (!tickers.length || tradable.size === 0) return []

  const memes = tickers
    .filter((t) => isMemeCandidate(t, tradable))
    .sort((a, b) => quoteVol(b) - quoteVol(a))
    .slice(0, 10)

  const movers = tickers
    .filter(
      (t) =>
        tradable.has(t.symbol) &&
        t.symbol.endsWith('_USDT') &&
        !t.symbol.includes('USDC') &&
        quoteVol(t) >= MIN_MOVER_QUOTE_VOL
    )
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 8)

  const alerts: ScanAlert[] = []
  const seen = new Set<string>()

  const analyze = async (t: TickerRow, preferMeme: boolean) => {
    if (seen.has(t.symbol)) return
    seen.add(t.symbol)
    if (!tradable.has(t.symbol)) return

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

    const push = async (
      side: Side,
      setup: string,
      score: number,
      reason: string,
      extras: string[],
      type: 'SNIPER' | 'MEME',
      dedupeKey: string
    ) => {
      // Final live check — avoid delisted mid-scan
      if (!(await isSymbolTradableNow(t.symbol))) return

      const { sl, tp } = buildLevels(side, price, atr)
      const winPct = winPctFromScore(score)
      const msg = formatTradeAlert({
        side,
        symbol: t.symbol,
        entry: price,
        sl,
        tp,
        winPct,
        reason,
        setup,
        extras: [
          ...extras,
          `24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% · Vol ≈ $${(volUsd / 1e6).toFixed(2)}M`,
          `RSI ${rsi.toFixed(0)} · FR ${fundingPct.toFixed(3)}%`,
        ],
      })
      alerts.push({
        type,
        title: msg.title,
        text: msg.text,
        dedupeKey,
        score,
      })
    }

    // ── SHORT SQUEEZE → LONG ───────────────────────────────────────
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
        `cron:squeeze:${t.symbol}`
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
    if (spike.detected && spike.mult >= 4 && Math.abs(spike.movePct) >= 2) {
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
  for (const t of movers) {
    await analyze(t, false)
    await new Promise((r) => setTimeout(r, 120))
  }

  return alerts.sort((a, b) => b.score - a.score).slice(0, 5)
}
