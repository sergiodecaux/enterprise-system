import type { CoinSentiment } from '../../engine/sentiment/types'

interface Props {
  sentiment: CoinSentiment | null
}

const SentimentBadge = ({ sentiment }: Props) => {
  if (!sentiment || sentiment.newsCount === 0) return null

  const config = {
    BULLISH: { icon: '↑', color: 'text-matrix', bg: 'bg-matrix/10' },
    BEARISH: { icon: '↓', color: 'text-alert', bg: 'bg-alert/10' },
    NEUTRAL: { icon: '—', color: 'text-holo/40', bg: 'bg-hull/30' },
  }[sentiment.label]

  return (
    <div
      className={`flex items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[9px] font-bold ${config.color} ${config.bg}`}
    >
      <span>{config.icon}</span>
      <span>{sentiment.newsCount}</span>
    </div>
  )
}

export default SentimentBadge
