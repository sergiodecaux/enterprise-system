import { ExternalLink } from 'lucide-react'
import type { NewsItem } from '../../engine/sentiment/types'

interface Props {
  item: NewsItem
  compact?: boolean
}

const SENTIMENT_CONFIG = {
  BULLISH: {
    color: 'text-matrix',
    bg: 'bg-matrix/10',
    border: 'border-matrix/30',
    label: '↑ ЛОНГ',
  },
  BEARISH: {
    color: 'text-alert',
    bg: 'bg-alert/10',
    border: 'border-alert/30',
    label: '↓ ШОРТ',
  },
  NEUTRAL: {
    color: 'text-holo/50',
    bg: 'bg-hull/50',
    border: 'border-hull-border',
    label: '— НЕЙТ',
  },
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 3600) return `${Math.floor(diff / 60)} мин`
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч`
  return `${Math.floor(diff / 86400)} д`
}

const NewsCard = ({ item, compact = false }: Props) => {
  const sc = SENTIMENT_CONFIG[item.sentiment.label]

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`block rounded-lg border p-3 transition-all hover:bg-hull-light/30 ${sc.border} ${sc.bg}`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span
          className={`flex-shrink-0 rounded bg-black/20 px-1.5 py-0.5 font-mono text-[10px] font-bold ${sc.color}`}
        >
          {sc.label}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10px] text-holo/40">
            {timeAgo(item.publishedAt)}
          </span>
          <ExternalLink className="h-3 w-3 text-holo/30" />
        </div>
      </div>

      <p
        className={`font-mono text-xs leading-relaxed text-holo/90 ${
          compact ? 'line-clamp-2' : 'line-clamp-3'
        }`}
      >
        {item.title}
      </p>

      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] capitalize text-holo/40">{item.source}</span>
        {item.coins.length > 0 && (
          <div className="flex gap-1">
            {item.coins.slice(0, 3).map((coin) => (
              <span
                key={coin}
                className="rounded bg-holo/10 px-1 font-mono text-[9px] text-holo/60"
              >
                {coin}
              </span>
            ))}
          </div>
        )}
      </div>
    </a>
  )
}

export default NewsCard
