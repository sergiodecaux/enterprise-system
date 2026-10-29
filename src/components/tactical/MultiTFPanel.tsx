import {
  Minus,
  TrendingDown,
  TrendingUp,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MultiTFAlignment, TFSnapshot } from '../../engine/prediction/types'

interface Props {
  alignment: MultiTFAlignment | null
  isLoading: boolean
}

const TFRow = ({ snap }: { snap: TFSnapshot }) => {
  const tfLabel: Record<string, string> = { '1d': '1D', '4h': '4H', '1h': '1H' }

  const DirIcon: LucideIcon =
    snap.direction === 'BULLISH'
      ? TrendingUp
      : snap.direction === 'BEARISH'
        ? TrendingDown
        : Minus

  const biasColor =
    snap.bias === 'LONG'
      ? 'text-market-long'
      : snap.bias === 'SHORT'
        ? 'text-market-short'
        : 'text-text-muted'

  const candleColor =
    snap.direction === 'BULLISH'
      ? 'bg-market-long'
      : snap.direction === 'BEARISH'
        ? 'bg-market-short'
        : 'bg-text-muted/40'

  const PosIcon =
    snap.closePosition === 'UPPER'
      ? ArrowUp
      : snap.closePosition === 'LOWER'
        ? ArrowDown
        : Minus

  const posLabel: Record<string, string> = {
    UPPER: 'Верх',
    MIDDLE: 'Середина',
    LOWER: 'Низ',
  }

  return (
    <div className="flex items-center gap-2.5 border-b border-border-subtle py-2 last:border-0">
      <div className="w-7 flex-shrink-0">
        <span className="font-mono text-[11px] font-medium text-text-secondary">
          {tfLabel[snap.timeframe]}
        </span>
      </div>

      <div className="flex flex-shrink-0 flex-col items-center gap-0.5">
        <div className="h-1 w-1 rounded-full bg-text-muted/40" />
        <div className={`h-4 w-3 rounded-sm opacity-80 ${candleColor}`} />
        <div className="h-1 w-1 rounded-full bg-text-muted/40" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <DirIcon className={`h-3 w-3 ${biasColor}`} />
          <span className={`font-mono text-[11px] font-medium ${biasColor}`}>
            {snap.bias}
          </span>
          <span className="flex items-center gap-0.5 font-sans text-[11px] leading-4 text-text-muted">
            <PosIcon className="h-2.5 w-2.5" />
            {posLabel[snap.closePosition]}
          </span>
        </div>
        <div className="truncate font-sans text-[11px] leading-4 text-text-muted">
          {snap.biasReason}
        </div>
      </div>

      <div className="flex-shrink-0 text-right">
        <div className="font-sans text-[11px] leading-4 text-text-muted">RSI</div>
        <div
          className={`tnum font-mono text-[11px] font-medium ${
            snap.rsi > 65
              ? 'text-market-short'
              : snap.rsi < 35
                ? 'text-market-long'
                : 'text-text-secondary'
          }`}
        >
          {snap.rsi.toFixed(0)}
        </div>
      </div>
    </div>
  )
}

const StrengthBadge = ({ alignment }: { alignment: MultiTFAlignment }) => {
  const config: Record<
    string,
    { label: string; cls: string; icon: LucideIcon | null }
  > = {
    STRONG_LONG: {
      label: 'Сильный лонг',
      cls: 'bg-market-long/15 text-market-long border-market-long/30',
      icon: TrendingUp,
    },
    LONG: {
      label: 'Лонг',
      cls: 'bg-market-long/10 text-market-long/80 border-market-long/20',
      icon: TrendingUp,
    },
    NEUTRAL: {
      label: 'Нейтрально',
      cls: 'bg-bg-elevated text-text-muted border-border',
      icon: Minus,
    },
    SHORT: {
      label: 'Шорт',
      cls: 'bg-market-short/10 text-market-short/80 border-market-short/20',
      icon: TrendingDown,
    },
    STRONG_SHORT: {
      label: 'Сильный шорт',
      cls: 'bg-market-short/15 text-market-short border-market-short/30',
      icon: TrendingDown,
    },
  }

  const { label, cls, icon: Icon } = config[alignment.strength] ?? config.NEUTRAL

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-sans text-[11px] font-medium leading-4 ${cls}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {label}
      <span className="tnum ml-0.5 font-mono opacity-60">
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
      <div className="flex items-center gap-2 rounded-md border border-border bg-bg-panel p-3">
        <RefreshCw className="h-3.5 w-3.5 animate-spin text-text-muted" />
        <span className="font-sans text-[11px] leading-4 text-text-muted">
          {t('mtf_loading')}
        </span>
      </div>
    )
  }

  if (!alignment) {
    return (
      <div className="rounded-md border border-border bg-bg-panel p-3 text-center">
        <span className="font-sans text-[11px] leading-4 text-text-muted">
          {t('mtf_no_data')}
        </span>
      </div>
    )
  }

  const { primaryLiqTarget, secondaryLiqTarget } = alignment

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-sans text-[13px] font-medium leading-5 text-text-primary">
          {t('mtf_analysis')}
        </h4>
        <StrengthBadge alignment={alignment} />
      </div>

      <div className="rounded-md border border-border bg-bg-panel/60 px-2.5">
        <TFRow snap={alignment.h1} />
        <TFRow snap={alignment.h4} />
        <TFRow snap={alignment.daily} />
      </div>

      {alignment.agreement && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-market-long" />
          <span className="font-sans text-[11px] leading-4 text-market-long/80">
            {t('mtf_agreement')}
          </span>
        </div>
      )}

      <div className="space-y-1.5 rounded-md border border-border bg-bg-panel/60 p-2.5">
        <div className="font-sans text-[11px] leading-4 text-text-muted">
          {t('mtf_liq_targets')}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-secondary" />
              <span className="truncate font-sans text-[11px] leading-4 text-text-secondary">
                {t('mtf_liq_primary')}: {primaryLiqTarget.label}
              </span>
            </div>
            <span
              className={`tnum flex-shrink-0 font-mono text-[11px] font-medium leading-4 ${
                primaryLiqTarget.direction === 'UP'
                  ? 'text-market-long'
                  : 'text-market-short'
              }`}
            >
              {primaryLiqTarget.direction === 'UP' ? '+' : '-'}
              {Math.abs(primaryLiqTarget.distancePercent).toFixed(2)}%
            </span>
          </div>

          {secondaryLiqTarget && (
            <div className="flex items-center justify-between gap-2 opacity-70">
              <div className="flex min-w-0 items-center gap-2">
                <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-text-muted/50" />
                <span className="truncate font-sans text-[11px] leading-4 text-text-muted">
                  {t('mtf_liq_secondary')}: {secondaryLiqTarget.label}
                </span>
              </div>
              <span
                className={`tnum flex-shrink-0 font-mono text-[11px] leading-4 ${
                  secondaryLiqTarget.direction === 'UP'
                    ? 'text-market-long/70'
                    : 'text-market-short/70'
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
