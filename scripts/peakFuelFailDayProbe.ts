/**
 * Offline probe PEAK A vs B on live MEXC pumps.
 * npx tsx scripts/peakFuelFailDayProbe.ts
 */
import {
  detectPeakFuelFail,
  type Candle,
} from '../workers/mexc-proxy/src/peakFuelFail'

const MEXC = 'https://contract.mexc.com'
const SL = 0.01
const TP = 0.018
const HOLD_BARS = 45

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
      headers: { Accept: 'application/json', 'User-Agent': 'PeakProbe/1.1' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function klines(symbol: string, limit = 360): Promise<Candle[]> {
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
): 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT' {
  const sl = entry * (1 + SL)
  const tp = entry * (1 - TP)
  for (
    let i = entryIdx + 1;
    i < Math.min(candles.length, entryIdx + 1 + HOLD_BARS);
    i++
  ) {
    const h = candles[i]![2]
    const l = candles[i]![3]
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

type Bucket = { n: number; w: number; l: number; be: number; to: number }

function bump(b: Bucket, o: string) {
  b.n++
  if (o === 'WIN') b.w++
  else if (o === 'LOSS') b.l++
  else if (o === 'BE') b.be++
  else b.to++
}

function wr(b: Bucket) {
  const d = b.w + b.l
  return d ? `${((100 * b.w) / d).toFixed(1)}% (n=${d})` : 'n/a'
}

function exp(b: Bucket) {
  const d = b.w + b.l
  if (!d) return null
  return (b.w / d) * TP * 100 - (b.l / d) * SL * 100
}

async function main() {
  const tickersJson = await mexcJson<{ data?: Ticker[] }>(
    '/api/v1/contract/ticker'
  )
  const tickers = (tickersJson?.data ?? []).filter((t) =>
    String(t.symbol).endsWith('_USDT')
  )
  console.log('tickers', tickers.length)

  const pumps = tickers
    .map((t) => ({
      symbol: String(t.symbol),
      chg: Number(t.riseFallRate ?? 0) * 100,
      vol: Number(t.amount24 ?? 0),
      holdVol: t.holdVol != null ? Number(t.holdVol) : null,
    }))
    .filter(
      (t) =>
        t.chg >= 5 &&
        t.vol >= 100_000 &&
        t.vol <= 20_000_000 &&
        !['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT'].includes(t.symbol)
    )
    .sort((a, b) => b.chg - a.chg)
    .slice(0, 22)

  console.log(
    `Top pumps: ${pumps.length}`,
    pumps
      .slice(0, 8)
      .map((p) => `${p.symbol.replace('_USDT', '')}+${p.chg.toFixed(0)}%`)
      .join(', ')
  )

  const all: Bucket = { n: 0, w: 0, l: 0, be: 0, to: 0 }
  const A: Bucket = { n: 0, w: 0, l: 0, be: 0, to: 0 }
  const B: Bucket = { n: 0, w: 0, l: 0, be: 0, to: 0 }
  const sample: string[] = []

  for (const coin of pumps) {
    const cs = await klines(coin.symbol, 400)
    if (cs.length < 80) {
      console.log('skip no klines', coin.symbol)
      continue
    }
    let lastFire = -999
    for (let i = 50; i < cs.length - 5; i++) {
      if (i - lastFire < 25) continue
      const window = cs.slice(0, i + 1)
      const px = window[window.length - 1]![4]
      const recentVol =
        window.slice(-10).reduce((s, c) => s + c[5], 0) / 10
      const priorVol =
        window.slice(-30, -10).reduce((s, c) => s + c[5], 0) / 20
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
        prevHoldVol:
          coin.holdVol != null ? coin.holdVol * 1.0005 : null,
        candles1m: window,
        buyFlowPct: 60,
        priceMoveBps: moveBps,
        absorptionShort:
          Math.abs(moveBps) <= 12 && recentVol > priorVol * 0.75,
        cvdBearish: false,
      })
      if (!sig?.ready) continue
      lastFire = i
      const outcome = simulateShort(cs, i, sig.limitPrice)
      bump(all, outcome)
      bump(sig.quality === 'A' ? A : B, outcome)
      if (sample.length < 30) {
        sample.push(
          `${coin.symbol.replace('_USDT', '')} Q${sig.quality} c${sig.confidence} → ${outcome}`
        )
      }
    }
  }

  console.log('\n=== PEAK_FUEL_FAIL probe (current detector v27.4) ===')
  console.log(`ALL ready  signals=${all.n} WR=${wr(all)} BE=${all.be}`)
  console.log(`A-tier TG  signals=${A.n} WR=${wr(A)} BE=${A.be} exp%=${exp(A)?.toFixed(2) ?? 'n/a'}`)
  console.log(`B-tier log signals=${B.n} WR=${wr(B)} BE=${B.be}`)
  console.log('sample:', sample.slice(0, 20).join(' | '))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
