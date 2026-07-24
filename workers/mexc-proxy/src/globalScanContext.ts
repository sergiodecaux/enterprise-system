/**
 * Global market picture for finding INTRADAY / SWING deals.
 * BTC 1H + 4H + 1D bias, regimes, F&G, BTC.D — cycle-level, not LTF noise.
 */

import { detectMarketRegime, type MarketRegime } from './regime'
import type { MarketContext } from './marketContext'

type Candle = [number, number, number, number, number, number]
type Bias = 'BULL' | 'BEAR' | 'FLAT'
type Side = 'LONG' | 'SHORT'
type TradeStyle = 'SCALP' | 'INTRADAY' | 'SWING'
type TrendAlign = 'WITH_TREND' | 'COUNTER'

function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

/** Same spirit as scanner.tfBias — kept local to avoid circular imports */
export function biasFromCandles(candles: Candle[]): Bias {
  if (candles.length < 25) return 'FLAT'
  const closes = candles.map((c) => c[4])
  const last = closes[closes.length - 1]!
  const mid = sma(closes, 20)
  const look = Math.min(8, closes.length - 1)
  const mom =
    look > 0 && closes[closes.length - 1 - look]! > 0
      ? ((last - closes[closes.length - 1 - look]!) /
          closes[closes.length - 1 - look]!) *
        100
      : 0
  // RSI-lite via momentum windows
  let gains = 0
  let losses = 0
  for (let i = closes.length - 14; i < closes.length; i++) {
    if (i <= 0) continue
    const d = closes[i]! - closes[i - 1]!
    if (d >= 0) gains += d
    else losses -= d
  }
  const rs = losses > 0 ? gains / losses : 100
  const rsi = 100 - 100 / (1 + rs)
  if (last > mid * 1.0015 && rsi >= 53 && mom >= 0.12) return 'BULL'
  if (last < mid * 0.9985 && rsi <= 47 && mom <= -0.12) return 'BEAR'
  return 'FLAT'
}

/** Last closed candle color on daily/4h */
function lastClosedColor(candles: Candle[]): 'GREEN' | 'RED' | 'DOJI' {
  if (candles.length < 2) return 'DOJI'
  const c = candles[candles.length - 2]!
  const [, o, h, l, close] = c
  const body = Math.abs(close - o)
  const range = Math.max(h - l, 1e-12)
  if (body / range < 0.12) return 'DOJI'
  return close >= o ? 'GREEN' : 'RED'
}

export interface GlobalScanContext {
  btcBias1h: Bias
  btcBias4h: Bias
  btcBias1d: Bias
  /** Composite HTF: Daily > 4H > 1H */
  btcGlobal: Bias
  dayColor: 'GREEN' | 'RED' | 'DOJI'
  h4Color: 'GREEN' | 'RED' | 'DOJI'
  regime1h: MarketRegime
  regime4h: MarketRegime
  fearGreed: number | null
  btcDominance: number | null
  newsLabel: MarketContext['newsLabel']
  /** Preferred sides for style discovery */
  preferIntraSide: Side | null
  preferSwingSide: Side | null
  /** −2 risk-off … +2 risk-on for alts */
  riskOnOff: number
  summary: string
  lines: string[]
}

function compositeBias(d: Bias, h4: Bias, h1: Bias): Bias {
  if (d !== 'FLAT') return d
  if (h4 !== 'FLAT') return h4
  return h1
}

function sideFromBias(b: Bias): Side | null {
  if (b === 'BULL') return 'LONG'
  if (b === 'BEAR') return 'SHORT'
  return null
}

