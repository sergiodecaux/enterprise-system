/**
 * Offline 24h probe for PEAK_FUEL_FAIL on current top pumps.
 * Run: npx tsx scripts/peakFuelFailDayProbe.ts
 * (or node after compile)
 */
import {
  detectPeakFuelFail,
  type Candle,
} from '../workers/mexc-proxy/src/peakFuelFail'

const MEXC = 'https://contract.mexc.com'
const SL = 0.01
const TP = 0.018
const HOLD_BARS = 45 // ~45 min max hold

type Ticker = {
  symbol: string
  lastPrice?: number | string
  riseFallRate?: number | string
  amount24?: number | string
  holdVol?: number | string
}

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'PeakProbe/1.0' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function klines(symbol: string, limit = 300): Promise<Candle[]> {
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

function simulateShort(
  candles: Candle[],
  entryIdx: number,
  entry: number
): 'WIN' | 'LOSS' | 'TIMEOUT' | 'BE' {
  const sl = entry * (1 + SL)
  const tp = entry * (1 - TP)
  for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + 1 + HOLD_BARS); i++) {
    const h = candles[i]![2]
    const l = candles[i]![3]
    // conservative: SL first if both in bar
    if (h >= sl && l <= tp) return 'LOSS'
    if (h >= sl) return 'LOSS'
    if (l <= tp) return 'WIN'
  }
  const last = candles[Math.min(candles.length - 1, entryIdx + HOLD_BARS)]![4]
  const pnl = (entry - last) / entry
  if (pnl >= TP * 0.5) return 'WIN'
  if (pnl <= -SL * 0.5) return 'LOSS'
  if (Math.abs(pnl) < 0.002) return 'BE'
  return pnl > 0 ? 'WIN' : 'LOSS'
}

async function main() {
  const tickersJson = await mexcJson<{ data?: Ticker[] }>('/api/v1/contract/ticker')
  const tickers = (tickersJson?.data ?? []).filter((t) =>
    String(t.symbol).endsWith('_USDT')
  )

  const pumps = tickers
    .map((t) => ({
      symbol: String(t.symbol),
      chg: Number(t.riseFallRate ?? 0) * 100,
      vol: Number(t.amount24 ?? 0),
      holdVol: t.holdVol != null ? Number(t.holdVol) : null,
      price: Number(t.lastPrice ?? 0),
    }))
    .filter(
      (t) =>
        t.chg >= 8 &&
        t.vol >= 150_000 &&
        t.vol <= 8_000_000 &&
        !['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT'].includes(t.symbol)
    )
    .sort((a, b) => b.chg - a.chg)
    .slice(0, 18)

  console.log(`Top pumps scanned: ${pumps.length}`)
  let wins = 0
  let losses = 0
  let be = 0
  let timeout = 0
  let signals = 0
  const rows: string[] = []

  for (const coin of pumps) {
    const cs = await klines(coin.symbol, 360)
    if (cs.length < 80) continue
    let lastFire = -999
    for (let i = 40; i < cs.length - 5; i++) {
      if (i - lastFire < 20) continue // cooldown 20m between signals same coin
      const window = cs.slice(0, i + 1)
      const px = window[window.length - 1]![4]
      // approximate OI flat: use volume stall as weak fuel proxy when no OI series
      const recentVol =
        window.slice(-10).reduce((s, c) => s + c[5], 0) / 10
      const priorVol =
        window.slice(-30, -10).reduce((s, c) => s + c[5], 0) / 20
      const buyFlowProxy = 62 // assume aggressive buys into peak (typical fail case)
      const moveBps =
        ((window[window.length - 1]![4] - window[window.length - 4]![4]) /
          window[window.length - 4]![4]) *
        10_000

      const sig = detectPeakFuelFail({
        symbol: coin.symbol,
        price: px,
        chg24hPct: coin.chg,
        dayBias: 'PUMP',
        holdVol: coin.holdVol,
        prevHoldVol: coin.holdVol != null ? coin.holdVol * 1.001 : null, // flat OI
        candles1m: window,
        buyFlowPct: buyFlowProxy,
        priceMoveBps: moveBps,
        absorptionShort: Math.abs(moveBps) <= 10 && recentVol > priorVol * 0.8,
        cvdBearish: false,
      })
      if (!sig?.ready) continue
      signals++
      lastFire = i
      const outcome = simulateShort(cs, i, sig.limitPrice)
      if (outcome === 'WIN') wins++
      else if (outcome === 'LOSS') losses++
      else if (outcome === 'BE') be++
      else timeout++
      const t = new Date(cs[i]![0]).toISOString().slice(11, 16)
      rows.push(
        `${coin.symbol} ${t} UTC conf=${sig.confidence} → ${outcome} @${sig.limitPrice}`
      )
    }
  }

  const decided = wins + losses
  const wr = decided ? ((wins / decided) * 100).toFixed(1) : 'n/a'
  console.log('\n=== PEAK_FUEL_FAIL 24h probe (live MEXC pumps) ===')
  console.log(`signals=${signals} W=${wins} L=${losses} BE=${be} TO=${timeout}`)
  console.log(`decided WR=${wr}% (n=${decided})  TP=${TP * 100}% SL=${SL * 100}% hold≤${HOLD_BARS}m`)
  console.log('\nSample:')
  for (const r of rows.slice(-25)) console.log(' ', r)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
