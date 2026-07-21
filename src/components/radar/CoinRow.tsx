import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CoinSignal } from '../../engine/types'
import { useAppStore } from '../../store/useAppStore'
import WinRateBar from './WinRateBar'
import SentimentBadge from './SentimentBadge'

interface CoinRowProps {
  signal: CoinSignal
  rank: number
  onClick: () => void
}

const CoinRow = ({ signal, rank, onClick }: CoinRowProps) => {
  const { t } = useTranslation()
  const newsSettings = useAppStore((s) => s.newsSettings)
  const coinSentiments = useAppStore((s) => s.newsIntel.coinSentiments)
  const liqMap = useAppStore(
    (s) => s.liquidityMaps[signal.internalSymbol] ?? null
  )
  const whaleState = useAppStore(
    (s) => s.whaleWatcher[signal.internalSymbol] ?? null
  )
  const hasWhaleAlert = (whaleState?.alerts ?? []).some(
    (a) => a.isActive && !a.isExpired
  )
  const dna = useAppStore(
    (s) => s.sessionDNA[signal.internalSymbol] ?? null
  )
  const personalityIcon =
    dna?.personality !== 'UNKNOWN' ? dna?.personalityIcon : null
  const baseSym = signal.internalSymbol.split('/')[0]
  const sentiment =
    newsSettings.enabled && newsSettings.showSentimentBadge
      ? coinSentiments[baseSym] ?? null
      : null

  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    }
    if (price >= 1) {
      return price.toLocaleString('ru-RU', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
      })
    }
    return price.toLocaleString('ru-RU', {
      maximumFractionDigits: 6,
      minimumFractionDigits: 2,
    })
  }

  const formatChange = (change: number): string => {
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change.toFixed(2)}%`
  }

  const getSignalBadgeClass = () => {
    if (!signal.direction) {
      return 'border-hull-border bg-hull-light text-holo/40'
    }
    if (signal.direction === 'LONG') {
      return 'border-matrix/30 bg-matrix/10 text-matrix'
    }
    return 'border-alert/30 bg-alert/10 text-alert'
  }

  const getSignalText = (): string => {
    if (!signal.direction) {
      return signal.currentRSI === null ? t('signal_waiting') : '—'
    }
    const prefix = signal.hasActiveSetup ? '⚡' : ''
    return `${prefix}${signal.direction === 'LONG' ? t('signal_long') : t('signal_short')}`
  }

  return (
    <div
      className="flex cursor-pointer items-center gap-2 border-b border-hull-border/50 px-4 py-3 transition-colors duration-200 hover:bg-hull-light/50 sm:gap-3"
      onClick={onClick}
    >
      <div className="w-6 shrink-0 text-right font-mono text-xs text-holo/30">
        {String(rank).padStart(2, '0')}
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="truncate font-mono text-sm font-bold text-holo">
            {signal.displayName}
          </div>
          <SentimentBadge sentiment={sentiment} />
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-holo/60">${formatPrice(signal.price)}</span>
          <span
            className={signal.priceChange24h >= 0 ? 'text-matrix' : 'text-alert'}
          >
            {formatChange(signal.priceChange24h)}
          </span>
        </div>
      </div>

      <div
        className={`max-w-[4.5rem] shrink-0 truncate rounded border px-1.5 py-0.5 text-center font-mono text-[10px] uppercase sm:max-w-none sm:px-2 sm:text-xs ${getSignalBadgeClass()}`}
        title={getSignalText()}
      >
        {getSignalText()}
      </div>

      <div className="flex items-center gap-1">
        <WinRateBar value={signal.probabilityPct} />
        {liqMap && liqMap.liquidityBoost > 0.5 && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-yellow-400"
            title={`Магнит ликвидности: +${liqMap.liquidityBoost.toFixed(1)}`}
          >
            🧲
          </span>
        )}
        {signal.btcDivergence?.type === 'BULL_DIV' && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-matrix"
            title={signal.btcDivergence.label}
          >
            ⚡
          </span>
        )}
        {signal.btcDivergence?.type === 'BEAR_DIV' && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-alert"
            title={signal.btcDivergence.label}
          >
            🔻
          </span>
        )}
        {hasWhaleAlert && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px] font-bold text-cyan-400"
            title={`Кит: ${
              whaleState?.strongestSupport
                ? `Поддержка $${(whaleState.strongestSupport.volumeUsd / 1e6).toFixed(1)}M`
                : whaleState?.strongestResistance
                  ? `Сопротивление $${(whaleState.strongestResistance.volumeUsd / 1e6).toFixed(1)}M`
                  : 'Активен'
            }`}
          >
            🐋
          </span>
        )}
        {personalityIcon && dna && (
          <span
            className="inline-flex items-center rounded px-1 font-mono text-[9px]"
            title={`ДНК сессии: ${dna.personalityLabel} — ${dna.keyInsight}`}
          >
            {personalityIcon}
          </span>
        )}
      </div>

      <div className="flex-shrink-0">
        <ChevronRight className="h-4 w-4 text-holo/20" />
      </div>
    </div>
  )
}

export default CoinRow