export function buildGlobalScanContext(opts: {
  btc1h: Candle[]
  btc4h: Candle[]
  btc1d: Candle[]
  marketCtx: MarketContext
}): GlobalScanContext {
  const btcBias1h = biasFromCandles(opts.btc1h)
  const btcBias4h = biasFromCandles(opts.btc4h)
  const btcBias1d = biasFromCandles(opts.btc1d)
  const btcGlobal = compositeBias(btcBias1d, btcBias4h, btcBias1h)
  const dayColor = lastClosedColor(opts.btc1d)
  const h4Color = lastClosedColor(opts.btc4h)
  const regime1h = detectMarketRegime(opts.btc1h)
  const regime4h = detectMarketRegime(
    opts.btc4h.length >= 20 ? opts.btc4h : opts.btc1h
  )

  const fg = opts.marketCtx.fearGreed
  const btcD = opts.marketCtx.btcDominance
  let riskOnOff = 0
  if (fg != null) {
    if (fg <= 30) riskOnOff += 1
    if (fg >= 70) riskOnOff -= 1
  }
  if (btcD != null) {
    if (btcD <= 48) riskOnOff += 1
    if (btcD >= 55) riskOnOff -= 1
  }
  if (opts.marketCtx.newsLabel === 'BULLISH') riskOnOff += 1
  if (opts.marketCtx.newsLabel === 'BEARISH') riskOnOff -= 1
  riskOnOff = Math.max(-2, Math.min(2, riskOnOff))

  // SWING follows Daily (fallback 4H). INTRA follows 4H (fallback 1H) when Daily not opposing hard.
  let preferSwingSide = sideFromBias(
    btcBias1d !== 'FLAT' ? btcBias1d : btcBias4h
  )
  if (dayColor === 'GREEN' && preferSwingSide == null) preferSwingSide = 'LONG'
  if (dayColor === 'RED' && preferSwingSide == null) preferSwingSide = 'SHORT'

  let preferIntraSide = sideFromBias(
    btcBias4h !== 'FLAT' ? btcBias4h : btcBias1h
  )
  // Don't fight a clear daily for INTRA with-trend discovery
  if (
    preferIntraSide &&
    btcBias1d !== 'FLAT' &&
    ((preferIntraSide === 'LONG' && btcBias1d === 'BEAR') ||
      (preferIntraSide === 'SHORT' && btcBias1d === 'BULL'))
  ) {
    preferIntraSide = null
  }

  const lines = [
    `BTC глобально: ${btcGlobal} (D ${btcBias1d}/${dayColor} · 4H ${btcBias4h}/${h4Color} · 1H ${btcBias1h})`,
    `Режим: 1H ${regime1h} · 4H ${regime4h}`,
    fg != null
      ? `F&G ${fg} (${opts.marketCtx.fearGreedLabel}) · BTC.D ${
          btcD != null ? `${btcD.toFixed(1)}%` : 'н/д'
        } · risk ${riskOnOff >= 0 ? '+' : ''}${riskOnOff}`
      : `BTC.D ${btcD != null ? `${btcD.toFixed(1)}%` : 'н/д'} · risk ${
          riskOnOff >= 0 ? '+' : ''
        }${riskOnOff}`,
    `Ищем: INTRA ${preferIntraSide ?? '—'} · SWING ${preferSwingSide ?? '—'}`,
  ]

  const summary = lines[0]!

  return {
    btcBias1h,
    btcBias4h,
    btcBias1d,
    btcGlobal,
    dayColor,
    h4Color,
    regime1h,
    regime4h,
    fearGreed: fg,
    btcDominance: btcD,
    newsLabel: opts.marketCtx.newsLabel,
    preferIntraSide,
    preferSwingSide,
    riskOnOff,
    summary,
    lines,
  }
}

/**
 * Gate INTRA/SWING against the global BTC picture.
 * SCALP is mostly local — only soft veto in extreme risk.
 */
