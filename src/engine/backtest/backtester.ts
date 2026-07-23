import type { OhlcvCandle } from '../../api/mexc'
import type { CoinSignal, TradeStyle } from '../types'
import { analyzeSymbol } from '../ProbabilityEngine'
import { resolveDailyBias, detectMarketStructure } from '../smc'
import { logger } from '../../utils/logger'

export type TradeOutcome = 'TP_HIT' | 'SL_HIT' | 'TIMEOUT' | 'INVALIDATED'

export interface BacktestTrade {
  symbol: string
  direction: 'LONG' | 'SHORT'
  style: TradeStyle
  entryTime: number
  entryPrice: number
  scoreCardGrade: string
  scoreCardTotal: number
  confidence: number
  exitTime: number
  exitPrice: number
  outcome: TradeOutcome
  pnl: number
  pnlUSDT: number
  mfe: number
  mae: number
  durationMinutes: number
  sl: number
  tp1: number
  tp2: number | null
  reasons: string[]
}

export interface BacktestResult {
  symbol: string
  period: { start: Date; end: Date }
  totalTrades: number
  trades: BacktestTrade[]
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  totalPnlUSDT: number
  avgWin: number
  avgLoss: number
  largestWin: number
  largestLoss: number
  avgRR: number
  expectancy: number
  maxDrawdown: number
  maxDrawdownTrades: number
  byGrade: Record<string, { trades: number; winRate: number; avgPnl: number }>
  byStyle: Record<string, { trades: number; winRate: number; avgPnl: number }>
  sharpeRatio: number
  profitFactor: number
  equityCurve: Array<{ time: number; balance: number; tradeNum: number }>
}

export interface BacktestConfig {
  symbol: string
  startDate: Date
  endDate: Date
  minGrade?: 'A+' | 'A' | 'B'
  styles?: TradeStyle[]
  minConfidence?: number
  initialBalance: number
  riskPerTrade: number
  scalpTimeoutMinutes?: number
  intradayTimeoutMinutes?: number
  swingTimeoutMinutes?: number
  /** Step through primary TF every N bars (speed vs density) */
  stepBars?: number
}

export interface BacktestCandleBundle {
  ohlcv1h: OhlcvCandle[]
  ohlcv4h: OhlcvCandle[]
  ohlcv15m: OhlcvCandle[]
  ohlcv5m?: OhlcvCandle[]
  ohlcv1m?: OhlcvCandle[]
  ohlcv1d?: OhlcvCandle[]
}

function sliceUntil(
  candles: OhlcvCandle[],
  endTime: number,
  maxLen: number
): OhlcvCandle[] {
  const cut = candles.filter((c) => c[0] <= endTime)
  return cut.slice(-maxLen)
}

function simulateTrade(
  signal: CoinSignal,
  futureCandles: OhlcvCandle[],
  config: BacktestConfig
): BacktestTrade {
  const entry =
    signal.surgicalEntry?.limitEntry && signal.surgicalEntry.limitEntry > 0
      ? signal.surgicalEntry.limitEntry
      : signal.price
  const sl = signal.sl!
  const tp1 = signal.tp1!
  const tp2 = signal.tp2 ?? null
  const direction = signal.direction!
  const style = signal.tradeStyle ?? 'INTRADAY'

  const entryTime = futureCandles[0]?.[0] ?? Date.now()
  let exitTime = entryTime
  let exitPrice = entry
  let outcome: TradeOutcome = 'TIMEOUT'
  let mfe = 0
  let mae = 0

  const timeoutMap = {
    SCALP: config.scalpTimeoutMinutes ?? 60,
    INTRADAY: config.intradayTimeoutMinutes ?? 480,
    SWING: config.swingTimeoutMinutes ?? 2880,
  }
  const timeoutMs = timeoutMap[style] * 60 * 1000

  for (let i = 0; i < futureCandles.length; i++) {
    const [time, , high, low, close] = futureCandles[i]

    if (time - entryTime > timeoutMs) {
      outcome = 'TIMEOUT'
      exitTime = time
      exitPrice = close
      break
    }

    if (signal.invalidationPrice != null) {
      const invalidated =
        direction === 'LONG'
          ? close < signal.invalidationPrice
          : close > signal.invalidationPrice
      if (invalidated) {
        outcome = 'INVALIDATED'
        exitTime = time
        exitPrice = close
        break
      }
    }

    if (direction === 'LONG') {
      mfe = Math.max(mfe, ((high - entry) / entry) * 100)
      mae = Math.min(mae, ((low - entry) / entry) * 100)
      if (low <= sl) {
        outcome = 'SL_HIT'
        exitTime = time
        exitPrice = sl
        break
      }
      if (high >= tp1) {
        outcome = 'TP_HIT'
        exitTime = time
        exitPrice = tp1
        break
      }
    } else {
      mfe = Math.max(mfe, ((entry - low) / entry) * 100)
      mae = Math.min(mae, ((high - entry) / entry) * 100)
      if (high >= sl) {
        outcome = 'SL_HIT'
        exitTime = time
        exitPrice = sl
        break
      }
      if (low <= tp1) {
        outcome = 'TP_HIT'
        exitTime = time
        exitPrice = tp1
        break
      }
    }

    if (i === futureCandles.length - 1) {
      exitTime = time
      exitPrice = close
      outcome = 'TIMEOUT'
    }
  }

  const pnl =
    direction === 'LONG'
      ? ((exitPrice - entry) / entry) * 100
      : ((entry - exitPrice) / entry) * 100

  const riskAmount = config.initialBalance * (config.riskPerTrade / 100)
  const slDistance = Math.abs(entry - sl) / entry || 0.001
  const positionSize = riskAmount / slDistance
  const pnlUSDT = (pnl / 100) * positionSize

  return {
    symbol: signal.symbol,
    direction,
    style,
    entryTime,
    entryPrice: entry,
    scoreCardGrade: signal.scoreCard?.grade ?? '?',
    scoreCardTotal: signal.scoreCard?.totalScore ?? 0,
    confidence: signal.scoreCard?.percent ?? signal.probabilityPct ?? 0,
    exitTime,
    exitPrice,
    outcome,
    pnl,
    pnlUSDT,
    mfe,
    mae,
    durationMinutes: (exitTime - entryTime) / 60_000,
    sl,
    tp1,
    tp2,
    reasons: signal.zones.slice(0, 5),
  }
}

