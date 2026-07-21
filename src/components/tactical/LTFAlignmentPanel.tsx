import type {
  LiquidityRaidResult,
  MSSResult,
  OTESniperZone,
} from '../../engine/types'

interface Props {
  mss: MSSResult | null
  raid: LiquidityRaidResult | null
  ote: OTESniperZone | null
}

const LTFAlignmentPanel = ({ mss, raid, ote }: Props) => {
  const hasData = mss?.detected || raid?.type !== 'NONE' || ote?.isActive
  if (!hasData) return null

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-base">🎯</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          LTF совпадение
        </span>
        {mss?.detected && (
          <span className="ml-auto rounded bg-matrix/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-matrix">
            +{mss.scoreBoost.toFixed(1)} к оценке
          </span>
        )}
      </div>

      <div className="space-y-2">
        {mss?.detected && (
          <div className="rounded-lg border border-matrix/20 bg-matrix/5 p-2">
            <p className="font-mono text-xs text-matrix">{mss.label}</p>
            <p className="mt-1 font-mono text-[10px] text-holo/40">
              Пробой: {mss.breakPrice?.toFixed(4)} · ТФ: {mss.timeframe}
            </p>
          </div>
        )}

        {raid && raid.type !== 'NONE' && (
          <div
            className={`rounded-lg border p-2 ${
              raid.isFresh
                ? 'border-yellow-400/30 bg-yellow-400/5'
                : 'border-hull-border bg-hull-light/20'
            }`}
          >
            <p
              className={`font-mono text-xs ${
                raid.isFresh ? 'text-yellow-400' : 'text-holo/50'
              }`}
            >
              {raid.label}
            </p>
            <div className="mt-1 flex items-center gap-3">
              <span className="font-mono text-[10px] text-holo/30">
                Глубина: {raid.sweepDepthPct.toFixed(3)}%
              </span>
              {raid.isFresh && (
                <span className="rounded bg-yellow-400/20 px-1 font-mono text-[9px] font-bold text-yellow-400">
                  СВЕЖИЙ +{raid.scoreBoost.toFixed(1)}
                </span>
              )}
            </div>
          </div>
        )}

        {ote?.isActive && (
          <div
            className={`rounded-lg border p-2 ${
              ote.priceInZone
                ? 'border-cyan-400/30 bg-cyan-400/5'
                : 'border-hull-border bg-hull-light/20'
            }`}
          >
            <p
              className={`font-mono text-xs ${
                ote.priceInZone ? 'text-cyan-400' : 'text-holo/50'
              }`}
            >
              {ote.label}
            </p>
            <div className="mt-1.5 grid grid-cols-3 gap-1 rounded bg-black/20 p-1.5">
              <div className="text-center">
                <div className="font-mono text-[9px] text-holo/30">
                  Импульс от
                </div>
                <div className="font-mono text-[10px] font-bold text-holo/70">
                  {ote.impulseOrigin.toFixed(4)}
                </div>
              </div>
              <div className="flex items-center justify-center">
                <span className="font-mono text-[9px] text-holo/20">→</span>
              </div>
              <div className="text-center">
                <div className="font-mono text-[9px] text-holo/30">До</div>
                <div className="font-mono text-[10px] font-bold text-holo/70">
                  {ote.impulseEnd.toFixed(4)}
                </div>
              </div>
            </div>
            {ote.priceInZone && (
              <p className="mt-1 font-mono text-[9px] text-cyan-400/70">
                Цена в OTE зоне · SL за {ote.impulseOrigin.toFixed(4)}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default LTFAlignmentPanel
