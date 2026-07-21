import { TrendingUp, TrendingDown, Minus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MultiTFAlignment, TFSnapshot } from '../../engine/prediction/types'

interface Props {
  alignment: MultiTFAlignment | null
  isLoading: boolean
}

const TFRow = ({ snap }: { snap: TFSnapshot }) => {
  const tfLabel: Record<string, string> = { '1d': '1D', '4h': '4H', '1h': '1H' }

  const DirIcon =
    snap.direction === 'BULLISH'
      ? TrendingUp
      : snap.direction === 'BEARISH'
        ? TrendingDown
        : Minus

  const biasColor =
    snap.bias === 'LONG'
      ? 'text-matrix'
      : snap.bias === 'SHORT'
        ? 'text-alert'
        : 'text-holo/60'

  const candleColor =
    snap.direction === 'BULLISH'
      ? 'bg-matrix'
      : snap.direction === 'BEARISH'
        ? 'bg-alert'
        : 'bg-holo/30'

  const posLabel: Record<string, string> = {
    UPPER: '↑ Верх',
    MIDDLE: '— Середина',
    LOWER: '↓ Низ',
  }

  return (
    <div className="flex items-center gap-3 border-b border-hull-border/30 py-2 last:border-0">
      <div className="w-8 flex-shrink-0">
        <span className="font-mono text-xs font-bold text-holo/80">
          {tfLabel[snap.timeframe]}
        </span>
      </div>

      <div className="flex flex-shrink-0 flex-col items-center gap-0.5">
        <div className="h-1 w-1 rounded-full bg-holo/30" />
        <div className={`h-4 w-3 rounded-sm opacity-80 ${candleColor}`} />
        <div className="h-1 w-1 rounded-full bg-holo/30" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2">
          <DirIcon className={`h-3 w-3 ${biasColor}`} />
          <span className={`font-mono text-xs font-bold ${biasColor}`}>{snap.bias}</span>
          <span className="text-[10px] text-holo/40">{posLabel[snap.closePosition]}</span>
        </div>
        <div className="truncate text-[10px] text-holo/50">{snap.biasReason}</div>
      </div>

      <div className="flex-shrink-0 text-right">
        <div className="text-[10px] text-holo/50">RSI</div>
        <div
          className={`font-mono text-xs font-bold ${
            snap.rsi > 65 ? 'text-alert' : snap.rsi < 35 ? 'text-matrix' : 'text-holo/80'
          }`}
        >
          {snap.rsi.toFixed(0)}
        </div>
      </div>
    </div>
  )
}

const StrengthBadge = ({ alignment }: { alignment: MultiTFAlignment }) => {
  const config: Record<string, { label: string; cls: string }> = {
    STRONG_LONG: {
      label: '⬆ СИЛЬНЫЙ ЛОНГ',
      cls: 'bg-matrix/30 text-matrix border-matrix/50',
    },
    LONG: {
      label: '↑ ЛОНГ',
      cls: 'bg-matrix/20 text-matrix/80 border-matrix/30',
    },
    NEUTRAL: {
      label: '— НЕЙТРАЛЬНО',
      cls: 'bg-holo/10 text-holo/60 border-holo/20',
    },
    SHORT: {
      label: '↓ ШОРТ',
      cls: 'bg-alert/20 text-alert/80 border-alert/30',
    },
    STRONG_SHORT: {
      label: '⬇ СИЛЬНЫЙ ШОРТ',
      cls: 'bg-alert/30 text-alert border-alert/50',
    },
  }

  const { label, cls } = config[alignment.strength] ?? config.NEUTRAL

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs font-bold ${cls}`}
    >
      {label}
      <span className="opacity-60">
        MTF {alignment.score > 0 ? '+' : ''}
        {alignment.score}/6
      </span>
    </div>
  )
}

const MultiTFPanel = ({ alignment, isLoading }: Props) => {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-hull-light/20 p-4">
        <RefreshCw className="h-4 w-4 animate-spin text-holo/60" />
        <span className="text-xs text-holo/60">{t('mtf_loading')}</span>
      </div>
    )
  }

  if (!alignment) {
    return (
      <div className="rounded-lg bg-hull-light/20 p-4 text-center">
        <span className="text-xs text-holo/40">{t('mtf_no_data')}</span>
      </div>
    )
  }

  const { primaryLiqTarget, secondaryLiqTarget } = alignment

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-mono text-xs font-bold uppercase text-holo/80">
          {t('mtf_analysis')}
        </h4>
        <StrengthBadge alignment={alignment} />
      </div>

      <div className="rounded-lg bg-hull-light/20 px-3">
        <TFRow snap={alignment.daily} />
        <TFRow snap={alignment.h4} />
        <TFRow snap={alignment.h1} />
      </div>

      {alignment.agreement && (
        <div className="flex items-center gap-2 text-xs">
          <div className="h-2 w-2 animate-pulse rounded-full bg-matrix" />
          <span className="font-mono text-matrix/80">{t('mtf_agreement')}</span>
        </div>
      )}

      <div className="space-y-2 rounded-lg bg-hull-light/20 p-3">
        <div className="font-mono text-[10px] uppercase text-holo/50">
          {t('mtf_liq_targets')}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-2 w-2 flex-shrink-0 rounded-full bg-holo" />
              <span className="truncate font-mono text-xs text-holo/80">
                {t('mtf_liq_primary')}: {primaryLiqTarget.label}
              </span>
            </div>
            <span
              className={`flex-shrink-0 font-mono text-xs font-bold ${
                primaryLiqTarget.direction === 'UP' ? 'text-matrix' : 'text-alert'
              }`}
            >
              {primaryLiqTarget.direction === 'UP' ? '+' : '-'}
              {Math.abs(primaryLiqTarget.distancePercent).toFixed(2)}%
            </span>
          </div>

          {secondaryLiqTarget && (
            <div className="flex items-center justify-between gap-2 opacity-70">
              <div className="flex min-w-0 items-center gap-2">
                <div className="h-2 w-2 flex-shrink-0 rounded-full bg-holo/50" />
                <span className="truncate font-mono text-xs text-holo/60">
                  {t('mtf_liq_secondary')}: {secondaryLiqTarget.label}
                </span>
              </div>
              <span
                className={`flex-shrink-0 font-mono text-xs ${
                  secondaryLiqTarget.direction === 'UP' ? 'text-matrix/70' : 'text-alert/70'
                }`}
              >
                {secondaryLiqTarget.direction === 'UP' ? '+' : '-'}
                {Math.abs(secondaryLiqTarget.distancePercent).toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default MultiTFPanel
