import { useEffect, useRef } from 'react'

interface Props {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  confidence: number
}

const PredictionGauge = ({ direction, confidence }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const size = 120
    const centerX = size / 2
    const centerY = size / 2
    const radius = 45

    ctx.clearRect(0, 0, size, 80)

    ctx.beginPath()
    ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI)
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.1)'
    ctx.lineWidth = 8
    ctx.stroke()

    const startAngle = Math.PI
    const targetAngle =
      direction === 'LONG'
        ? Math.PI + (confidence / 100) * Math.PI
        : direction === 'SHORT'
          ? 2 * Math.PI - (confidence / 100) * Math.PI
          : Math.PI + Math.PI / 2

    const gradient = ctx.createLinearGradient(0, 0, size, 0)
    if (direction === 'LONG') {
      gradient.addColorStop(0, 'rgba(34, 197, 94, 0.8)')
      gradient.addColorStop(1, 'rgba(34, 197, 94, 1)')
    } else if (direction === 'SHORT') {
      gradient.addColorStop(0, 'rgba(239, 68, 68, 1)')
      gradient.addColorStop(1, 'rgba(239, 68, 68, 0.8)')
    } else {
      gradient.addColorStop(0, 'rgba(100, 200, 255, 0.6)')
      gradient.addColorStop(1, 'rgba(100, 200, 255, 0.6)')
    }

    ctx.beginPath()
    if (direction === 'SHORT') {
      ctx.arc(centerX, centerY, radius, 2 * Math.PI, targetAngle, true)
    } else {
      ctx.arc(centerX, centerY, radius, startAngle, targetAngle)
    }
    ctx.strokeStyle = gradient
    ctx.lineWidth = 8
    ctx.lineCap = 'round'
    ctx.stroke()

    ctx.fillStyle = '#64c8ff'
    ctx.font = 'bold 24px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${confidence.toFixed(0)}%`, centerX, centerY)
  }, [direction, confidence])

  return (
    <div className="flex justify-center">
      <canvas ref={canvasRef} width={120} height={80} className="h-20 w-30" />
    </div>
  )
}

export default PredictionGauge
