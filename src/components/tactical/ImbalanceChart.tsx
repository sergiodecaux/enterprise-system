import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { OrderBookHistory, ImbalanceStats } from '../../engine/types'
import { getChartData } from '../../engine/orderbook/history'

interface Props {
  history: OrderBookHistory
  stats: ImbalanceStats | null
}

const ImbalanceChart = ({ history, stats }: Props) => {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || history.imbalanceHistory.length < 2) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const cssWidth = canvas.clientWidth || 400
    const cssHeight = 80
    canvas.width = Math.floor(cssWidth * dpr)
    canvas.height = Math.floor(cssHeight * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const data = getChartData(history, 60)
    const width = cssWidth
    const height = cssHeight

    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = 'rgba(10, 15, 25, 0.5)'
    ctx.fillRect(0, 0, width, height)

    ctx.strokeStyle = 'rgba(100, 200, 255, 0.15)'
    ctx.lineWidth = 1
    const mid = height / 2
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(width, mid)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(100, 200, 255, 0.06)'
    ctx.beginPath()
    ctx.moveTo(0, height * 0.25)
    ctx.lineTo(width, height * 0.25)
    ctx.moveTo(0, height * 0.75)
    ctx.lineTo(width, height * 0.75)
    ctx.stroke()

    if (data.length < 2) return

    const xStep = width / (data.length - 1)
    const yScale = (value: number) => height - ((value + 100) / 200) * height

    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, 'rgba(34, 197, 94, 0.3)')
    gradient.addColorStop(0.5, 'rgba(100, 200, 255, 0.1)')
    gradient.addColorStop(1, 'rgba(239, 68, 68, 0.3)')

    ctx.beginPath()
    ctx.moveTo(0, yScale(data[0].imbalance))
    data.forEach((point, i) => {
      ctx.lineTo(i * xStep, yScale(point.imbalance))
    })
    ctx.lineTo(width, height)
    ctx.lineTo(0, height)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(0, yScale(data[0].imbalance))
    data.forEach((point, i) => {
      ctx.lineTo(i * xStep, yScale(point.imbalance))
    })
    ctx.strokeStyle =
      data[data.length - 1].imbalance > 0
        ? 'rgba(34, 197, 94, 0.85)'
        : 'rgba(239, 68, 68, 0.85)'
    ctx.lineWidth = 2
    ctx.stroke()

    const lastX = (data.length - 1) * xStep
    const lastY = yScale(data[data.length - 1].imbalance)
    ctx.beginPath()
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#64c8ff'
    ctx.fill()
    ctx.strokeStyle = '#0a0f19'
    ctx.lineWidth = 2
    ctx.stroke()
  }, [history])

  if (!stats) {
    return (
      <div className="bg-hull-light/20 rounded-lg p-4 text-center text-xs text-holo/50">
        {t('imbalance_accumulating')}
      </div>
    )
  }

  const TrendIcon =
    stats.trend === 'RISING'
      ? TrendingUp
      : stats.trend === 'FALLING'
        ? TrendingDown
        : Minus

  const trendColor =
    stats.trend === 'RISING'
      ? 'text-matrix'
      : stats.trend === 'FALLING'
        ? 'text-alert'
        : 'text-holo/60'

  const trendLabel =
    stats.trend === 'RISING'
      ? t('imbalance_trend_rising')
      : stats.trend === 'FALLING'
        ? t('imbalance_trend_falling')
        : t('imbalance_trend_stable')

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-mono font-bold text-holo/80 uppercase">
          {t('imbalance_chart_title')}
        </h4>
        <div className={`flex items-center gap-1 ${trendColor}`}>
          <TrendIcon className="w-3 h-3" />
          <span className="text-xs font-mono">{trendLabel}</span>
        </div>
      </div>

      <div className="bg-hull-light/20 rounded-lg overflow-hidden">
        <canvas ref={canvasRef} className="w-full h-20 block" />
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-hull/50 rounded px-2 py-1">
          <div className="text-holo/50 text-[10px]">{t('imbalance_avg')}</div>
          <div className="font-mono text-holo/80">
            {stats.avg5min > 0 ? '+' : ''}
            {stats.avg5min.toFixed(1)}%
          </div>
        </div>
        <div className="bg-hull/50 rounded px-2 py-1">
          <div className="text-holo/50 text-[10px]">{t('imbalance_volatility')}</div>
          <div className="font-mono text-holo/80">{stats.volatility.toFixed(1)}</div>
        </div>
        <div className="bg-hull/50 rounded px-2 py-1">
          <div className="text-holo/50 text-[10px]">{t('imbalance_peak')}</div>
          <div className="font-mono">
            <span className="text-matrix">+{stats.peakBuyers.toFixed(0)}</span>
            {' / '}
            <span className="text-alert">{stats.peakSellers.toFixed(0)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ImbalanceChart
