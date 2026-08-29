import type { Radar141Row } from '../../engine/radar141'

interface Props {
  rows: Radar141Row[]
  onPick: (row: Radar141Row) => void
}

const Radar141Heatmap = ({ rows, onPick }: Props) => {
  return (
    <div className="px-4 pb-3">
      <p className="mb-2 font-mono text-[10px] text-white/40">
        X = Gap% · Y = RS к BTC. Верх-право: Strong + большая пропасть вверх. Низ-право: Weak + пропасть вниз.
      </p>
      <div className="relative h-64 overflow-hidden rounded-xl border border-white/10 bg-[#0a0d12]">
        <div className="pointer-events-none absolute inset-x-8 top-2 text-center font-mono text-[9px] text-emerald-300/50">
          Strong
        </div>
        <div className="pointer-events-none absolute inset-x-8 bottom-6 text-center font-mono text-[9px] text-sky-300/50">
          Weak
        </div>
        <div className="pointer-events-none absolute bottom-1 right-2 font-mono text-[9px] text-white/30">
          gap →
        </div>
        <div className="absolute inset-6 border border-dashed border-white/10">
          <div className="absolute left-1/2 top-0 h-full w-px bg-white/10" />
          <div className="absolute left-0 top-1/2 h-px w-full bg-white/10" />
        </div>
        {rows.map((row) => {
          const x = Math.min(96, Math.max(4, (row.gapPct / 10) * 100))
          const y = Math.min(96, Math.max(4, 50 - row.rsBtc1d * 6))
          const up = row.preferredSide !== 'SHORT'
          return (
            <button
              key={row.internalSymbol}
              type="button"
              onClick={() => onPick(row)}
              title={`${row.displayName} gap ${row.gapPct.toFixed(1)}% RS ${row.rsBtc1d.toFixed(1)}`}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-1.5 py-0.5 font-mono text-[8px] font-bold ${
                up
                  ? 'bg-emerald-500/80 text-black'
                  : 'bg-sky-400/80 text-black'
              }`}
              style={{ left: `${x}%`, top: `${y}%` }}
            >
              {row.displayName.replace('/USDT', '')}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default Radar141Heatmap
