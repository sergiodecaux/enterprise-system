import { useEffect, useState } from 'react'
import { getFrames, getOiSnapshot, type SequenceHit } from '../../engine/sequence'
import type { MarketRegime } from '../../engine/regime/marketRegime'

interface Props {
  symbol: string
  regime: MarketRegime
  sequence: SequenceHit | null
  /** Tick to re-read frame bus */
  refreshKey?: number
}

const REGIME_LABEL: Record<MarketRegime, string> = {
  TRENDING_STRONG: 'TREND↑',
  TRENDING_WEAK: 'TREND~',
  RANGING: 'RANGE',
  VOLATILE_CHOP: 'CHOP',
}

/**
 * Thin process strip: regime · active sequence · OI · 5m film dots.
 */
const ProcessStrip = ({ symbol, regime, sequence, refreshKey = 0 }: Props) => {
  const [dots, setDots] = useState<
    Array<{ kind: string; side?: string; strength: number }>
  >([])
  const [oiLabel, setOiLabel] = useState<string>('OI —')

  useEffect(() => {
    const frames = getFrames(symbol, 5 * 60_000)
    // Compress to last meaningful kinds for film strip
    const interesting = frames.filter((f) =>
      ['HIT', 'WALL', 'DELTA', 'OI', 'BOOK'].includes(f.kind)
    )
    const recent = interesting.slice(-18).map((f) => ({
      kind: f.kind,
      side: f.side,
      strength: f.strength ?? 0.4,
    }))
    setDots(recent)

    const oi = getOiSnapshot(symbol)
    if (oi) {
      const sign = oi.changePct >= 0 ? '+' : ''
      setOiLabel(`OI ${sign}${oi.changePct.toFixed(1)}%`)
    } else {
      setOiLabel('OI …')
    }
  }, [symbol, refreshKey, sequence?.detectedAt])

  const seqLive =
    sequence && sequence.expiresAt > Date.now() ? sequence : null
  const regimeColor =
    regime === 'TRENDING_STRONG'
      ? 'text-emerald-300 bg-emerald-500/15 border-emerald-400/30'
      : regime === 'TRENDING_WEAK'
        ? 'text-emerald-200/80 bg-emerald-500/10 border-emerald-400/20'
        : regime === 'VOLATILE_CHOP'
          ? 'text-rose-300 bg-rose-500/15 border-rose-400/30'
          : 'text-sky-300 bg-sky-500/12 border-sky-400/25'

  const dotColor = (kind: string, side?: string) => {
    if (kind === 'HIT')
      return side === 'BUY' ? 'bg-emerald-400' : 'bg-rose-400'
    if (kind === 'WALL')
      return side === 'BID' ? 'bg-cyan-400' : 'bg-orange-400'
    if (kind === 'DELTA') return 'bg-violet-400'
    if (kind === 'OI') return 'bg-amber-300'
    return 'bg-white/35'
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-white/[0.07] bg-[#0e1218] px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide ${regimeColor}`}
          title="Market regime — первый кадр"
        >
          {REGIME_LABEL[regime]}
        </span>
        <span className="font-mono text-[9px] text-white/35">{oiLabel}</span>
        {seqLive ? (
          <span
            className={`ml-auto truncate rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold ${
              seqLive.allowedInRegime
                ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                : 'border-white/10 bg-white/[0.04] text-white/40'
            }`}
            title={seqLive.summary}
          >
            SEQ {seqLive.side} ~{seqLive.confidence}%
            {!seqLive.allowedInRegime ? ' · off' : ''}
          </span>
        ) : (
          <span className="ml-auto font-mono text-[9px] text-white/25">
            process…
          </span>
        )}
      </div>

      {dots.length > 0 && (
        <div className="flex items-center gap-0.5 overflow-hidden">
          <span className="mr-1 shrink-0 font-mono text-[8px] uppercase text-white/25">
            5м
          </span>
          {dots.map((d, i) => (
            <span
              key={`${d.kind}-${i}`}
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor(d.kind, d.side)}`}
              style={{ opacity: 0.35 + d.strength * 0.65 }}
              title={`${d.kind}${d.side ? ' ' + d.side : ''}`}
            />
          ))}
          <span className="ml-auto flex gap-1.5 font-mono text-[7px] text-white/20">
            <span className="text-emerald-400/50">HIT</span>
            <span className="text-cyan-400/50">WALL</span>
            <span className="text-violet-400/50">Δ</span>
            <span className="text-amber-300/50">OI</span>
          </span>
        </div>
      )}

      {seqLive && (
        <p className="truncate font-mono text-[9px] leading-snug text-white/45">
          {seqLive.title}
          {seqLive.histWr && seqLive.histWr.decided >= 3
            ? ` · WR ${seqLive.histWr.winRate?.toFixed(0) ?? '—'}%`
            : ''}
        </p>
      )}
    </div>
  )
}

export default ProcessStrip
