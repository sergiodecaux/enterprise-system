import { ArrowRight, Crosshair } from 'lucide-react'
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
    <div className="rounded-lg border border-border bg-bg-panel p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <Crosshair className="h-3.5 w-3.5 shrink-0 text-market-info" strokeWidth={1.9} />
        <span className="font-sans text-[13px] font-medium leading-5 text-text-primary">
          LTF совпадение
        </span>
        {mss?.detected && (
          <span className="ml-auto shrink-0 rounded-sm bg-market-long/15 px-1.5 py-0.5 font-mono text-[11px] font-medium leading-4 text-market-long">
            +{mss.scoreBoost.toFixed(1)} к оценке
          </span>
        )}
      </div>

      <div className="space-y-2">
        {mss?.detected && (
          <div className="rounded-md border border-market-long/20 bg-market-long/[0.05] p-2">
            <p className="font-sans text-[11px] font-medium leading-4 text-market-long">
              {mss.label}
            </p>
            <p className="tnum mt-1 font-mono text-[11px] leading-4 text-text-muted">
              Пробой: {mss.breakPrice?.toFixed(4)} · ТФ: {mss.timeframe}
            </p>
          </div>
        )}

        {raid && raid.type !== 'NONE' && (
          <div
            className={`rounded-md border p-2 ${
              raid.isFresh
                ? 'border-market-warning/25 bg-market-warning/[0.05]'
                : 'border-border bg-bg-base/40'
            }`}
          >
            <p
              className={`font-sans text-[11px] font-medium leading-4 ${
                raid.isFresh ? 'text-market-warning' : 'text-text-secondary'
              }`}
            >
              {raid.label}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <span className="tnum font-mono text-[11px] leading-4 text-text-muted">
                Глубина: {raid.sweepDepthPct.toFixed(3)}%
              </span>
              {raid.isFresh && (
                <span className="rounded-sm bg-market-warning/15 px-1 font-mono text-[11px] font-medium leading-4 text-market-warning">
                  СВЕЖИЙ +{raid.scoreBoost.toFixed(1)}
                </span>
              )}
            </div>
          </div>
        )}

        {ote?.isActive && (
          <div
            className={`rounded-md border p-2 ${
              ote.priceInZone
                ? 'border-market-info/25 bg-market-info/[0.05]'
                : 'border-border bg-bg-base/40'
            }`}
          >
            <p
              className={`font-sans text-[11px] font-medium leading-4 ${
                ote.priceInZone ? 'text-market-info' : 'text-text-secondary'
              }`}
            >
              {ote.label}
            </p>
            <div className="mt-1.5 grid grid-cols-3 items-center gap-px overflow-hidden rounded-sm border border-border bg-border">
              <div className="bg-bg-base/60 px-1.5 py-1 text-center">
                <div className="font-sans text-[11px] leading-4 text-text-muted">
                  Импульс от
                </div>
                <div className="tnum font-mono text-[11px] font-medium leading-4 text-text-secondary">
                  {ote.impulseOrigin.toFixed(4)}
                </div>
              </div>
              <div className="flex items-center justify-center bg-bg-base/60 px-1 py-1">
                <ArrowRight className="h-3 w-3 text-text-muted" />
              </div>
              <div className="bg-bg-base/60 px-1.5 py-1 text-center">
                <div className="font-sans text-[11px] leading-4 text-text-muted">
                  До
                </div>
                <div className="tnum font-mono text-[11px] font-medium leading-4 text-text-secondary">
                  {ote.impulseEnd.toFixed(4)}
                </div>
              </div>
            </div>
            {ote.priceInZone && (
              <p className="tnum mt-1 font-sans text-[11px] leading-4 text-market-info/80">
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
