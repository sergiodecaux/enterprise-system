/**
 * 24/7 lightweight scanner for MEXC futures → Telegram alerts.
 * Runs on Cloudflare Cron (every 2 minutes).
 */

const MEXC = 'https://contract.mexc.com'

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

type Candle = [number, number, number, number, number, number]

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
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(8)
}

function isMemeCandidate(t: TickerRow): boolean {
  if (!t.symbol?.endsWith('_USDT')) return false
  if (BLUE_CHIPS.has(t.symbol)) return false
  const price = Number(t.lastPrice)
  const vol = Number(t.amount24 ?? t.volume24 ?? 0)
  return price > 0 && price <= 15 && vol >= 5000
}

/**
 * Full 24/7 scan cycle. Returns alerts to broadcast.
 */
export async function runMarketScan(): Promise<ScanAlert[]> {
  const tickers = await fetchTickers()
  if (!tickers.length) return []

  const memes = tickers
    .filter(isMemeCandidate)
    .sort(
      (a, b) =>
        Math.abs(Number(b.riseFallRate)) - Math.abs(Number(a.riseFallRate))
    )
    .slice(0, 12)

  // Also top movers among larger caps for sniper-style
  const movers = tickers
    .filter(
      (t) =>
        t.symbol?.endsWith('_USDT') &&
        !t.symbol.includes('USDC') &&
        Number(t.amount24 ?? t.volume24 ?? 0) >= 500_000
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

    const candles = await fetchKlines(t.symbol, 'Min1', 120)
    if (candles.length < 40) return

    if (toxicChop(candles)) return

    const price = Number(t.lastPrice)
    const chg = Number(t.riseFallRate) * 100
    const funding = Number(t.fundingRate ?? 0)
    const fundingPct = funding * 100
    const name = t.symbol.replace('_USDT', '/USDT')

    const spike = volumeSpike(candles)
    const ignition = flatlineIgnition(candles)
    const highBroken = brokeLocalHigh(candles)
    const closes = candles.map((c) => c[4])
    const rsi = calcRsi(closes)
    const backside = lowerHighAndBreak(candles) && rsi > 70

    // ── SHORT SQUEEZE ──────────────────────────────────────────────
    const deeplyNeg = fundingPct <= -0.05 || fundingPct * 3 <= -0.15
    if (deeplyNeg && highBroken && (spike.detected || chg >= 8)) {
      alerts.push({
        type: 'MEME',
        title: `🚀 SHORT SQUEEZE ${name}`,
        text: [
          `Funding: ${fundingPct.toFixed(3)}%`,
          `24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`,
          `Price: ${fmt(price)}`,
          spike.detected
            ? `Vol spike ×${spike.mult.toFixed(1)}`
            : 'Local high broken',
          '',
          'Толпа в шортах — ММ тащит вверх. 24/7 Scanner',
        ].join('\n'),
        dedupeKey: `cron:squeeze:${t.symbol}`,
        score: 90,
      })
      return
    }

    // ── IGNITION ───────────────────────────────────────────────────
    if (ignition.detected) {
      alerts.push({
        type: 'MEME',
        title: `🔥 IGNITION ${name}`,
        text: [
          `Vol ×${ignition.mult.toFixed(0)} hourly avg`,
          `Move: ${ignition.movePct.toFixed(1)}%`,
          `Price: ${fmt(price)} · 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`,
          '',
          'Flatline breakout — вход с микро-стопом. 24/7 Scanner',
        ].join('\n'),
        dedupeKey: `cron:ignition:${t.symbol}`,
        score: 85,
      })
      return
    }

    // ── VOLUME PUMP / DUMP ─────────────────────────────────────────
    if (spike.detected && spike.mult >= 4 && Math.abs(spike.movePct) >= 2) {
      const dir = spike.movePct > 0 ? 'PUMP' : 'DUMP'
      alerts.push({
        type: preferMeme ? 'MEME' : 'SNIPER',
        title: `${dir === 'PUMP' ? '⚡️' : '📉'} ${dir} ${name}`,
        text: [
          `Vol ×${spike.mult.toFixed(1)} · Δ ${spike.movePct >= 0 ? '+' : ''}${spike.movePct.toFixed(2)}% (1m)`,
          `Price: ${fmt(price)} · 24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`,
          `RSI: ${rsi.toFixed(0)} · FR ${fundingPct.toFixed(3)}%`,
          '',
          '24/7 Scanner · ENTERPRISE SYSTEM',
        ].join('\n'),
        dedupeKey: `cron:spike:${t.symbol}:${dir}`,
        score: Math.min(95, 55 + spike.mult * 5),
      })
      return
    }

    // ── BACKSIDE SHORT ─────────────────────────────────────────────
    if (backside && chg >= 25) {
      alerts.push({
        type: preferMeme ? 'MEME' : 'SNIPER',
        title: `🎯 BACKSIDE SHORT ${name}`,
        text: [
          `24h +${chg.toFixed(0)}% · RSI ${rsi.toFixed(0)}`,
          `Lower High + structure break`,
          `Price: ${fmt(price)}`,
          fundingPct > -0.01
            ? 'Funding нормализовался — топливо сквиза кончилось'
            : `FR ещё ${fundingPct.toFixed(3)}% — осторожно`,
          '',
          '24/7 Scanner · The Backside',
        ].join('\n'),
        dedupeKey: `cron:backside:${t.symbol}`,
        score: 80,
      })
    }
  }

  // Sequential with small delay to respect rate limits
  for (const t of memes) {
    await analyze(t, true)
    await new Promise((r) => setTimeout(r, 120))
  }
  for (const t of movers) {
    await analyze(t, false)
    await new Promise((r) => setTimeout(r, 120))
  }

  return alerts.sort((a, b) => b.score - a.score).slice(0, 8)
}
