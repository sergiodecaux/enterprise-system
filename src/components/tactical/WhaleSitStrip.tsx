import type { WhaleSitMap } from '../../engine/orderbook/whaleSitLevels'
import { formatSitVolume } from '../../engine/orderbook/whaleSitLevels'

interface Props {
  sit: WhaleSitMap | null
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(4)
}

/**
 * One line under the chart — nearest unused whale sit levels.
 * Visible in clean mode; no essay, no candle cover.
 */
const WhaleSitStrip = ({ sit }: Props) => {
  if (!sit) return null
  const below = sit.nearestBelow
  const above = sit.nearestAbove
  if (!below && !above && !sit.accumulationReason) return null

  return (
    <div
      className="flex min-w-0 items-center gap-2 overflow-hidden rounded-md border border-cyan-400/20 bg-cyan-500/[0.06] px-2 py-1 font-mono text-[10px] leading-tight"
      title={sit.huntLine}
    >
      <span className="shrink-0 font-bold uppercase tracking-wider text-cyan-200/85">
        Киты
      </span>
      <span className="min-w-0 truncate text-white/70">
        {below ? (
          <span className="text-emerald-200/90">
            лонг здесь {fmtPx(below.price)} ↓{below.distancePct.toFixed(2)}%
            {below.volumeUsd >= 250_000
              ? ` ${formatSitVolume(below.volumeUsd)}`
              : ''}
          </span>
        ) : (
          <span className="text-white/35">лонг —</span>
        )}
        <span className="text-white/25"> · </span>
        {above ? (
          <span className="text-orange-200/90">
            шорт / стопы {fmtPx(above.price)} ↑{above.distancePct.toFixed(2)}%
            {above.volumeUsd >= 250_000
              ? ` ${formatSitVolume(above.volumeUsd)}`
              : ''}
          </span>
        ) : (
          <span className="text-white/35">шорт —</span>
        )}
        {sit.accumulationReason ? (
          <span className="text-cyan-200/70"> · {sit.accumulationReason}</span>
        ) : null}
      </span>
    </div>
  )
}

export default WhaleSitStrip
