import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, TrendingUp, TrendingDown, X } from 'lucide-react'
import type { WallEvent } from '../../engine/types'

interface Props {
  event: WallEvent
  onDismiss: () => void
}

const WallAlert = ({ event, onDismiss }: Props) => {
  const { t } = useTranslation()
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false)
      setTimeout(onDismiss, 300)
    }, 8000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const handleDismiss = () => {
    setIsVisible(false)
    setTimeout(onDismiss, 300)
  }

  const { type, wall, reduction } = event

  const formatVol = (vol: number): string => {
    if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`
    if (vol >= 1_000) return `${(vol / 1_000).toFixed(0)}K`
    return vol.toFixed(0)
  }

  let bgColor = 'bg-hull-light'
  let icon = <AlertTriangle className="w-5 h-5 text-holo" />
  let title = ''
  let message = ''

  if (type === 'EATEN') {
    bgColor = wall.side === 'BID' ? 'bg-alert/20' : 'bg-matrix/20'
    icon =
      wall.side === 'BID' ? (
        <TrendingDown className="w-5 h-5 text-alert" />
      ) : (
        <TrendingUp className="w-5 h-5 text-matrix" />
      )
    title =
      wall.side === 'BID' ? t('wall_eaten_bid') : t('wall_eaten_ask')
    message = `$${wall.price.toLocaleString('ru-RU')} • -${reduction?.toFixed(0) ?? 0}%`
  } else if (type === 'APPEARED') {
    bgColor = 'bg-holo/10'
    icon = <AlertTriangle className="w-5 h-5 text-holo" />
    title = `${t('wall_appeared')} ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')} • ${formatVol(wall.initialVolume)}`
  } else if (type === 'REDUCED') {
    bgColor = 'bg-hull-light/50'
    icon = <AlertTriangle className="w-5 h-5 text-holo/60" />
    title = `${t('wall_reduced')} ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')} • -${reduction?.toFixed(0) ?? 0}%`
  } else {
    bgColor = 'bg-hull-light/40'
    title = `${t('wall_appeared')} ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')}`
  }

  return (
    <div
      className={`${bgColor} border border-hull-border rounded-lg p-3 transition-all duration-300 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono font-bold text-holo mb-1">{title}</div>
          <div className="text-xs text-holo/70">{message}</div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="flex-shrink-0 p-1 hover:bg-hull-light/50 rounded transition-colors"
        >
          <X className="w-4 h-4 text-holo/50" />
        </button>
      </div>
    </div>
  )
}

export default WallAlert
