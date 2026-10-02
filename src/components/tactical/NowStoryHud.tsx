/**
 * Compact now-state on the chart: в зоне / подход / отскок / потеря + long/short + live %.
 */

import type { StoryNowKind } from '../../engine/smc/chartStory'

interface Props {
  line: string
  kind: StoryNowKind
  side: 'LONG' | 'SHORT' | null
  oddsPct?: number | null
  fact?: string | null
  /** Phone / Telegram drawer — larger type, narrower pill so candles stay visible. */
  dense?: boolean
}

const NowStoryHud = ({ line, kind, side, oddsPct, fact, dense = false }: Props) => {
  if (!line) return null
  const tone =
    kind === 'IN_ZONE'
      ? 'border-emerald-400/40 bg-emerald-950/80 text-emerald-100'
      : kind === 'APPROACHING'
        ? 'border-amber-400/40 bg-amber-950/80 text-amber-100'
        : kind === 'BOUNCE'
          ? 'border-cyan-400/35 bg-cyan-950/75 text-cyan-100'
          : kind === 'LOST'
            ? 'border-rose-400/45 bg-rose-950/80 text-rose-100'
            : 'border-white/15 bg-black/70 text-white/75'
  const arrow = side === 'LONG' ? '↑' : side === 'SHORT' ? '↓' : ''
  const hasPct = line.includes('%')
  const pctBit =
    !hasPct && oddsPct != null && Number.isFinite(oddsPct)
      ? ` ${Math.round(oddsPct)}%`
      : ''
  return (
    <div
      className={`rounded-md border font-mono font-bold leading-tight shadow-lg backdrop-blur-md ${tone} ${
        dense
          ? 'max-w-full px-2.5 py-1 text-[12px]'
          : 'max-w-[82%] px-2 py-0.5 text-[10px]'
      }`}
      title={fact || undefined}
    >
      {line}
      {pctBit}
      {arrow ? ` ${arrow}` : ''}
    </div>
  )
}

export default NowStoryHud
