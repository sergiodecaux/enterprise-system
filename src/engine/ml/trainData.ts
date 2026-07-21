import type { TrainingExample, MLFeatures } from './types'
import { createModel, trainModel } from './imbalancePredictor'
import type { MLModelState } from './types'

function baseFeatures(partial: Partial<MLFeatures>): MLFeatures {
  return {
    currentImbalance: 0,
    avgImbalance5min: 0,
    imbalanceTrend: 0,
    imbalanceVolatility: 8,
    bidVolumeRatio: 0.5,
    askVolumeRatio: 0.5,
    volumeChange: 0,
    activeBidWalls: 0,
    activeAskWalls: 0,
    wallEatenRecently: 0,
    wallEatenSide: null,
    spreadPercent: 0.015,
    spreadTrend: 0,
    priceChange1min: 0,
    priceVolatility: 5,
    ...partial,
  }
}

/** Синтетические обучающие данные (паттерны стакана) */
export function generateTrainingData(): TrainingExample[] {
  const examples: TrainingExample[] = []

  for (let i = 0; i < 20; i++) {
    examples.push({
      features: baseFeatures({
        currentImbalance: 40 + Math.random() * 30,
        avgImbalance5min: 35 + Math.random() * 20,
        imbalanceTrend: 1,
        imbalanceVolatility: 10 + Math.random() * 10,
        bidVolumeRatio: 0.6 + Math.random() * 0.2,
        askVolumeRatio: 0.2 + Math.random() * 0.2,
        volumeChange: 10 + Math.random() * 20,
        activeBidWalls: 2 + Math.floor(Math.random() * 3),
        activeAskWalls: Math.floor(Math.random() * 2),
        wallEatenRecently: 1,
        wallEatenSide: 'ASK',
        spreadTrend: -0.1,
        priceChange1min: 0.1 + Math.random() * 0.3,
      }),
      label: 1,
    })
  }

  for (let i = 0; i < 20; i++) {
    examples.push({
      features: baseFeatures({
        currentImbalance: -40 - Math.random() * 30,
        avgImbalance5min: -35 - Math.random() * 20,
        imbalanceTrend: -1,
        imbalanceVolatility: 10 + Math.random() * 10,
        bidVolumeRatio: 0.2 + Math.random() * 0.2,
        askVolumeRatio: 0.6 + Math.random() * 0.2,
        volumeChange: 10 + Math.random() * 20,
        activeBidWalls: Math.floor(Math.random() * 2),
        activeAskWalls: 2 + Math.floor(Math.random() * 3),
        wallEatenRecently: 1,
        wallEatenSide: 'BID',
        spreadTrend: -0.1,
        priceChange1min: -0.1 - Math.random() * 0.3,
      }),
      label: -1,
    })
  }

  for (let i = 0; i < 15; i++) {
    examples.push({
      features: baseFeatures({
        currentImbalance: -10 + Math.random() * 20,
        avgImbalance5min: -5 + Math.random() * 10,
        imbalanceTrend: 0,
        imbalanceVolatility: 5 + Math.random() * 5,
        bidVolumeRatio: 0.48 + Math.random() * 0.04,
        askVolumeRatio: 0.48 + Math.random() * 0.04,
        volumeChange: -5 + Math.random() * 10,
        priceChange1min: -0.05 + Math.random() * 0.1,
        priceVolatility: 3 + Math.random() * 3,
      }),
      label: 0,
    })
  }

  for (let i = 0; i < 10; i++) {
    examples.push({
      features: baseFeatures({
        currentImbalance: -20 + Math.random() * 40,
        avgImbalance5min: -10 + Math.random() * 20,
        imbalanceTrend: Math.random() > 0.5 ? 1 : -1,
        imbalanceVolatility: 20 + Math.random() * 15,
        bidVolumeRatio: 0.4 + Math.random() * 0.2,
        askVolumeRatio: 0.4 + Math.random() * 0.2,
        volumeChange: -10 + Math.random() * 20,
        priceChange1min: -0.2 + Math.random() * 0.4,
        priceVolatility: 10 + Math.random() * 10,
      }),
      label: 0,
    })
  }

  return examples
}

/** Предобученная модель на синтетике */
export function getPretrainedModel(): MLModelState {
  return trainModel(createModel(), generateTrainingData())
}
