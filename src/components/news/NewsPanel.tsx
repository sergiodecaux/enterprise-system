import { useState } from 'react'
import { Newspaper, ChevronDown, ChevronUp } from 'lucide-react'
import type { CoinSentiment } from '../../engine/sentiment/types'
import NewsCard from './NewsCard'

interface Props {
  coinSentiment: CoinSentiment | null
  symbol: string
}

const LABEL_CONFIG = {
  BULLISH: {
    color: 'text-matrix',
    bg: 'bg-matrix/20',
    border: 'border-matrix/40',
    text: '⬆ БЫЧИЙ',
  },
  BEARISH: {
    color: 'text-alert',
    bg: 'bg-alert/20',
    border: 'border-alert/40',
    text: '⬇ МЕДВЕЖИЙ',
  },
  NEUTRAL: {
    color: 'text-holo/60',
    bg: 'bg-hull/30',
    border: 'border-hull-border',
    text: '— НЕЙТРАЛЬНЫЙ',
  },
}

const NewsPanel = ({ coinSentiment, symbol }: Props) => {
  const [expanded, setExpanded] = useState(false)

  if (!coinSentiment || coinSentiment.newsCount === 0) {
    return (
      <div className="rounded-lg bg-hull-light/20 p-4 text-center">
        <span className="font-mono text-xs text-holo/40">
          Нет новостей по {symbol}
        </span>
      </div>
    )
  }

  const cfg = LABEL_CONFIG[coinSentiment.label]
  const boostText =
    coinSentiment.scoreBoost >= 0
      ? `+${coinSentiment.scoreBoost.toFixed(2)}`
      : coinSentiment.scoreBoost.toFixed(2)
  const boostColor =
    coinSentiment.scoreBoost >= 0 ? 'text-matrix' : 'text-alert'

  const visibleItems = expanded
    ? coinSentiment.items
    : coinSentiment.items.slice(0, 2)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-holo/50" />
          <h4 className="font-mono text-xs font-bold uppercase text-holo/80">
            Новостной фон
          </h4>
        </div>
        <div
          className={`flex items-center gap-2 rounded-lg border px-2 py-1 font-mono text-xs font-bold ${cfg.color} ${cfg.bg} ${cfg.border}`}
        >
          {cfg.text}
          <span className={`text-[10px] ${boostColor}`}>оценка {boostText}</span>
        </div>
      </div>

      <div className="rounded-lg bg-hull-light/20 p-3">
        <div className="mb-1.5 flex justify-between font-mono text-[10px] text-holo/50">
          <span>Медвежий</span>
          <span>{coinSentiment.newsCount} новостей</span>
          <span>Бычий</span>
        </div>
        <div className="relative h-2 overflow-hidden rounded-full bg-hull">
          <div className="absolute inset-y-0 left-1/2 w-px bg-holo/20" />
          <div
            className={`absolute inset-y-0 rounded-full transition-all duration-500 ${
              coinSentiment.score >= 0
                ? 'left-1/2 bg-matrix'
                : 'right-1/2 bg-alert'
            }`}
            style={{ width: `${Math.abs(coinSentiment.score) * 50}%` }}
          />
        </div>
      </div>

      <div className="space-y-2">
        {visibleItems.map((item) => (
          <NewsCard key={item.id} item={item} compact />
        ))}
      </div>

      {coinSentiment.items.length > 2 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-center gap-1 py-1 font-mono text-xs text-holo/50 transition-colors hover:text-holo/70"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Скрыть
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Ещё{' '}
              {coinSentiment.items.length - 2}
            </>
          )}
        </button>
      )}
    </div>
  )
}

export default NewsPanel
