import { Radar, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import CoinRow from './CoinRow'
import CoinSearch from './CoinSearch'
import FearGreedGauge from '../news/FearGreedGauge'

const RadarView = () => {
  const { t } = useTranslation()
  const signals = useAppStore((state) => state.signals)
  const connectionStatus = useAppStore((state) => state.connectionStatus)
  const isScanning = useAppStore((state) => state.isScanning)
  const marketContext = useAppStore((state) => state.marketContext)
  const extraWatchlist = useAppStore((state) => state.extraWatchlist)
  const newsSettings = useAppStore((state) => state.newsSettings)
  const fearGreed = useAppStore((state) => state.newsIntel.fearGreed)
  const selectCoin = useAppStore((state) => state.selectCoin)
  const setDrawerOpen = useAppStore((state) => state.setDrawerOpen)

  const handleCoinClick = (symbol: string) => {
    selectCoin(symbol)
    setDrawerOpen(true)
  }

  const getRelativeTime = (): string => {
    if (!marketContext?.lastScanAt) return ''
    try {
      const diffMs = Date.now() - marketContext.lastScanAt
      const diffMins = Math.floor(diffMs / (1000 * 60))
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
      if (diffHours > 0) return `${diffHours} ${t('time_ago_hours')}`
      if (diffMins > 0) return `${diffMins} ${t('time_ago_minutes')}`
      return `0 ${t('time_ago_minutes')}`
    } catch {
      return ''
    }
  }

  const translateBias = (bias: string) => {
    if (bias === 'BULLISH') return t('bias_bullish')
    if (bias === 'BEARISH') return t('bias_bearish')
    return t('bias_neutral')
  }

  const translateTrend = (trend: string) => {
    if (trend === 'BULLISH') return t('trend_bullish')
    if (trend === 'BEARISH') return t('trend_bearish')
    return t('trend_ranging')
  }

  const SkeletonRow = () => (
    <div className="flex items-center gap-3 border-b border-hull-border/50 px-4 py-3">
      <div className="h-4 w-6 animate-pulse rounded bg-hull-light" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-hull-light" />
        <div className="h-3 w-16 animate-pulse rounded bg-hull-light" />
      </div>
      <div className="h-6 w-16 animate-pulse rounded bg-hull-light" />
      <div className="h-2 w-20 animate-pulse rounded bg-hull-light" />
      <div className="h-4 w-4 animate-pulse rounded bg-hull-light" />
    </div>
  )

  const biasLabel = marketContext
    ? `${translateBias(marketContext.dailyBias)} ${marketContext.dailyConfidence}% · ${translateTrend(marketContext.btcTrend)}`
    : ''

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-4 pt-6">
        <div className="mb-1 flex items-center gap-2">
          <Radar className="h-5 w-5 text-matrix" />
          <h1 className="font-mono text-lg font-bold uppercase tracking-wide text-holo">
            {t('radar_title')}
          </h1>
          {isScanning && (
            <div className="pulse-dot h-2 w-2 rounded-full bg-matrix" />
          )}
        </div>
        <p className="ml-7 font-mono text-xs text-holo/40">{t('radar_subtitle')}</p>
        {biasLabel && (
          <p className="ml-7 mt-1 font-mono text-xs text-matrix/70">{biasLabel}</p>
        )}
        {marketContext?.scanProgress && (
          <p className="ml-7 mt-0.5 font-mono text-xs text-holo/30">
            {marketContext.scanProgress}
          </p>
        )}
        {newsSettings.enabled &&
          newsSettings.showFearGreed && (
            <div className="ml-7 mt-3 min-h-[4.5rem]">
              {fearGreed && <FearGreedGauge data={fearGreed} />}
            </div>
          )}
      </div>

      <CoinSearch />

      <div className="border-b border-hull-border/30 px-4 py-2">
        <div className="flex items-center gap-3 font-mono text-xs uppercase text-holo/30">
          <div className="w-6 text-right">#</div>
          <div className="flex-1">{t('column_asset')}</div>
          <div className="w-[4.5rem] shrink-0">{t('column_signal')}</div>
          <div className="w-[5.75rem] shrink-0 text-right">
            {t('column_probability')}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isScanning && signals.length === 0 ? (
          <div>
            {[1, 2, 3, 4].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : connectionStatus === 'OFFLINE' && signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <p className="mb-2 font-mono text-sm uppercase tracking-wider text-alert">
              {t('status_offline')}
            </p>
            <p className="max-w-xs text-center font-mono text-xs text-holo/60">
              {t('connection_unavailable')}
            </p>
          </div>
        ) : signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <div className="relative">
              <Radio className="mb-4 h-12 w-12 animate-pulse text-matrix/30" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-12 w-12 animate-ping rounded-full border-2 border-matrix/30" />
              </div>
            </div>
            <p className="font-mono text-sm uppercase tracking-wider text-holo/40">
              {t('status_scanning')}
            </p>
          </div>
        ) : (
          <div>
            {signals.map((signal, index) => (
              <CoinRow
                key={signal.symbol}
                signal={signal}
                rank={index + 1}
                onClick={() => handleCoinClick(signal.symbol)}
              />
            ))}
          </div>
        )}
      </div>

      {marketContext?.lastScanAt && (
        <div className="border-t border-hull-border/30 px-4 py-4 text-center">
          <p className="font-mono text-xs text-holo/20">
            {t('footer_data_age')} {getRelativeTime()}
          </p>
          <p className="mt-1 font-mono text-xs text-holo/20">
            {(marketContext.watchlistSize || 10) +
              (extraWatchlist.length ? ` (+${extraWatchlist.length})` : '')}{' '}
            {t('footer_pairs')}
          </p>
        </div>
      )}
    </div>
  )
}

export default RadarView
