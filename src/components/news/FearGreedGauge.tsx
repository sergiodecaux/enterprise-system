import { useEffect, useRef } from 'react'
import type { FearGreedData } from '../../engine/sentiment/types'

interface Props {
  data: FearGreedData
}

const COLORS = [
  { max: 25, color: '#ef4444', label: 'Страх' },
  { max: 45, color: '#f97316', label: 'Осторожность' },
  { max: 55, color: '#eab308', label: 'Нейтрально' },
  { max: 75, color: '#84cc16', label: 'Жадность' },
  { max: 100, color: '#22c55e', label: 'Макс. жадность' },
]

function getColor(value: number) {
  return COLORS.find((c) => value <= c.max) ?? COLORS[COLORS.length - 1]
}

const FearGreedGauge = ({ data }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const config = getColor(data.value)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = 120
    const H = 70
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(W * dpr)
    canvas.height = Math.floor(H * dpr)
    canvas.style.width = `${W / 2}px`
    canvas.style.height = `${H / 2}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const cx = W / 2
    const cy = H - 10
    const r = 50

    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 10
    ctx.lineCap = 'round'
    ctx.stroke()

    const endAngle = Math.PI + (data.value / 100) * Math.PI
    ctx.beginPath()
    ctx.arc(cx, cy, r, Math.PI, endAngle)
    ctx.strokeStyle = config.color
    ctx.lineWidth = 10
    ctx.stroke()

    ctx.font = 'bold 22px monospace'
    ctx.fillStyle = config.color
    ctx.textAlign = 'center'
    ctx.fillText(String(data.value), cx, cy - 8)
  }, [data.value, config.color])

  const delta = data.previousValue != null ? data.value - data.previousValue : 0

  return (
    <div className="flex items-center gap-3 rounded-lg bg-hull-light/20 px-3 py-2">
      <canvas ref={canvasRef} className="flex-shrink-0" />
      <div>
        <div className="font-mono text-[10px] uppercase text-holo/50">
          Fear & Greed
        </div>
        <div
          className="font-mono text-xs font-bold"
          style={{ color: config.color }}
        >
          {config.label}
        </div>
        {delta !== 0 && (
          <div
            className={`font-mono text-[10px] ${
              delta > 0 ? 'text-matrix' : 'text-alert'
            }`}
          >
            {delta > 0 ? '+' : ''}
            {delta} за день
          </div>
        )}
      </div>
    </div>
  )
}

export default FearGreedGauge
