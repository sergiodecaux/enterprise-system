import type { CoinSentiment } from '../../engine/sentiment/types'

interface Props {
  sentiment: CoinSentiment | null
}

const SentimentBadge = ({ sentiment }: Props) => {
  const empty = !sentiment || sentiment.newsCount === 0
  const config = empty
    ? { icon: '·', color: 'text-transparent', bg: 'bg-transparent' }
    : {
        BULLISH: { icon: '↑', color: 'text-matrix', bg: 'bg-matrix/10' },
        BEARISH: { icon: '↓', color: 'text-alert', bg: 'bg-alert/10' },
        NEUTRAL: { icon: '—', color: 'text-holo/40', bg: 'bg-hull/30' },
      }[sentiment!.label]

  return (
    <div
      className={`inline-flex h-4 w-7 shrink-0 items-center justify-center gap-0.5 rounded px-0.5 font-mono text-[9px] font-bold tabular-nums ${config.color} ${config.bg} ${
        empty ? 'invisible' : ''
      }`}
      aria-hidden={empty}
    >
      <span>{config.icon}</span>
      <span>{empty ? '0' : sentiment!.newsCount}</span>
    </div>
  )
}

export default SentimentBadge
