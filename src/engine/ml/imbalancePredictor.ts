import type { MLFeatures, MLPrediction, MLModelState, TrainingExample } from './types'
import { normalizeFeatures } from './featureExtractor'

const FEATURE_COUNT = 15

export function createModel(): MLModelState {
  return {
    weights: new Array(FEATURE_COUNT).fill(0),
    bias: 0,
    accuracy: 0,
    trainingSize: 0,
    lastTrained: 0,
  }
}

function predictScore(features: number[], weights: number[], bias: number): number {
  const score = features.reduce((sum, f, i) => sum + f * (weights[i] ?? 0), 0) + bias
  return Math.tanh(score)
}

export function trainModel(
  model: MLModelState,
  examples: TrainingExample[]
): MLModelState {
  if (examples.length === 0) return model

  const learningRate = 0.01
  const epochs = 50
  let weights = [...model.weights]
  let bias = model.bias

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const example of examples) {
      const features = normalizeFeatures(example.features)
      const predicted = predictScore(features, weights, bias)
      const error = example.label - predicted
      weights = weights.map((w, i) => w + learningRate * error * (features[i] ?? 0))
      bias += learningRate * error
    }
  }

  let correct = 0
  for (const example of examples) {
    const features = normalizeFeatures(example.features)
    const predicted = predictScore(features, weights, bias)
    const predictedLabel = predicted > 0.3 ? 1 : predicted < -0.3 ? -1 : 0
    if (predictedLabel === example.label) correct++
  }

  return {
    weights,
    bias,
    accuracy: (correct / examples.length) * 100,
    trainingSize: examples.length,
    lastTrained: Date.now(),
  }
}

const FEATURE_NAMES = [
  'Текущий imbalance',
  'Средний imbalance 5мин',
  'Тренд imbalance',
  'Волатильность',
  'Ratio bid объёма',
  'Ratio ask объёма',
  'Изменение объёма',
  'BID стенок',
  'ASK стенок',
  'Стенка съедена',
  'Сторона съеденной стенки',
  'Спред %',
  'Тренд спреда',
  'Изменение цены 1мин',
  'Волатильность цены',
]

export function predictDirection(
  model: MLModelState,
  features: MLFeatures
): MLPrediction {
  const normalized = normalizeFeatures(features)
  const score = predictScore(normalized, model.weights, model.bias)

  let direction: MLPrediction['direction'] = 'NEUTRAL'
  if (score > 0.3) direction = 'LONG'
  else if (score < -0.3) direction = 'SHORT'

  const confidence = Math.min(Math.abs(score) * 100, 95)

  const contributions = normalized.map((f, i) => ({
    name: FEATURE_NAMES[i] ?? `f${i}`,
    value: f * (model.weights[i] ?? 0),
  }))

  const reasoning = contributions
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((c) => `${c.name} → ${c.value > 0 ? 'LONG' : 'SHORT'}`)

  return {
    direction,
    confidence,
    timeframe: '5min',
    reasoning,
    timestamp: Date.now(),
  }
}
