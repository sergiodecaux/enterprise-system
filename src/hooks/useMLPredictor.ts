import { useState, useEffect, useRef } from 'react'
import type {
  OrderBookHistory,
  ImbalanceStats,
  WallTrackerState,
  LiveTicker,
} from '../engine/types'
import type { MLPrediction, MLModelState } from '../engine/ml/types'
import { createModel, trainModel, predictDirection } from '../engine/ml/imbalancePredictor'
import { extractFeatures } from '../engine/ml/featureExtractor'
import { generateTrainingData } from '../engine/ml/trainData'

const PREDICTION_INTERVAL = 5000

export function useMLPredictor(
  history: OrderBookHistory,
  stats: ImbalanceStats | null,
  wallTracker: WallTrackerState,
  ticker: LiveTicker | null,
  enabled = true
) {
  const [model, setModel] = useState<MLModelState>(() => createModel())
  const [prediction, setPrediction] = useState<MLPrediction | null>(null)
  const [isTraining, setIsTraining] = useState(false)
  const trainedRef = useRef(false)
  const lastPredictionRef = useRef(0)

  useEffect(() => {
    if (trainedRef.current || isTraining) return
    setIsTraining(true)
    const timer = window.setTimeout(() => {
      const trainingData = generateTrainingData()
      const trainedModel = trainModel(createModel(), trainingData)
      setModel(trainedModel)
      trainedRef.current = true
      setIsTraining(false)
      console.log('[ML] Model trained:', {
        accuracy: `${trainedModel.accuracy.toFixed(1)}%`,
        examples: trainedModel.trainingSize,
      })
    }, 50)
    return () => window.clearTimeout(timer)
  }, [isTraining])

  useEffect(() => {
    if (!enabled || isTraining || model.trainingSize === 0) return

    const now = Date.now()
    if (now - lastPredictionRef.current < PREDICTION_INTERVAL) return

    const features = extractFeatures(history, stats, wallTracker, ticker)
    if (!features) return

    setPrediction(predictDirection(model, features))
    lastPredictionRef.current = now
  }, [history, stats, wallTracker, ticker, enabled, isTraining, model])

  return { prediction, model, isTraining }
}
