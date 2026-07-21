import { useState } from 'react'
import { X } from 'lucide-react'
import type { WhaleAlert } from '../../engine/types'
import { formatWhaleVolume } from '../../engine/orderbook/whaleDetector'

interface Props {
  alert: WhaleAlert
  onDismiss?: () => void
}

const WhaleAlertBanner = ({ alert, onDismiss }: Props) => {
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  const isSupport =
    alert.type === 'SUPPORT' ||
    (alert.type === 'IMMEDIATE' && alert.order.side === 'BID')
  const isImmediate = alert.type === 'IMMEDIATE'

  const borderColor = isSupport ? 'border-matrix/40' : 'border-alert/40'
  const bgColor = isSupport ? 'bg-matrix/8' : 'bg-alert/8'
  const accentColor = isSupport ? 'text-matrix' : 'text-alert'
  const dotColor = isSupport ? 'bg-matrix' : 'bg-alert'

  const formatPrice = (price: number): string => {
    if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (price >= 1) return price.toFixed(4)
    return price.toFixed(6)
  }

  const handleDismiss = () => {
    setDismissed(true)
    onDismiss?.()
  }

  return (
    <div
      className={`relative flex items-start gap-3 rounded-xl border ${borderColor} ${bgColor} p-3`}
    >
      {/* Пульсирующий индикатор */}
      <div className="relative mt-0.5 flex-shrink-0">
        <div
          className={`h-2.5 w-2.5 rounded-full ${dotColor} ${
            isImmediate ? 'animate-pulse' : ''
          }`}
        />
        {isImmediate && (
          <div
            className={`absolute inset-0 h-2.5 w-2.5 animate-ping rounded-full ${dotColor} opacity-40`}
          />
        )}
      </div>

      {/* Контент */}
      <div className="min-w-0 flex-1">
        {/* Заголовок */}
        <div className="mb-1 flex items-center gap-2">
          <span className={`font-mono text-xs font-bold uppercase ${accentColor}`}>
            🐋 {isSupport ? 'Поддержка китов' : 'Сопротивление китов'}
          </span>
          {isImmediate && (
            <span
              className={`rounded px-1 py-0.5 font-mono text-[9px] font-bold uppercase ${accentColor} border ${borderColor}`}
            >
              СРОЧНО
            </span>
          )}
        </div>

        {/* Основная информация */}
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-holo">
            @ {formatPrice(alert.order.price)}
          </span>
          <span className={`font-mono text-xs font-bold ${accentColor}`}>
            {formatWhaleVolume(alert.order.volumeUsd)}
          </span>
        </div>

        {/* Детали */}
        <div className="mt-1 flex items-center gap-3">
          <span className="font-mono text-[10px] text-holo/40">
            {alert.order.distancePct.toFixed(2)}% от цены
          </span>
          <span className="font-mono text-[10px] text-holo/30">
            {alert.order.volume.toLocaleString('en-US', {
              maximumFractionDigits: 2,
            })}{' '}
            монет
          </span>
        </div>

        {/* Полное сообщение */}
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-holo/50">
          {alert.message}
        </p>
      </div>

      {/* Кнопка закрыть */}
      <button
        type="button"
        onClick={handleDismiss}
        className="flex-shrink-0 rounded p-0.5 text-holo/30 transition-colors hover:text-holo/60"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export default WhaleAlertBanner
