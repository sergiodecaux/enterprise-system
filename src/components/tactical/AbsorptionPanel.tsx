import { ArrowDown, Check, Crosshair, Gem } from 'lucide-react'
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
    <div className="space-y-2.5 rounded-lg border border-border bg-bg-panel p-3">
      <div className="flex items-center gap-2">
        <Gem className="h-3.5 w-3.5 shrink-0 text-market-long" strokeWidth={1.9} />
        <span className="font-sans text-[13px] font-medium leading-5 text-text-primary">
          Сила для лонга
        </span>
      </div>

      {hasAbsorption && absorption && (
        <div className="rounded-md border border-market-long/20 bg-market-long/[0.05] p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-sans text-[11px] font-medium leading-4 text-market-long">
              Absorption (VSA)
            </span>
            <span className="ml-auto rounded-sm bg-market-long/15 px-1.5 py-0.5 font-mono text-[11px] font-medium leading-4 text-market-long">
              +{absorption.scoreBoost} к оценке
            </span>
          </div>

          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-border bg-border">
            <div className="bg-bg-base/60 px-2 py-1.5 text-center">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Объём ×
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-market-long">
                {absorption.volumeMultiplier.toFixed(1)}x
              </div>
            </div>
            <div className="bg-bg-base/60 px-2 py-1.5 text-center">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Тело
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-text-primary">
                {(absorption.bodyRatio * 100).toFixed(0)}%
              </div>
            </div>
            <div className="bg-bg-base/60 px-2 py-1.5 text-center">
              <div className="flex items-center justify-center gap-0.5 font-sans text-[11px] leading-4 text-text-muted">
                Фитиль
                <ArrowDown className="h-2.5 w-2.5" />
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-market-long">
                {(absorption.lowerWickRatio * 100).toFixed(0)}%
              </div>
            </div>
          </div>

          <p className="mt-1.5 font-sans text-[11px] leading-4 text-text-muted">
            {absorption.label}
          </p>
        </div>
      )}

      {hasChoCH && ltfChoCH && (
        <div
          className={`rounded-md border p-2.5 ${
            hasSurgical
              ? 'border-market-warning/25 bg-market-warning/[0.05]'
              : 'border-market-long/20 bg-market-long/[0.05]'
          }`}
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`flex min-w-0 items-center gap-1 font-sans text-[11px] font-medium leading-4 ${
                hasSurgical ? 'text-market-warning' : 'text-market-long'
              }`}
            >
              {hasSurgical ? (
                <>
                  <Crosshair className="h-3 w-3 shrink-0" />
                  CHoCH + точный вход
                </>
              ) : (
                <>
                  <Check className="h-3 w-3 shrink-0" />
                  CHoCH 1m
                </>
              )}
            </span>
            <span
              className={`ml-auto shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-medium leading-4 ${
                hasSurgical
                  ? 'bg-market-warning/15 text-market-warning'
                  : 'bg-market-long/15 text-market-long'
              }`}
            >
              +{ltfChoCH.scoreBoost} к оценке
            </span>
          </div>

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border bg-border">
            <div className="bg-bg-base/60 px-2 py-1.5">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Уровень пробоя
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-market-long">
                {ltfChoCH.breakLevel?.toFixed(4) ?? '--'}
              </div>
            </div>
            <div className="bg-bg-base/60 px-2 py-1.5">
              <div className="font-sans text-[11px] leading-4 text-text-muted">
                Свечей назад
              </div>
              <div className="tnum font-mono text-[12px] font-medium leading-4 text-text-primary">
                {ltfChoCH.candlesAgo}
              </div>
            </div>

            {hasSurgical && ltfChoCH.surgicalEntryPrice && (
              <div className="col-span-2 bg-bg-base/60 px-2 py-1.5">
                <div className="flex items-center gap-1 font-sans text-[11px] leading-4 text-text-muted">
                  <Crosshair className="h-2.5 w-2.5" />
                  Точный вход
                </div>
                <div className="tnum font-mono text-[12px] font-medium leading-4 text-market-warning">
                  {ltfChoCH.surgicalEntryPrice.toFixed(4)}
                </div>
              </div>
            )}
          </div>

          <p className="mt-1.5 font-sans text-[11px] leading-4 text-text-muted">
            {ltfChoCH.label}
          </p>
        </div>
      )}
    </div>
  )
}

export default AbsorptionPanel
