import { useState } from 'react'
import { Radar, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import SegmentedControl from '../ui/SegmentedControl'
import { useAppStore } from '../../store/useAppStore'
import CoinRow from './CoinRow'
import FearGreedGauge from '../news/FearGreedGauge'
import Radar141Board from './Radar141Board'
import DualHuntBoard from './DualHuntBoard'

type RadarMode = 'setups' | 'scan' | '141' | 'map' | 'watch' | 'fav'

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
  const [mode, setMode] = useState<RadarMode>('scan')

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
    ? `день ${translateBias(marketContext.dailyBias)} · BTC ${translateTrend(marketContext.btcTrend)}`
    : ''

  return (
    <div className="flex h-full flex-col bg-bg-base">
      <div className="px-3 pb-2.5 pt-3">
        <div className="mb-1 flex items-center gap-2">
          <Radar className="h-4 w-4 text-brand" />
          <h1 className="font-sans text-[15px] font-semibold leading-5 text-text-primary">
            {t('radar_title')}
          </h1>
          {isScanning && (
            <div className="pulse-dot h-1.5 w-1.5 rounded-full bg-brand" />
          )}
          <span className="ml-auto font-mono text-[11px] leading-4 text-text-muted">
            {signals.length} пар
          </span>
        </div>
        <p className="font-sans text-[11px] leading-4 text-text-muted">
          {t('radar_subtitle')}
        </p>
        {biasLabel && (
          <p className="mt-0.5 font-mono text-[11px] leading-4 text-text-secondary">
            {biasLabel}
          </p>
        )}
        {marketContext?.scanProgress && (
          <p className="mt-0.5 font-sans text-[11px] leading-4 text-text-muted">
            {marketContext.scanProgress}
          </p>
        )}
        {newsSettings.enabled && newsSettings.showFearGreed && (
          <div className="mt-2.5 min-h-[4.5rem]">
            {fearGreed && <FearGreedGauge data={fearGreed} />}
          </div>
        )}
      </div>

      <div className="px-3 pb-2.5">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: 'scan', label: 'Охота' },
            { value: '141', label: '141' },
            { value: 'map', label: 'Карта' },
            { value: 'fav', label: 'Избранное' },
            { value: 'watch', label: 'Watch' },
            { value: 'setups', label: 'Сетапы' },
          ]}
          size="sm"
          ariaLabel="Режим радара"
          className="w-full"
          stretch
        />
      </div>

      {mode === 'scan' ? (
        <DualHuntBoard />
      ) : mode !== 'setups' ? (
        <Radar141Board
          mode={
            mode === 'map'
              ? 'map'
              : mode === 'watch'
                ? 'watch'
                : mode === 'fav'
                  ? 'fav'
                  : 'scan'
          }
        />
      ) : (
        <>
      <div className="border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-3 font-sans text-[11px] leading-4 text-text-muted">
          <div className="w-6 text-right">#</div>
          <div className="flex-1">{t('column_asset')}</div>
          <div className="w-[4.5rem] shrink-0">{t('column_signal')}</div>
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
            <p className="mb-1 font-sans text-[13px] font-medium text-market-short">
              {t('status_offline')}
            </p>
            <p className="max-w-xs text-center font-sans text-[11px] leading-4 text-text-muted">
              {t('connection_unavailable')}
            </p>
          </div>
        ) : signals.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <div className="relative">
              <Radio className="mb-4 h-10 w-10 animate-pulse text-text-muted/40" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-10 w-10 animate-ping rounded-full border border-brand/20" />
              </div>
            </div>
            <p className="font-sans text-[13px] text-text-secondary">
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
        <div className="border-t border-border px-3 py-3 text-center">
          <p className="font-sans text-[11px] leading-4 text-text-muted">
            {t('footer_data_age')} {getRelativeTime()}
          </p>
          <p className="mt-0.5 font-sans text-[11px] leading-4 text-text-muted">
            {(marketContext.watchlistSize || 10) +
              (extraWatchlist.length ? ` (+${extraWatchlist.length})` : '')}{' '}
            {t('footer_pairs')}
          </p>
        </div>
      )}
        </>
      )}
    </div>
  )
}

export default RadarView
