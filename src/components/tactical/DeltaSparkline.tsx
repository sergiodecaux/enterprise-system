import { useMemo } from 'react'
import { getFrames } from '../../engine/sequence'

interface Props {
  symbol: string
  refreshKey?: number
  height?: number
}

/**
 * Compact 5m delta sparkline under the main chart — Remizov DELTA frames.
 */
const DeltaSparkline = ({ symbol, refreshKey = 0, height = 36 }: Props) => {
  const bars = useMemo(() => {
    const frames = getFrames(symbol, 5 * 60_000)
    const hits = frames.filter((f) => f.kind === 'HIT' && (f.volumeUsd ?? 0) > 0)
    // Bucket into ~12 slots by time
    const now = Date.now()
    const slots = 12
    const windowMs = 5 * 60_000
    const out: Array<{ buy: number; sell: number }> = Array.from(
      { length: slots },
      () => ({ buy: 0, sell: 0 })
    )
    for (const f of hits) {
      const age = now - f.at
      if (age < 0 || age > windowMs) continue
      const idx = Math.min(
        slots - 1,
        Math.floor(((windowMs - age) / windowMs) * slots)
      )
      if (f.side === 'BUY') out[idx]!.buy += f.volumeUsd ?? 0
      else if (f.side === 'SELL') out[idx]!.sell += f.volumeUsd ?? 0
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, refreshKey])

  const max = Math.max(
    1,
    ...bars.map((b) => Math.max(b.buy, b.sell))
  )
  const net = bars.reduce((s, b) => s + b.buy - b.sell, 0)
  const netLabel =
    Math.abs(net) >= 1_000_000
      ? `${net >= 0 ? '+' : ''}${(net / 1_000_000).toFixed(2)}M`
      : Math.abs(net) >= 1_000
        ? `${net >= 0 ? '+' : ''}${(net / 1_000).toFixed(0)}K`
        : `${net >= 0 ? '+' : ''}${Math.round(net)}`

  const hasData = bars.some((b) => b.buy > 0 || b.sell > 0)
  if (!hasData) return null

  return (
    <div className="rounded-lg border border-white/[0.06] bg-[#0c0e12] px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[9px] font-bold uppercase tracking-wide text-white/40">
          Покупки / продажи · 5м
        </span>
        <span
          className={`font-mono text-[9px] font-bold ${
            net >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'
          }`}
        >
          {netLabel}
        </span>
      </div>
      <div className="flex items-end gap-0.5" style={{ height }}>
        {bars.map((b, i) => {
          const buyH = (b.buy / max) * height * 0.92
          const sellH = (b.sell / max) * height * 0.92
          return (
            <div
              key={i}
              className="relative flex flex-1 flex-col justify-end gap-px"
              title={`buy $${Math.round(b.buy)} / sell $${Math.round(b.sell)}`}
            >
              <div
                className="w-full rounded-sm bg-emerald-400/55"
                style={{ height: Math.max(b.buy > 0 ? 2 : 0, buyH) }}
              />
              <div
                className="w-full rounded-sm bg-rose-400/55"
                style={{ height: Math.max(b.sell > 0 ? 2 : 0, sellH) }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default DeltaSparkline
