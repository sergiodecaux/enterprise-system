import { useEffect, useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import type { NewsItem } from '../../engine/sentiment/types'

interface Props {
  items: NewsItem[]
}

const SENTIMENT_COLORS = {
  BULLISH: '#22c55e',
  BEARISH: '#ef4444',
  NEUTRAL: '#94a3b8',
}

const NewsStrip = ({ items }: Props) => {
  const [current, setCurrent] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const topItems = items
    .filter((i) => i.sentiment.label !== 'NEUTRAL')
    .slice(0, 10)

  useEffect(() => {
    if (topItems.length === 0) return
    timerRef.current = setInterval(() => {
      setCurrent((prev) => (prev + 1) % topItems.length)
    }, 5000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [topItems.length])

  if (topItems.length === 0) return null

  const item = topItems[current]
  if (!item) return null
  const color = SENTIMENT_COLORS[item.sentiment.label]
  const arrow = item.sentiment.label === 'BULLISH' ? '↑' : '↓'

  return (
    <div className="flex items-center gap-3 overflow-hidden border-b border-hull-border/30 bg-hull px-4 py-1.5">
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <Radio className="h-3 w-3 animate-pulse text-matrix" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-holo/40">
          NEWS
        </span>
      </div>

      <span
        className="flex-shrink-0 font-mono text-[10px] font-bold"
        style={{ color }}
      >
        {arrow} {item.sentiment.label}
      </span>

      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 truncate font-mono text-[11px] text-holo/70 hover:text-holo"
      >
        {item.title}
      </a>

      <div className="flex flex-shrink-0 gap-0.5">
        {topItems.slice(0, 5).map((_, i) => (
          <div
            key={i}
            className="h-1 w-1 rounded-full transition-colors"
            style={{ backgroundColor: i === current ? color : '#374151' }}
          />
        ))}
      </div>
    </div>
  )
}

export default NewsStrip
