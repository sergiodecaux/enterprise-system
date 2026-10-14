/**
 * Short market pulse for both Telegram bots when there is no entry signal.
 * Cadence / mover counts locked before the run, not fitted.
 */

import { getMarketContext } from './marketContext'

const MEXC = 'https://contract.mexc.com'

/** Min gap between market pulses per lane. Locked before run. */
export const MARKET_PULSE_MS = 2 * 60 * 60_000

export type PulseLane = 'meme' | 'elite'

export interface MarketPulseBuilt {
  title: string
  text: string
  html: string
}

interface TickerLite {
  symbol: string
  lastPrice: number
  riseFallRate: number
  amount24?: number
  volume24?: number
}

type Candle = [number, number, number, number, number, number]

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EnterpriseSystem/2.0',
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
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
    }
  }>(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`)
  const d = json?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  for (let i = 0; i < d.time.length; i++) {
    out.push([
      d.time[i]! * 1000,
      Number(d.open[i]),
      Number(d.high[i]),
      Number(d.low[i]),
      Number(d.close[i]),
      0,
    ])
  }
  return out
}

function bias1h(candles: Candle[]): string {
  if (candles.length < 20) return 'н/д'
  const closes = candles.map((c) => c[4])
  const last = closes[closes.length - 1]!
  const sma =
    closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length)
  const prev = closes[closes.length - 7] ?? closes[0]!
  const chg = prev > 0 ? ((last - prev) / prev) * 100 : 0
  if (last > sma * 1.002 && chg > 0.2)
    return `BULL (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`
  if (last < sma * 0.998 && chg < -0.2) return `BEAR (${chg.toFixed(1)}%)`
  return `FLAT (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`
}

function quoteVol(t: TickerLite): number {
  const a = Number(t.amount24 ?? 0)
  if (a > 0) return a
  return Number(t.volume24 ?? 0) * Number(t.lastPrice ?? 0)
}

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function tickerLine(t: TickerLite, bias?: string): string {
  const chg = Number(t.riseFallRate) * 100
  const name = t.symbol.replace('_USDT', '')
  const biasBit = bias ? ` · 1h ${bias}` : ''
  return `• ${name} @ ${fmtPx(Number(t.lastPrice))} · 24h ${
    chg >= 0 ? '+' : ''
  }${chg.toFixed(1)}%${biasBit}`
}

/**
 * Compact market + majors + movers pulse for meme or elite lane.
 */
export async function buildMarketPulse(opts: {
  lane: PulseLane
  /** Favorite / hot symbols to highlight (already normalized *_USDT) */
  focusSymbols?: string[]
  hotlist?: string[]
  rejectHints?: string[]
  engineId?: string
  kv?: KVNamespace
}): Promise<MarketPulseBuilt> {
  const [mctx, tickersJson] = await Promise.all([
    getMarketContext(opts.kv),
    mexcJson<{ data?: TickerLite[] }>('/api/v1/contract/ticker'),
  ])
  const tickers = tickersJson?.data ?? []
  const usdt = tickers
    .filter((t) => t.symbol?.endsWith('_USDT') && Number(t.lastPrice) > 0)
    .sort((a, b) => quoteVol(b) - quoteVol(a))
  const bySym = new Map(usdt.map((t) => [t.symbol, t]))

  const btc = bySym.get('BTC_USDT')
  const eth = bySym.get('ETH_USDT')
  const sol = bySym.get('SOL_USDT')

  const [btc1h, eth1h, sol1h] = await Promise.all([
    fetchKlines('BTC_USDT', 'Min60', 30),
    fetchKlines('ETH_USDT', 'Min60', 30),
    fetchKlines('SOL_USDT', 'Min60', 30),
  ])

  const majors: string[] = []
  if (btc) majors.push(tickerLine(btc, bias1h(btc1h)))
  if (eth) majors.push(tickerLine(eth, bias1h(eth1h)))
  if (sol) majors.push(tickerLine(sol, bias1h(sol1h)))

  const movers = usdt
    .filter((t) => !['BTC_USDT', 'ETH_USDT', 'SOL_USDT'].includes(t.symbol))
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 4)
    .map((t) => tickerLine(t))

  const focus: string[] = []
  const focusSet = new Set(
    (opts.focusSymbols ?? [])
      .map((s) => s.toUpperCase().replace(/USDT$/, '_USDT').replace(/__/, '_'))
      .map((s) => (s.includes('_') ? s : `${s}_USDT`))
  )
  for (const sym of focusSet) {
    if (['BTC_USDT', 'ETH_USDT', 'SOL_USDT'].includes(sym)) continue
    const t = bySym.get(sym)
    if (t) focus.push(tickerLine(t))
  }

  const hot =
    opts.hotlist
      ?.slice(0, 6)
      .map((s) => s.replace('_USDT', ''))
      .filter(Boolean) ?? []

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const elite = opts.lane === 'elite'
  const title = elite
    ? '📡 Elite · пульс рынка'
    : '📡 Predator · пульс рынка'

  const bodyLines = [
    elite
      ? 'Альты · слежение живое · готового входа сейчас нет.'
      : 'Мемы · скан каждые 2 мин · A-сетапа сейчас нет.',
    '',
    '<b>Макро</b>',
    ...(mctx.lines ?? []).slice(0, 6).map((l) => `· ${l}`),
    '',
    '<b>Мажоры</b>',
    ...majors,
    movers.length ? '' : null,
    movers.length ? '<b>Движение 24h</b>' : null,
    ...movers,
    focus.length ? '' : null,
    focus.length ? (elite ? '<b>Избранное / фокус</b>' : '<b>Фокус</b>') : null,
    ...focus.slice(0, 6),
    hot.length ? '' : null,
    hot.length ? `<b>Hot</b>: ${hot.join(', ')}` : null,
    opts.rejectHints?.length
      ? `\n<b>Почему без входа</b>\n• ${opts.rejectHints.slice(0, 4).join('\n• ')}`
      : null,
    '',
    `⏱ ${now}`,
    opts.engineId ? `⚙ ${opts.engineId}` : null,
    'Когда появится вход ≥1% до цели — пришлю сразу. Это обзор, не сигнал.',
  ].filter((x): x is string => Boolean(x))

  const html = [`<b>${title}</b>`, ...bodyLines].join('\n')
  const text = html
    .replace(/<\/?b>/g, '')
    .replace(/· /g, '· ')

  return { title, text, html }
}

/** One-liner snapshot for heartbeats (cheap when marketContext is cached). */
export async function buildHeartbeatMarketHint(
  kv?: KVNamespace
): Promise<string> {
  try {
    const mctx = await getMarketContext(kv)
    const bits = (mctx.lines ?? []).slice(0, 2)
    return bits.length ? bits.join('\n') : ''
  } catch {
    return ''
  }
}
