/**
 * CLI backtest runner (Node).
 * Uses Cloudflare worker proxy — no Vite env required.
 *
 *   npx tsx scripts/runBacktest.ts
 */
import type { OhlcvCandle } from '../src/api/mexc'
import {
  runBacktest,
  type BacktestConfig,
  type BacktestCandleBundle,
} from '../src/engine/backtest/backtester'

const PROXY =
  process.env.MEXC_PROXY_URL?.replace(/\/$/, '') ??
  'https://mexc-proxy.sergiodecaux.workers.dev/mexc'

const TF_MAP: Record<string, string> = {
  '1m': 'Min1',
  '5m': 'Min5',
  '15m': 'Min15',
  '1h': 'Min60',
  '4h': 'Hour4',
  '1d': 'Day1',
}

function toApiSymbol(internal: string): string {
  return internal.replace('/USDT:USDT', '_USDT').replace('/', '_')
}

async function loadOhlcv(
  symbol: string,
  timeframe: keyof typeof TF_MAP,
  limit: number
): Promise<OhlcvCandle[]> {
  const apiSymbol = toApiSymbol(symbol)
  const interval = TF_MAP[timeframe]
  const url = `${PROXY}/api/v1/contract/kline/${apiSymbol}?interval=${interval}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const json = (await res.json()) as {
    success?: boolean
    data?: {
      time: number[]
      open: number[]
      high: number[]
      low: number[]
      close: number[]
      vol: number[]
    }
  }
  const d = json.data
  if (!d?.time?.length) return []
  const out: OhlcvCandle[] = []
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

async function loadBundle(symbol: string): Promise<BacktestCandleBundle> {
  const [ohlcv1h, ohlcv4h, ohlcv15m, ohlcv5m, ohlcv1d] = await Promise.all([
    loadOhlcv(symbol, '1h', 2000),
    loadOhlcv(symbol, '4h', 500),
    loadOhlcv(symbol, '15m', 1000),
    loadOhlcv(symbol, '5m', 1000),
    loadOhlcv(symbol, '1d', 200),
  ])
  return { ohlcv1h, ohlcv4h, ohlcv15m, ohlcv5m, ohlcv1d }
}

function printResult(
  result: ReturnType<typeof runBacktest>,
  initialBalance: number
) {
  console.log('\n' + '─'.repeat(72))
  console.log(`RESULTS: ${result.symbol}`)
  console.log('─'.repeat(72))
  console.log(
    `Period: ${result.period.start.toISOString().slice(0, 10)} → ${result.period.end.toISOString().slice(0, 10)}`
  )
  console.log(`Total Trades: ${result.totalTrades}`)
  console.log(
    `Win Rate: ${result.winRate.toFixed(2)}% (${result.wins}W / ${result.losses}L)`
  )
  console.log(`\nP&L:`)
  console.log(
    `  Total: ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(2)}%`
  )
  console.log(
    `  USDT: ${result.totalPnlUSDT >= 0 ? '+' : ''}$${result.totalPnlUSDT.toFixed(2)}`
  )
  console.log(
    `  Final Balance: $${(initialBalance + result.totalPnlUSDT).toFixed(2)}`
  )
  console.log(`\nRisk/Reward:`)
  console.log(`  Avg R:R: 1:${result.avgRR.toFixed(2)}`)
  console.log(`  Avg Win: +${result.avgWin.toFixed(2)}%`)
  console.log(`  Avg Loss: -${result.avgLoss.toFixed(2)}%`)
  console.log(
    `  Expectancy: ${result.expectancy >= 0 ? '+' : ''}${result.expectancy.toFixed(2)}%`
  )
  console.log(`\nMetrics:`)
  console.log(
    `  Max Drawdown: ${result.maxDrawdown.toFixed(2)}% (after ${result.maxDrawdownTrades} trades)`
  )
  console.log(`  Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`)
  console.log(`  Profit Factor: ${result.profitFactor.toFixed(2)}`)

  console.log(`\nBy Grade:`)
  for (const [grade, stats] of Object.entries(result.byGrade)) {
    console.log(
      `  ${grade}: ${stats.trades} trades, WR ${stats.winRate.toFixed(1)}%, Avg ${stats.avgPnl >= 0 ? '+' : ''}${stats.avgPnl.toFixed(2)}%`
    )
  }
  console.log(`\nBy Style:`)
  for (const [style, stats] of Object.entries(result.byStyle)) {
    console.log(
      `  ${style}: ${stats.trades} trades, WR ${stats.winRate.toFixed(1)}%, Avg ${stats.avgPnl >= 0 ? '+' : ''}${stats.avgPnl.toFixed(2)}%`
    )
  }

  console.log(`\nSample Trades (first 5):`)
  for (const trade of result.trades.slice(0, 5)) {
    console.log(
      `  ${new Date(trade.entryTime).toISOString().slice(0, 10)} ${trade.direction} ${trade.style} ${trade.scoreCardGrade}`
    )
    console.log(
      `    Entry: $${trade.entryPrice.toFixed(4)} → Exit: $${trade.exitPrice.toFixed(4)}`
    )
    console.log(
      `    Outcome: ${trade.outcome} | P&L: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}% ($${trade.pnlUSDT.toFixed(2)})`
    )
    console.log(
      `    MFE: +${trade.mfe.toFixed(2)}% | MAE: ${trade.mae.toFixed(2)}%`
    )
  }
}

async function main() {
  const symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT']
  const end = new Date()
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000)

  const baseConfig: Omit<BacktestConfig, 'symbol'> = {
    startDate: start,
    endDate: end,
    minGrade: 'A',
    styles: ['SCALP', 'INTRADAY'],
    minConfidence: 55,
    initialBalance: 10,
    riskPerTrade: 10,
    scalpTimeoutMinutes: 60,
    intradayTimeoutMinutes: 480,
    swingTimeoutMinutes: 2880,
    stepBars: 6,
  }

  console.log('Starting Backtest…')
  console.log('Proxy:', PROXY)
  console.log('Config:', baseConfig)
  console.log('Symbols:', symbols.join(', '))
  console.log('═'.repeat(72))

  for (const symbol of symbols) {
    console.log(`\nBacktesting ${symbol}…`)
    try {
      const bundle = await loadBundle(symbol)
      console.log(
        `  Loaded 1h=${bundle.ohlcv1h.length} 4h=${bundle.ohlcv4h.length} 15m=${bundle.ohlcv15m.length}`
      )
      const result = runBacktest(bundle, { ...baseConfig, symbol })
      printResult(result, baseConfig.initialBalance)
    } catch (err) {
      console.error(`  Error:`, err)
    }
  }

  console.log('\n' + '═'.repeat(72))
  console.log('Backtest Complete')
}

main().catch(console.error)
