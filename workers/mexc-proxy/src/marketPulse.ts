/**
 * Idle / favorites pulse when the scanner has nothing actionable.
 */

const MEXC = 'https://contract.mexc.com'
const IDLE_KEY = 'telegram:idle_pulse'
const IDLE_MS = 10 * 60_000

export interface PulseAlert {
  chatId?: number
  title: string
  text: string
  dedupeKey: string
}

interface Env {
  SUBSCRIBERS?: KVNamespace
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

type Candle = [number, number, number, number, number, number]

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
      d.time[i] * 1000,
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
  const last = closes[closes.length - 1]
  const sma =
    closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length)
  const chg =
    closes.length > 6
      ? ((last - closes[closes.length - 7]) / closes[closes.length - 7]) * 100
      : 0
  if (last > sma * 1.002 && chg > 0.2) return `BULL (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`
  if (last < sma * 0.998 && chg < -0.2) return `BEAR (${chg.toFixed(1)}%)`
  return `FLAT (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`
}

interface TickerLite {
  symbol: string
  lastPrice: number
  riseFallRate: number
  amount24?: number
  volume24?: number
}

function quoteVol(t: TickerLite): number {
  const a = Number(t.amount24 ?? 0)
  if (a > 0) return a
  return Number(t.volume24 ?? 0) * Number(t.lastPrice ?? 0)
}

/**
 * Build a "no signals" report with favorites under close watch.
 */
export async function buildIdlePulseText(opts: {
  activeWatches: number
  watchLines?: string[]
}): Promise<{ title: string; text: string }> {
  const tickers =
    (
      await mexcJson<{ data?: TickerLite[] }>('/api/v1/contract/ticker')
    )?.data ?? []

  const usdt = tickers
    .filter((t) => t.symbol?.endsWith('_USDT') && Number(t.lastPrice) > 0)
    .sort((a, b) => quoteVol(b) - quoteVol(a))

  const btc = usdt.find((t) => t.symbol === 'BTC_USDT')
  const eth = usdt.find((t) => t.symbol === 'ETH_USDT')
  const sol = usdt.find((t) => t.symbol === 'SOL_USDT')

  const movers = usdt
    .filter((t) => !['BTC_USDT', 'ETH_USDT', 'SOL_USDT'].includes(t.symbol))
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 4)

  const [btc1h, eth1h, sol1h] = await Promise.all([
    fetchKlines('BTC_USDT', 'Min60', 30),
    fetchKlines('ETH_USDT', 'Min60', 30),
    fetchKlines('SOL_USDT', 'Min60', 30),
  ])

  const favLines: string[] = []
  const pushFav = (
    label: string,
    t: TickerLite | undefined,
    bias: string
  ) => {
    if (!t) return
    const chg = Number(t.riseFallRate) * 100
    favLines.push(
      `• ${label} @ ${Number(t.lastPrice).toPrecision(6)} · 24h ${
        chg >= 0 ? '+' : ''
      }${chg.toFixed(1)}% · 1h ${bias}`
    )
  }
  pushFav('BTC', btc, bias1h(btc1h))
  pushFav('ETH', eth, bias1h(eth1h))
  pushFav('SOL', sol, bias1h(sol1h))
  for (const m of movers) {
    const chg = Number(m.riseFallRate) * 100
    favLines.push(
      `• ${m.symbol.replace('_USDT', '')} @ ${Number(m.lastPrice).toPrecision(
        6
      )} · 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% (mover)`
    )
  }

  const watchBlock =
    opts.watchLines && opts.watchLines.length > 0
      ? [
          '',
          `👁 Ваши сетапы под слежением: ${opts.activeWatches}`,
          ...opts.watchLines,
        ]
      : opts.activeWatches > 0
        ? ['', `👁 Активных watch на сервере: ${opts.activeWatches}`]
        : ['', '👁 Личных watch-сетапов нет — нажми «Зоны» в Mini App.']

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  return {
    title: '📡 Пульс рынка · сигналов нет',
    text: [
      `Время: ${now}`,
      '',
      '✅ Сейчас нет готовых сигналов к входу (скальп / интра / свинг).',
      'Бот продолжает скан каждые 2 мин.',
      '',
      '⭐ Фавориты под пристальным наблюдением:',
      ...favLines,
      ...watchBlock,
      '',
      'Когда появится сетап ≥60% win на HTF-зоне 4H/D — пришлю сразу.',
      'Коридоры: SCALP/INTRA × TREND/COUNTER · только с сильной SSL/BSL.',
      '⚙ htf-zones-v2 · 15m = тайминг, не источник зоны.',
    ].join('\n'),
  }
}

export async function shouldSendIdlePulse(env: Env): Promise<boolean> {
  const now = Date.now()
  if (env.SUBSCRIBERS) {
    const last = Number((await env.SUBSCRIBERS.get(IDLE_KEY)) || 0)
    if (now - last < IDLE_MS) return false
    return true
  }
  return true
}

export async function markIdlePulseSent(env: Env): Promise<void> {
  if (env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(IDLE_KEY, String(Date.now()))
  }
}
