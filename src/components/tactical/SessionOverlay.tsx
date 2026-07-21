import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type {
  SessionSegment,
  WeekendSegment,
  NewsEvent,
  SessionSettings,
} from '../../engine/sessions/types'
import { SESSION_DEFINITIONS, getSessionAtHour } from '../../engine/sessions/sessionMap'
import { getNewsColor } from '../../engine/sessions/newsCalendar'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  sessions: SessionSegment[]
  weekends: WeekendSegment[]
  news: NewsEvent[]
  settings: SessionSettings
  timeframe: string
}

const SHOW_SESSIONS_ON = new Set(['1m', '5m', '15m', '1h'])
const RIBBON_H = 18

function solidFromRgba(rgba: string, alpha = 0.92): string {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return rgba
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
}

const SessionOverlay = ({
  chart,
  series,
  containerRef,
  sessions,
  weekends,
  news,
  settings,
  timeframe,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !chart || !series) return

    const draw = () => {
      const W = container.clientWidth
      const H = container.clientHeight
      if (W <= 0 || H <= 0) return

      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      if (!SHOW_SESSIONS_ON.has(timeframe) || !settings.enabled) return

      const timeScale = chart.timeScale()
      const tsToX = (ts: number): number | null => {
        const coord = timeScale.timeToCoordinate(ts as Time)
        return coord !== null && coord !== undefined ? (coord as number) : null
      }

      const nowTs = Math.floor(Date.now() / 1000)
      const nowSession = getSessionAtHour(new Date().getUTCHours())
      const nowDef = SESSION_DEFINITIONS[nowSession]
      const opFactor = Math.max(0.55, settings.opacity / 100)

      weekends.forEach((wknd) => {
        const x1 = tsToX(wknd.startTs)
        const x2 = tsToX(wknd.endTs)
        if (x1 === null && x2 === null) return

        const left = x1 ?? 0
        const right = x2 ?? W
        if (right <= 0 || left >= W) return

        const rectLeft = Math.max(0, left)
        const rectRight = Math.min(W, right)
        const rectW = rectRight - rectLeft
        if (rectW <= 0) return

        ctx.save()
        ctx.beginPath()
        ctx.rect(rectLeft, 0, rectW, H)
        ctx.clip()

        ctx.fillStyle = `rgba(30, 30, 40, ${0.18 * opFactor})`
        ctx.fillRect(rectLeft, 0, rectW, H)

        ctx.strokeStyle = `rgba(80, 80, 100, ${0.18 * opFactor})`
        ctx.lineWidth = 1
        const step = 12
        for (let x = rectLeft - H; x < rectRight + H; x += step) {
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x + H, H)
          ctx.stroke()
        }
        ctx.restore()

        ctx.fillStyle = 'rgba(71, 85, 105, 0.85)'
        ctx.fillRect(rectLeft, 0, rectW, RIBBON_H)
        if (rectW > 36) {
          ctx.font = 'bold 10px monospace'
          ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(wknd.label, rectLeft + rectW / 2, RIBBON_H / 2)
          ctx.textBaseline = 'alphabetic'
        }
      })

      sessions.forEach((seg) => {
        const x1 = tsToX(seg.startTs)
        const x2 = tsToX(seg.endTs)
        if (x1 === null && x2 === null) return

        const left = x1 ?? 0
        const right = x2 ?? W
        if (right <= 0 || left >= W) return

        const rectLeft = Math.max(0, left)
        const rectRight = Math.min(W, right)
        const rectW = rectRight - rectLeft
        if (rectW <= 1) return

        const isCurrent =
          nowTs >= seg.startTs && nowTs < seg.endTs && seg.session === nowSession

        // Фон сессии
        ctx.fillStyle = seg.color
        ctx.fillRect(rectLeft, RIBBON_H, rectW, H - RIBBON_H)

        // Цветная лента сверху — главный визуальный якорь
        const ribbon = solidFromRgba(seg.lineColor, isCurrent ? 0.95 : 0.78)
        ctx.fillStyle = ribbon
        ctx.fillRect(rectLeft, 0, rectW, RIBBON_H)

        if (isCurrent) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
          ctx.fillRect(rectLeft, 0, rectW, 3)
        }

        if (settings.showSessionLines && x1 !== null && x1 >= 0 && x1 <= W) {
          ctx.beginPath()
          ctx.strokeStyle = solidFromRgba(seg.lineColor, 0.75 * opFactor)
          ctx.lineWidth = seg.isOverlap || isCurrent ? 1.5 : 1
          ctx.setLineDash(seg.isOverlap ? [] : [4, 6])
          ctx.moveTo(x1, RIBBON_H)
          ctx.lineTo(x1, H)
          ctx.stroke()
          ctx.setLineDash([])
        }

        // Подпись на ленте
        if (rectW > 42) {
          ctx.font = `bold ${isCurrent ? 11 : 10}px monospace`
          ctx.fillStyle = '#0a0a0a'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          const label = isCurrent
            ? `● ${seg.label.toUpperCase()}`
            : seg.label.toUpperCase()
          ctx.fillText(label, rectLeft + 6, RIBBON_H / 2 + 0.5)
          ctx.textBaseline = 'alphabetic'
        }
      })

      // Бейдж текущей сессии (правый верхний угол)
      {
        const badge = `СЕЙЧАС · ${nowDef.label.toUpperCase()}`
        ctx.font = 'bold 10px monospace'
        const padX = 8
        const tw = ctx.measureText(badge).width + padX * 2
        const bh = 18
        const bx = Math.max(6, W - tw - 6)
        const by = RIBBON_H + 6

        ctx.fillStyle = solidFromRgba(nowDef.lineColor, 0.92)
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(bx, by, tw, bh, 4)
        } else {
          ctx.rect(bx, by, tw, bh)
        }
        ctx.fill()

        ctx.strokeStyle = 'rgba(0,0,0,0.35)'
        ctx.lineWidth = 1
        ctx.stroke()

        ctx.fillStyle = '#0a0a0a'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(badge, bx + tw / 2, by + bh / 2)
        ctx.textBaseline = 'alphabetic'
      }

      if (settings.showNews) {
        news.forEach((event) => {
          const x = tsToX(event.timestamp)
          if (x === null || x < 0 || x > W) return

          const colors = getNewsColor(event.importance)

          ctx.beginPath()
          ctx.strokeStyle = colors.line
          ctx.lineWidth = 1.5
          ctx.setLineDash(
            event.importance === 'CRITICAL' ? [3, 3] : [4, 6]
          )
          ctx.moveTo(x, RIBBON_H + 4)
          ctx.lineTo(x, H)
          ctx.stroke()
          ctx.setLineDash([])

          const dotY = RIBBON_H + 12
          const dotR = event.importance === 'CRITICAL' ? 5 : 4

          ctx.beginPath()
          ctx.arc(x, dotY, dotR, 0, Math.PI * 2)
          ctx.fillStyle = colors.dot
          ctx.fill()
          ctx.strokeStyle = '#111'
          ctx.lineWidth = 1
          ctx.stroke()

          if (
            event.importance === 'CRITICAL' ||
            event.importance === 'HIGH'
          ) {
            ctx.font = 'bold 6px monospace'
            ctx.fillStyle = '#111'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(
              event.importance === 'CRITICAL' ? '!' : '↑',
              x,
              dotY
            )
            ctx.textBaseline = 'alphabetic'
          }

          const badgeText = event.name
          ctx.font = 'bold 8px monospace'
          const tw = ctx.measureText(badgeText).width + 6
          const bx = x - tw / 2
          const by = H - 22
          const bh = 13

          ctx.fillStyle = colors.bg
          ctx.beginPath()
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(bx, by, tw, bh, 2)
          } else {
            ctx.rect(bx, by, tw, bh)
          }
          ctx.fill()

          ctx.fillStyle = '#000'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(badgeText, x, by + bh / 2)
          ctx.textBaseline = 'alphabetic'
        })
      }
    }

    draw()

    const onRange = () => draw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    chart.subscribeCrosshairMove(onRange)

    const ro = new ResizeObserver(draw)
    ro.observe(container)

    // Обновлять бейдж «СЕЙЧАС» раз в минуту
    const tick = window.setInterval(draw, 60_000)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.unsubscribeCrosshairMove(onRange)
      ro.disconnect()
      window.clearInterval(tick)
    }
  }, [
    chart,
    series,
    sessions,
    weekends,
    news,
    settings,
    timeframe,
    containerRef,
  ])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 0 }}
    />
  )
}

export default SessionOverlay
