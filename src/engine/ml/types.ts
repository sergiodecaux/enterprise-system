export interface MLFeatures {
  currentImbalance: number
  avgImbalance5min: number
  imbalanceTrend: number
  imbalanceVolatility: number
  bidVolumeRatio: number
  askVolumeRatio: number
  volumeChange: number
  activeBidWalls: number
  activeAskWalls: number
  wallEatenRecently: number
  wallEatenSide: 'BID' | 'ASK' | null
  spreadPercent: number
  spreadTrend: number
  priceChange1min: number
  priceVolatility: number
}

export interface MLPrediction {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  confidence: number
  timeframe: '1min' | '5min' | '15min'
  reasoning: string[]
  timestamp: number
}

export interface MLModelState {
  weights: number[]
  bias: number
  accuracy: number
  trainingSize: number
  lastTrained: number
}

export interface TrainingExample {
  features: MLFeatures
  label: number
  actualOutcome?: number
}
