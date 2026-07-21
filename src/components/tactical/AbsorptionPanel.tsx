import type { AbsorptionCandle, LTFChoCHResult } from '../../engine/types'

interface AbsorptionPanelProps {
  absorption: AbsorptionCandle | null | undefined
  ltfChoCH: LTFChoCHResult | null | undefined
}

const AbsorptionPanel = ({ absorption, ltfChoCH }: AbsorptionPanelProps) => {
  const hasAbsorption = absorption?.detected
  const hasChoCH = ltfChoCH?.detected
  const hasSurgical = ltfChoCH?.surgicalEntryDetected

  if (!hasAbsorption && !hasChoCH) return null

  return (
    <div className="space-y-3 rounded-xl border border-hull-border bg-hull p-3">
      <div className="flex items-center gap-2">
        <span className="text-base">💎</span>
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Сила для Лонга
        </span>
      </div>

      {hasAbsorption && absorption && (
        <div className="rounded-lg border border-matrix/20 bg-matrix/5 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-matrix">
              🟢 Absorption (VSA)
            </span>
            <span className="ml-auto rounded bg-matrix/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-matrix">
              +{absorption.scoreBoost} к оценке
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded-md bg-black/20 p-2">
            <div className="text-center">
              <div className="font-mono text-[9px] uppercase text-holo/30">
                Объём ×
              </div>
              <div className="font-mono text-sm font-bold text-matrix">
                {absorption.volumeMultiplier.toFixed(1)}x
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[9px] uppercase text-holo/30">
                Тело
              </div>
              <div className="font-mono text-sm font-bold text-holo">
                {(absorption.bodyRatio * 100).toFixed(0)}%
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[9px] uppercase text-holo/30">
                Фитиль ↓
              </div>
              <div className="font-mono text-sm font-bold text-matrix">
                {(absorption.lowerWickRatio * 100).toFixed(0)}%
              </div>
            </div>
          </div>

          <p className="mt-1.5 font-mono text-[10px] text-holo/40">
            {absorption.label}
          </p>
        </div>
      )}

      {hasChoCH && ltfChoCH && (
        <div
          className={`rounded-lg border p-2.5 ${
            hasSurgical
              ? 'border-yellow-400/30 bg-yellow-400/5'
              : 'border-matrix/20 bg-matrix/5'
          }`}
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`font-mono text-xs font-bold ${
                hasSurgical ? 'text-yellow-400' : 'text-matrix'
              }`}
            >
              {hasSurgical ? '🎯 CHoCH + точный вход' : '✅ CHoCH 1m'}
            </span>
            <span
              className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                hasSurgical
                  ? 'bg-yellow-400/20 text-yellow-400'
                  : 'bg-matrix/20 text-matrix'
              }`}
            >
              +{ltfChoCH.scoreBoost} к оценке
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-md bg-black/20 p-2">
            <div>
              <div className="font-mono text-[9px] uppercase text-holo/30">
                Уровень пробоя
              </div>
              <div className="font-mono text-sm font-bold text-matrix">
                {ltfChoCH.breakLevel?.toFixed(4) ?? '--'}
              </div>
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase text-holo/30">
                Свечей назад
              </div>
              <div className="font-mono text-sm font-bold text-holo">
                {ltfChoCH.candlesAgo}
              </div>
            </div>

            {hasSurgical && ltfChoCH.surgicalEntryPrice && (
              <div className="col-span-2">
                <div className="font-mono text-[9px] uppercase text-holo/30">
                  🎯 Точный вход
                </div>
                <div className="font-mono text-sm font-bold text-yellow-400">
                  {ltfChoCH.surgicalEntryPrice.toFixed(4)}
                </div>
              </div>
            )}
          </div>

          <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-holo/40">
            {ltfChoCH.label}
          </p>
        </div>
      )}
    </div>
  )
}

export default AbsorptionPanel