export function globalAllowsStyle(opts: {
  g: GlobalScanContext
  side: Side
  style: TradeStyle
  align: TrendAlign
  score: number
  isBtc: boolean
}): { ok: boolean; reason?: string; scoreAdj: number; alignScore: number } {
  const { g, side, style, align } = opts
  let scoreAdj = opts.score
  let alignScore = 0

  const agreesGlobal =
    (side === 'LONG' && g.btcGlobal === 'BULL') ||
    (side === 'SHORT' && g.btcGlobal === 'BEAR')
  const fightsGlobal =
    (side === 'LONG' && g.btcGlobal === 'BEAR') ||
    (side === 'SHORT' && g.btcGlobal === 'BULL')

  if (style === 'SWING') {
    if (align === 'WITH_TREND') {
      if (fightsGlobal && g.btcBias1d !== 'FLAT') {
        return {
          ok: false,
          reason: 'global:swing_fights_daily',
          scoreAdj,
          alignScore: -3,
        }
      }
      if (agreesGlobal) {
        scoreAdj = Math.min(99, scoreAdj + 5)
        alignScore += 3
      }
      if (
        (side === 'LONG' && g.dayColor === 'GREEN') ||
        (side === 'SHORT' && g.dayColor === 'RED')
      ) {
        scoreAdj = Math.min(99, scoreAdj + 3)
        alignScore += 2
      }
      // SWING needs HTF regime not pure chop
      if (g.regime4h === 'VOLATILE_CHOP' && opts.score < 80) {
        return {
          ok: false,
          reason: 'global:swing_blocked_in_4h_chop',
          scoreAdj,
          alignScore,
        }
      }
      if (g.regime4h === 'TRENDING_STRONG' && agreesGlobal) {
        scoreAdj = Math.min(99, scoreAdj + 3)
        alignScore += 2
      }
    } else {
      // COUNTER swing only at extremes / greed-fear
      const extremeFg =
        (g.fearGreed != null && g.fearGreed >= 78 && side === 'SHORT') ||
        (g.fearGreed != null && g.fearGreed <= 22 && side === 'LONG')
      if (!extremeFg && opts.score < 82) {
        return {
          ok: false,
          reason: 'global:swing_counter_needs_extreme',
          scoreAdj,
          alignScore: -2,
        }
      }
      if (extremeFg) {
        scoreAdj = Math.min(99, scoreAdj + 4)
        alignScore += 1
      }
    }
  }

  if (style === 'INTRADAY') {
    if (align === 'WITH_TREND') {
      if (fightsGlobal && g.btcBias1d !== 'FLAT' && g.btcBias4h === g.btcBias1d) {
        // Daily+4H stacked against — block weak INTRA
        if (opts.score < 84) {
          return {
            ok: false,
            reason: 'global:intra_fights_htf_stack',
            scoreAdj,
            alignScore: -3,
          }
        }
      }
      const agrees4h =
        (side === 'LONG' && g.btcBias4h === 'BULL') ||
        (side === 'SHORT' && g.btcBias4h === 'BEAR')
      if (agrees4h) {
        scoreAdj = Math.min(99, scoreAdj + 4)
        alignScore += 2
      }
      if (agreesGlobal) {
        scoreAdj = Math.min(99, scoreAdj + 2)
        alignScore += 1
      }
      if (
        (side === 'LONG' && g.h4Color === 'GREEN') ||
        (side === 'SHORT' && g.h4Color === 'RED')
      ) {
        scoreAdj = Math.min(99, scoreAdj + 2)
        alignScore += 1
      }
      if (g.regime1h === 'VOLATILE_CHOP' && opts.score < 76) {
        return {
          ok: false,
          reason: 'global:intra_weak_in_chop',
          scoreAdj,
          alignScore,
        }
      }
    } else {
      // Counter INTRA: allow fades when F&G extreme or daily still OK
      if (opts.score < 78) {
        return {
          ok: false,
          reason: 'global:intra_counter_weak',
          scoreAdj,
          alignScore: -1,
        }
      }
    }

    // Alt season: BTC.D high hurts alt LONGs for INTRA
    if (
      !opts.isBtc &&
      side === 'LONG' &&
      g.btcDominance != null &&
      g.btcDominance >= 56 &&
      g.riskOnOff <= -1
    ) {
      scoreAdj = Math.max(0, scoreAdj - 4)
      alignScore -= 1
    }
    if (!opts.isBtc && side === 'LONG' && g.riskOnOff >= 1) {
      scoreAdj = Math.min(99, scoreAdj + 2)
      alignScore += 1
    }
  }

  if (style === 'SCALP') {
    // Soft: don't invent swings from scalp path
    if (fightsGlobal && g.regime1h === 'TRENDING_STRONG' && align === 'COUNTER') {
      if (opts.score < 80) {
        return {
          ok: false,
          reason: 'global:scalp_counter_vs_strong_btc',
          scoreAdj,
          alignScore: -2,
        }
      }
    }
  }

  return { ok: true, scoreAdj, alignScore }
}

/** Extra win% factors from global picture */
export function globalProbabilityFactors(opts: {
  g: GlobalScanContext
  side: Side
  style: TradeStyle
  alignScore: number
}): { adj: number; factors: string[] } {
  const factors: string[] = [...opts.g.lines.slice(0, 2)]
  let adj = Math.max(-6, Math.min(8, opts.alignScore * 1.5))
  if (opts.alignScore >= 3) {
    factors.push(`+${Math.round(adj)}% глобальная картина за ${opts.side}`)
  } else if (opts.alignScore <= -2) {
    factors.push(`${Math.round(adj)}% глобально против`)
  }
  if (opts.style === 'SWING' && opts.g.dayColor !== 'DOJI') {
    factors.push(
      `День BTC закрыт ${opts.g.dayColor === 'GREEN' ? 'зелёным' : 'красным'}`
    )
  }
  if (opts.style === 'INTRADAY' && opts.g.h4Color !== 'DOJI') {
    factors.push(
      `4H BTC закрыт ${opts.g.h4Color === 'GREEN' ? 'зелёным' : 'красным'}`
    )
  }
  return { adj: Math.round(adj), factors }
}
