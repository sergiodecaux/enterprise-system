import type { SentimentResult, SentimentLabel } from './types'
import { BULLISH_KEYWORDS, BEARISH_KEYWORDS, SOURCE_WEIGHTS } from './keywords'

export function analyzeText(
  title: string,
  summary = '',
  source = 'unknown'
): SentimentResult {
  const text = `${title} ${summary}`.toLowerCase()

  let bullishScore = 0
  let bearishScore = 0
  const bullishHits: string[] = []
  const bearishHits: string[] = []

  for (const { word, weight } of BULLISH_KEYWORDS) {
    if (text.includes(word.toLowerCase())) {
      bullishScore += weight
      bullishHits.push(word)
    }
  }

  for (const { word, weight } of BEARISH_KEYWORDS) {
    if (text.includes(word.toLowerCase())) {
      bearishScore += weight
      bearishHits.push(word)
    }
  }

  const total = bullishScore + bearishScore
  const rawScore = total > 0 ? (bullishScore - bearishScore) / total : 0

  const sourceWeight = SOURCE_WEIGHTS[source] ?? SOURCE_WEIGHTS.unknown
  const weightedScore = rawScore * Math.min(sourceWeight / 1.5, 1.0)

  const confidence = Math.min(
    (bullishHits.length + bearishHits.length) / 5,
    1.0
  )

  let label: SentimentLabel = 'NEUTRAL'
  if (weightedScore > 0.15) label = 'BULLISH'
  if (weightedScore < -0.15) label = 'BEARISH'

  return {
    label,
    score: weightedScore,
    confidence,
    bullishHits,
    bearishHits,
  }
}

export function aggregateSentiment(
  items: Array<{ sentiment: SentimentResult; publishedAt: number }>
): { score: number; label: SentimentLabel; scoreBoost: number } {
  if (items.length === 0) {
    return { score: 0, label: 'NEUTRAL', scoreBoost: 0 }
  }

  const now = Date.now() / 1000
  const MAX_AGE = 24 * 3600

  let weightedSum = 0
  let totalWeight = 0

  items.forEach((item) => {
    const age = now - item.publishedAt
    const ageFactor = Math.max(0, 1 - age / MAX_AGE)
    const conf = item.sentiment.confidence
    const w = ageFactor * (0.5 + conf * 0.5)

    weightedSum += item.sentiment.score * w
    totalWeight += w
  })

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0
  const scoreBoost = score * 1.5

  let label: SentimentLabel = 'NEUTRAL'
  if (score > 0.1) label = 'BULLISH'
  if (score < -0.1) label = 'BEARISH'

  return { score, label, scoreBoost }
}
