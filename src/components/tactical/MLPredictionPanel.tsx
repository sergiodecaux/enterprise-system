import { Brain, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MLPrediction, MLModelState } from '../../engine/ml/types'
import PredictionGauge from './PredictionGauge'

interface Props {
  prediction: MLPrediction | null
  model: MLModelState
  isTraining: boolean
}

const MLPredictionPanel = ({ prediction, model, isTraining }: Props) => {
  const { t } = useTranslation()

  if (isTraining) {
    return (
      <div className="rounded-lg bg-hull-light/20 p-4">
        <div className="flex items-center gap-2 text-holo/60">
          <Brain className="h-4 w-4 animate-pulse" />
          <span className="text-xs">{t('ml_training')}</span>
        </div>
      </div>
    )
  }

  if (!prediction) {
    return (
      <div className="rounded-lg bg-hull-light/20 p-4 text-center">
        <span className="text-xs text-holo/50">{t('ml_accumulating')}</span>
      </div>
    )
  }

  const DirectionIcon =
    prediction.direction === 'LONG'
      ? TrendingUp
      : prediction.direction === 'SHORT'
        ? TrendingDown
        : Minus

  const directionColor =
    prediction.direction === 'LONG'
      ? 'text-matrix'
      : prediction.direction === 'SHORT'
        ? 'text-alert'
        : 'text-holo/60'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-holo" />
          <h4 className="font-mono text-xs font-bold uppercase text-holo">
            {t('ml_prediction')}
          </h4>
        </div>
        <div className="text-[10px] text-holo/50">
          {t('ml_accuracy')}: {model.accuracy.toFixed(1)}%
        </div>
      </div>

      <PredictionGauge direction={prediction.direction} confidence={prediction.confidence} />

      <div className="rounded-lg bg-hull-light/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className={`flex items-center gap-2 ${directionColor}`}>
            <DirectionIcon className="h-5 w-5" />
            <span className="font-mono text-lg font-bold">{prediction.direction}</span>
          </div>
          <div className="text-xs text-holo/60">{prediction.timeframe}</div>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] uppercase text-holo/50">{t('ml_reasoning')}:</div>
          {prediction.reasoning.map((reason) => (
            <div key={reason} className="font-mono text-xs text-holo/70">
              • {reason}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-hull/50 px-2 py-1">
          <div className="text-[10px] text-holo/50">{t('ml_trained_on')}</div>
          <div className="font-mono text-holo/80">
            {model.trainingSize} {t('ml_examples')}
          </div>
        </div>
        <div className="rounded bg-hull/50 px-2 py-1">
          <div className="text-[10px] text-holo/50">{t('ml_confidence')}</div>
          <div className="font-mono text-holo/80">{prediction.confidence.toFixed(1)}%</div>
        </div>
      </div>
    </div>
  )
}

export default MLPredictionPanel
