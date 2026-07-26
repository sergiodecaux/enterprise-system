/**
 * Сопоставляет факторы сигнала/стакана/прогноза → направление на ТФ графика.
 */

import type { CoinSignal } from '../types'
import type { MultiTFAlignment, PriceForecast } from '../prediction/types'

export type ArrowBias = 'UP' | 'DOWN' | 'FLAT'

export interface DirectionVote {
  id: string
  label: string
  side: ArrowBias
  weight: number
  reason: string
}

export interface DirectionConsensus {
  bias: ArrowBias
  confidence: number
  /** −1..+1 */
  netScore: number
  votes: DirectionVote[]
  summary: string
}

function sideFromTrade(
  d: 'LONG' | 'SHORT' | 'BUY' | 'SELL' | null | undefined
): ArrowBias {
  if (d === 'LONG' || d === 'BUY') return 'UP'
  if (d === 'SHORT' || d === 'SELL') return 'DOWN'
  return 'FLAT'
}

function sideFromBias(
  b: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL' | 'UP' | 'DOWN' | null | undefined
): ArrowBias {
  if (b === 'BULLISH' || b === 'UP') return 'UP'
  if (b === 'BEARISH' || b === 'DOWN') return 'DOWN'
  return 'FLAT'
}

function pushVote(
  votes: DirectionVote[],
  id: string,
  label: string,
  side: ArrowBias,
  weight: number,
  reason: string
) {
  if (side === 'FLAT' || weight <= 0) return
  votes.push({ id, label, side, weight, reason })
}

export function computeDirectionConsensus(input: {
  signal?: CoinSignal | null
  forecast?: PriceForecast | null
  alignment?: MultiTFAlignment | null
  bookImbalance?: number | null
  newsBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  timeframe?: string
}): DirectionConsensus {
  const votes: DirectionVote[] = []
  const s = input.signal
  const tf = input.timeframe ?? '1h'

  if (s?.htfTrend) {
    const side = sideFromBias(s.htfTrend.bias)
    const w = 1.4 * Math.min(1, (s.htfTrend.strength || 40) / 80)
    pushVote(
      votes,
      'htf',
      'HTF',
      side,
      w,
      `${s.htfTrend.label} ${s.htfTrend.primaryTf} · ${s.htfTrend.strength}`
    )
  }

  if (s?.direction) {
    pushVote(
      votes,
      'signal',
      'Сигнал',
      sideFromTrade(s.direction),
      1.2,
      `${s.direction} · P${Math.round(s.probabilityPct ?? 0)}%`
    )
  }

  if (s?.scoreCard?.ready && s.scoreCard.direction) {
    pushVote(
      votes,
      'score',
      'Score',
      sideFromTrade(s.scoreCard.direction),
      1.3,
      `${s.scoreCard.grade} · ${Math.round(s.scoreCard.percent)}%`
    )
  }

  if (s?.mmIntent?.preferredSide) {
    pushVote(
      votes,
      'mm',
      'MM',
      sideFromTrade(s.mmIntent.preferredSide),
      1.0,
      s.mmIntent.preferredSide
    )
  }

  if (s?.globalFib?.entryBias) {
    pushVote(
      votes,
      'fib',
      'Fib',
      sideFromTrade(s.globalFib.entryBias),
      0.9,
      `impulse ${s.globalFib.impulse}`
    )
  }

  if (s?.coinTrend) {
    pushVote(
      votes,
      'coin',
      'Trend',
      sideFromBias(s.coinTrend as 'BULLISH' | 'BEARISH' | 'RANGING'),
      0.55,
      String(s.coinTrend)
    )
  }

  const domId = input.forecast?.dominantScenario
  const dom = input.forecast?.scenarios?.find((x) => x.id === domId)
  if (dom && dom.type !== 'RANGE') {
    pushVote(
      votes,
      'forecast',
      'Прогноз',
      sideFromTrade(dom.type),
      1.1,
      `${dom.id} · ${Math.round(dom.probability ?? 0)}%`
    )
  }

  if (input.alignment?.dominantBias) {
    pushVote(
      votes,
      'mtf',
      'MTF',
      sideFromTrade(
        input.alignment.dominantBias === 'NEUTRAL'
          ? null
          : input.alignment.dominantBias
      ),
      1.0,
      `align ${input.alignment.dominantBias}`
    )
  }

  const imb = input.bookImbalance
  if (imb != null && Math.abs(imb) >= 0.12) {
    pushVote(
      votes,
      'book',
      'Стакан',
      imb > 0 ? 'UP' : 'DOWN',
      0.7,
      `OBI ${(imb * 100).toFixed(0)}%`
    )
  }

  if (input.newsBias && input.newsBias !== 'NEUTRAL') {
    pushVote(
      votes,
      'news',
      'News',
      sideFromBias(input.newsBias),
      0.5,
      input.newsBias
    )
  }

  let up = 0
  let down = 0
  for (const v of votes) {
    if (v.side === 'UP') up += v.weight
    else if (v.side === 'DOWN') down += v.weight
  }
  const total = up + down
  const net = total > 0 ? (up - down) / total : 0
  const bias: ArrowBias =
    total < 0.8
      ? 'FLAT'
      : net >= 0.18
        ? 'UP'
        : net <= -0.18
          ? 'DOWN'
          : 'FLAT'
  const confidence =
    bias === 'FLAT'
      ? Math.round(Math.min(55, Math.abs(net) * 100))
      : Math.round(Math.min(96, 48 + Math.abs(net) * 52 + Math.min(votes.length, 6) * 3))

  const summary =
    bias === 'FLAT'
      ? `Боковик на ${tf} · факторы не сошлись`
      : bias === 'UP'
        ? `Рост на ${tf} · conf ${confidence}%`
        : `Падение на ${tf} · conf ${confidence}%`

  return {
    bias,
    confidence,
    netScore: net,
    votes: votes.sort((a, b) => b.weight - a.weight),
    summary,
  }
}
