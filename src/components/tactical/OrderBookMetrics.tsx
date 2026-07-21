import { useTranslation } from 'react-i18next'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { OrderBookMetrics as Metrics } from '../../engine/types'

interface Props {
  metrics: Metrics
}

const OrderBookMetricsView = ({ metrics }: Props) => {
  const { t } = useTranslation()

  const imbalanceColor =
    metrics.imbalance > 20
      ? 'text-matrix'
      : metrics.imbalance < -20
        ? 'text-alert'
        : 'text-holo/60'

  const PressureIcon =
    metrics.pressure === 'BUYERS'
      ? TrendingUp
      : metrics.pressure === 'SELLERS'
        ? TrendingDown
        : Minus

  const pressureKey =
    metrics.pressure === 'BUYERS'
      ? 'orderbook_pressure_buyers'
      : metrics.pressure === 'SELLERS'
        ? 'orderbook_pressure_sellers'
        : 'orderbook_pressure_neutral'

  const pressureColor =
    metrics.pressure === 'BUYERS'
      ? 'text-matrix'
      : metrics.pressure === 'SELLERS'
        ? 'text-alert'
        : 'text-holo/60'

  const sellersWidth = Math.abs(Math.min(0, metrics.imbalance))
  const buyersWidth = Math.max(0, metrics.imbalance)

  const formatVol = (vol: number): string => {
    if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`
    if (vol >= 1_000) return `${(vol / 1_000).toFixed(0)}K`
    return vol.toFixed(0)
  }

  return (
    <div className="bg-hull-light/30 rounded-lg p-3 space-y-2">
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-holo/60">{t('orderbook_imbalance')}</span>
          <span className={`font-mono font-bold ${imbalanceColor}`}>
            {metrics.imbalance > 0 ? '+' : ''}
            {metrics.imbalance.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 bg-hull rounded-full overflow-hidden flex">
          <div className="bg-alert/80" style={{ width: `${sellersWidth}%` }} />
          <div className="flex-1 bg-hull-light/40" />
          <div className="bg-matrix/80" style={{ width: `${buyersWidth}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-hull/50 rounded px-2 py-1">
          <div className="text-holo/50 text-[10px] uppercase">{t('orderbook_volume')}</div>
          <div className="font-mono">
            <span className="text-matrix">{formatVol(metrics.bidVolume)}</span>
            {' / '}
            <span className="text-alert">{formatVol(metrics.askVolume)}</span>
          </div>
        </div>

        <div className="bg-hull/50 rounded px-2 py-1">
          <div className="text-holo/50 text-[10px] uppercase">{t('orderbook_orders')}</div>
          <div className="font-mono text-holo/80">
            {metrics.bidOrders} / {metrics.askOrders}
          </div>
        </div>

        {metrics.spreadPercent !== null && (
          <div className="bg-hull/50 rounded px-2 py-1">
            <div className="text-holo/50 text-[10px] uppercase">{t('orderbook_spread')}</div>
            <div className="font-mono text-holo/80">
              {metrics.spreadPercent.toFixed(3)}%
            </div>
          </div>
        )}

        <div className="bg-hull/50 rounded px-2 py-1 flex items-center">
          <div className="flex items-center gap-1">
            <PressureIcon className={`w-3 h-3 ${pressureColor}`} />
            <span className={`text-[10px] uppercase ${pressureColor}`}>
              {t(pressureKey)}
            </span>
          </div>
        </div>
      </div>

      {metrics.walls.length > 0 && (
        <div className="pt-2 border-t border-hull-border/30">
          <div className="text-[10px] text-holo/50 uppercase mb-1">
            {t('orderbook_walls')}
          </div>
          {metrics.walls.slice(0, 3).map((wall, i) => (
            <div
              key={`${wall.side}-${wall.price}-${i}`}
              className={`text-[10px] font-mono ${
                wall.side === 'BID' ? 'text-matrix' : 'text-alert'
              }`}
            >
              {wall.side === 'BID' ? t('orderbook_wall_bid') : t('orderbook_wall_ask')} $
              {wall.price.toLocaleString('ru-RU')} — {formatVol(wall.volume)} (
              {wall.ratio.toFixed(1)}×)
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default OrderBookMetricsView
