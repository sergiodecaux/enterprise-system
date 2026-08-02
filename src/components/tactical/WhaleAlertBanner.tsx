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
      className={`relative flex items-center gap-2 rounded-md border ${borderColor} ${bgColor} px-2 py-1`}
    >
      <div className="relative flex-shrink-0">
        <div
          className={`h-1.5 w-1.5 rounded-full ${dotColor} ${
            isImmediate ? 'animate-pulse' : ''
          }`}
        />
      </div>

      <div className="min-w-0 flex-1 truncate font-mono text-[10px]">
        <span className={`font-bold uppercase ${accentColor}`}>
          {isSupport ? 'ОПОРА ↓' : 'КРЫША ↑'}
          {isImmediate ? ' · близко' : ''}
        </span>
        <span className="mx-1.5 font-bold text-holo">
          {formatPrice(alert.order.price)}
        </span>
        <span className={`font-bold ${accentColor}`}>
          {formatWhaleVolume(alert.order.volumeUsd)}
        </span>
        <span className="ml-1.5 text-holo/35">
          {alert.order.distancePct.toFixed(2)}%
        </span>
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        className="flex-shrink-0 rounded p-0.5 text-holo/30 transition-colors hover:text-holo/60"
        aria-label="Скрыть"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export default WhaleAlertBanner
