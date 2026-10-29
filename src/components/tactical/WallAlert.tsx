import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Ghost, TrendingUp, TrendingDown, X } from 'lucide-react'
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

  let bgColor = 'bg-bg-panel'
  let icon = <AlertTriangle className="h-4 w-4 text-text-muted" />
  let title = ''
  let message = ''

  if (type === 'EATEN') {
    bgColor = wall.side === 'BID' ? 'bg-market-short/[0.08]' : 'bg-market-long/[0.08]'
    icon =
      wall.side === 'BID' ? (
        <TrendingDown className="h-4 w-4 text-market-short" />
      ) : (
        <TrendingUp className="h-4 w-4 text-market-long" />
      )
    title =
      wall.side === 'BID' ? t('wall_eaten_bid') : t('wall_eaten_ask')
    message = `$${wall.price.toLocaleString('ru-RU')} • -${reduction?.toFixed(0) ?? 0}%`
  } else if (type === 'SPOOFED') {
    bgColor = 'bg-market-short/[0.08]'
    icon = <Ghost className="h-4 w-4 text-market-short" />
    title = `SPOOFING ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')} • стена исчезла ≤2с — не учитывать в Confidence`
  } else if (type === 'APPEARED') {
    bgColor = 'bg-bg-elevated'
    icon = <AlertTriangle className="h-4 w-4 text-market-info" />
    title = `${t('wall_appeared')} ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')} • ${formatVol(wall.initialVolume)}`
  } else if (type === 'REDUCED') {
    bgColor = 'bg-bg-panel'
    icon = <AlertTriangle className="h-4 w-4 text-text-muted" />
    title = `${t('wall_reduced')} ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')} • -${reduction?.toFixed(0) ?? 0}%`
  } else {
    bgColor = 'bg-bg-panel'
    title = `${t('wall_appeared')} ${wall.side}`
    message = `$${wall.price.toLocaleString('ru-RU')}`
  }

  return (
    <div
      className={`${bgColor} rounded-md border border-border p-3 transition-all duration-300 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex-shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 font-sans text-[12px] font-medium leading-4 text-text-primary">
            {title}
          </div>
          <div className="tnum font-mono text-[11px] leading-4 text-text-secondary">
            {message}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="-m-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default WallAlert
