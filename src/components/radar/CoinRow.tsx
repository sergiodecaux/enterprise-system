import { ChevronRight, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CoinSignal } from '../../engine/types'
import { useAppStore } from '../../store/useAppStore'
import WinRateBar from './WinRateBar'
import SentimentBadge from './SentimentBadge'
import { toBaseTicker } from '../../api/mexc'

interface CoinRowProps {
  signal: CoinSignal
  rank: number
  onClick: () => void
}

const CoinRow = ({ signal, rank, onClick }: CoinRowProps) => {
  const { t } = useTranslation()
  const newsSettings = useAppStore((s) => s.newsSettings)
  const coinSentiments = useAppStore((s) => s.newsIntel.coinSentiments)
  const favorites = useAppStore((s) => s.radarFavorites)
  const toggleFav = useAppStore((s) => s.toggleRadarFavorite)
  const isFav = favorites.includes(signal.internalSymbol)
  const ticker = toBaseTicker(signal.internalSymbol)
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
      className="flex min-h-[3.25rem] cursor-pointer items-center gap-2 border-b border-hull-border/50 px-3 py-3 transition-colors duration-200 hover:bg-hull-light/50 sm:px-4"
      onClick={onClick}
    >
      <button
        type="button"
        className={`shrink-0 rounded-md p-1 ${
          isFav ? 'text-amber-300' : 'text-holo/25'
        }`}
        title={isFav ? 'Убрать из избранного' : 'В избранное'}
        onClick={(e) => {
          e.stopPropagation()
          toggleFav(signal.internalSymbol)
        }}
      >
        <Star className="h-4 w-4" fill={isFav ? 'currentColor' : 'none'} />
      </button>

      <div className="w-6 shrink-0 text-right font-mono text-xs text-holo/30">
        {String(rank).padStart(2, '0')}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1">
          <span className="whitespace-nowrap font-mono text-sm font-bold text-holo">
            {ticker}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-holo/35">
            USDT
          </span>
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
        className={`w-[3.6rem] shrink-0 rounded border px-1 py-0.5 text-center font-mono text-[10px] uppercase ${getSignalBadgeClass()}`}
        title={getSignalText()}
      >
        {getSignalText()}
      </div>

      <div className="flex w-[4.5rem] shrink-0 flex-col items-end justify-center gap-0.5">
        <WinRateBar value={signal.probabilityPct} compact label="Score" />
        <span className="font-mono text-[8px] uppercase tracking-wide text-holo/30">
          Score
        </span>
      </div>

      <ChevronRight className="h-4 w-4 shrink-0 text-holo/20" />
    </div>
  )
}

export default CoinRow