const GRADE_RANK: Record<string, number> = {
  'A+': 4,
  A: 3,
  B: 2,
  SKIP: 1,
  '?': 0,
}

/**
 * Walk primary 1H series; at each bar rebuild TF context and run PE.
 * Historical path uses OHLCV-proxy CVD (no live deals/depth).
 */
export function runBacktest(
  bundle: BacktestCandleBundle,
  config: BacktestConfig
): BacktestResult {
  const primary = bundle.ohlcv1h.filter(
    (c) =>
      c[0] >= config.startDate.getTime() && c[0] <= config.endDate.getTime()
  )
  const all1h = bundle.ohlcv1h

  logger.info(`[Backtest] ${config.symbol}`, {
    bars: primary.length,
    period: `${config.startDate.toISOString().slice(0, 10)} → ${config.endDate.toISOString().slice(0, 10)}`,
  })

  const trades: BacktestTrade[] = []
  let balance = config.initialBalance
  const equityCurve: BacktestResult['equityCurve'] = [
    {
      time: primary[0]?.[0] ?? config.startDate.getTime(),
      balance,
      tradeNum: 0,
    },
  ]

  const step = Math.max(1, config.stepBars ?? 4)
  const warm = 80

  for (let i = warm; i < primary.length - 10; i += step) {
    const endTime = primary[i][0]
    const idxInAll = all1h.findIndex((c) => c[0] === endTime)
    if (idxInAll < 50) continue

    const ohlcv1h = sliceUntil(all1h, endTime, 300)
    const ohlcv4h = sliceUntil(bundle.ohlcv4h, endTime, 100)
    const ohlcv15m = sliceUntil(bundle.ohlcv15m, endTime, 80)
    const ohlcv5m = bundle.ohlcv5m
      ? sliceUntil(bundle.ohlcv5m, endTime, 120)
      : undefined
    const ohlcv1m = bundle.ohlcv1m
      ? sliceUntil(bundle.ohlcv1m, endTime, 100)
      : undefined
    const ohlcv1d = bundle.ohlcv1d
      ? sliceUntil(bundle.ohlcv1d, endTime, 60)
      : undefined

    if (ohlcv1h.length < 50 || ohlcv4h.length < 30) continue

    try {
      const dailyBias = resolveDailyBias(
        ohlcv1d && ohlcv1d.length >= 20 ? ohlcv1d : ohlcv4h
      )
      const btcTrend = detectMarketStructure(ohlcv4h, 40).trend

      const { signal, triggered } = analyzeSymbol({
        internalSymbol: config.symbol,
        ohlcv4h,
        ohlcv1h,
        ohlcv15m,
        ohlcv1d: ohlcv1d && ohlcv1d.length >= 20 ? ohlcv1d : undefined,
        priceChange24h: 0,
        dailyBias,
        btcTrend,
        ohlcv5m: ohlcv5m && ohlcv5m.length >= 15 ? ohlcv5m : undefined,
        ohlcv1m: ohlcv1m && ohlcv1m.length >= 20 ? ohlcv1m : undefined,
      })

      if (
        !triggered ||
        !signal.direction ||
        signal.sl == null ||
        signal.tp1 == null
      ) {
        continue
      }

      if (config.minGrade) {
        const g = signal.scoreCard?.grade ?? 'SKIP'
        if ((GRADE_RANK[g] ?? 0) < (GRADE_RANK[config.minGrade] ?? 0)) {
          continue
        }
      }

      if (
        config.styles &&
        signal.tradeStyle &&
        !config.styles.includes(signal.tradeStyle)
      ) {
        continue
      }

      if (config.minConfidence != null) {
        const conf =
          signal.scoreCard?.percent ?? signal.probabilityPct ?? 0
        if (conf < config.minConfidence) continue
      }

      const futureCandles = primary.slice(i)
      if (futureCandles.length < 2) continue

      const trade = simulateTrade(signal, futureCandles, config)
      trades.push(trade)
      balance += trade.pnlUSDT
      equityCurve.push({
        time: trade.exitTime,
        balance,
        tradeNum: trades.length,
      })

      const exitIdx = primary.findIndex((c) => c[0] >= trade.exitTime)
      if (exitIdx > i) i = exitIdx
    } catch (err) {
      logger.warn(`[Backtest] bar ${i}`, err)
    }
  }

  const wins = trades.filter((t) => t.outcome === 'TP_HIT').length
  const losses = trades.filter((t) =>
    t.outcome === 'SL_HIT' || t.outcome === 'INVALIDATED'
  ).length
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0
  const totalPnlUSDT = balance - config.initialBalance
  const totalPnl =
    (totalPnlUSDT / config.initialBalance) * 100

  const winningTrades = trades.filter((t) => t.pnl > 0)
  const losingTrades = trades.filter((t) => t.pnl < 0)
  const avgWin = winningTrades.length
    ? winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length
    : 0
  const avgLoss = losingTrades.length
    ? losingTrades.reduce((s, t) => s + Math.abs(t.pnl), 0) /
      losingTrades.length
    : 0
  const largestWin = winningTrades.length
    ? Math.max(...winningTrades.map((t) => t.pnl))
    : 0
  const largestLoss = losingTrades.length
    ? Math.max(...losingTrades.map((t) => Math.abs(t.pnl)))
    : 0

  const avgRR = trades.length
    ? trades.reduce((s, t) => {
        const risk = Math.abs(t.entryPrice - t.sl) / t.entryPrice
        const reward = Math.abs(t.tp1 - t.entryPrice) / t.entryPrice
        return s + reward / (risk || 0.001)
      }, 0) / trades.length
    : 0

  const expectancy =
    avgWin * (winRate / 100) - avgLoss * ((100 - winRate) / 100)

  let peak = config.initialBalance
  let maxDD = 0
  let maxDDTrades = 0
  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance
    else {
      const dd = ((peak - point.balance) / peak) * 100
      if (dd > maxDD) {
        maxDD = dd
        maxDDTrades = point.tradeNum
      }
    }
  }

  const byGrade: BacktestResult['byGrade'] = {}
  for (const trade of trades) {
    const grade = trade.scoreCardGrade
    if (!byGrade[grade]) byGrade[grade] = { trades: 0, winRate: 0, avgPnl: 0 }
    byGrade[grade].trades++
    if (trade.outcome === 'TP_HIT') byGrade[grade].winRate++
    byGrade[grade].avgPnl += trade.pnl
  }
  for (const grade of Object.keys(byGrade)) {
    byGrade[grade].winRate =
      (byGrade[grade].winRate / byGrade[grade].trades) * 100
    byGrade[grade].avgPnl /= byGrade[grade].trades
  }

  const byStyle: BacktestResult['byStyle'] = {}
  for (const trade of trades) {
    const style = trade.style
    if (!byStyle[style]) byStyle[style] = { trades: 0, winRate: 0, avgPnl: 0 }
    byStyle[style].trades++
    if (trade.outcome === 'TP_HIT') byStyle[style].winRate++
    byStyle[style].avgPnl += trade.pnl
  }
  for (const style of Object.keys(byStyle)) {
    byStyle[style].winRate =
      (byStyle[style].winRate / byStyle[style].trades) * 100
    byStyle[style].avgPnl /= byStyle[style].trades
  }

  const returns = trades.map((t) => t.pnl)
  const avgReturn = returns.length
    ? returns.reduce((s, r) => s + r, 0) / returns.length
    : 0
  const stdDev = returns.length
    ? Math.sqrt(
        returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length
      )
    : 0
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0

  const grossProfit = winningTrades.reduce((s, t) => s + t.pnlUSDT, 0)
  const grossLoss = losingTrades.reduce((s, t) => s + Math.abs(t.pnlUSDT), 0)
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0

  return {
    symbol: config.symbol,
    period: { start: config.startDate, end: config.endDate },
    totalTrades: trades.length,
    trades,
    wins,
    losses,
    winRate,
    totalPnl,
    totalPnlUSDT,
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    avgRR,
    expectancy,
    maxDrawdown: maxDD,
    maxDrawdownTrades: maxDDTrades,
    byGrade,
    byStyle,
    sharpeRatio,
    profitFactor,
    equityCurve,
  }
}
