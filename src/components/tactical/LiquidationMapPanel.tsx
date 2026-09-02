import { Flame } from 'lucide-react'
import type { LiqHeatmapModel } from '../../engine/derivatives/liqHeatmap'

interface Props {
  model: LiqHeatmapModel | null
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(4)
}

function barPct(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0
  return Math.max(4, Math.min(100, (value / max) * 100))
}

/**
 * Dual map: estimated long/short liquidations + live buy/sell (tape + book).
 */
const LiquidationMapPanel = ({ model }: Props) => {
  if (!model || model.bins.length === 0) return null

  const tapeTotal = model.buyTape + model.sellTape
  const buyShare = tapeTotal > 0 ? (model.buyTape / tapeTotal) * 100 : 50
  const visible = model.bins
    .filter((b) => b.longLiq + b.shortLiq + b.buyVol + b.sellVol + b.bidSize + b.askSize > 0)
    .slice()
    .reverse()

  return (
    <div className="rounded-xl border border-hull-border bg-hull p-3">
      <div className="mb-2 flex items-center gap-2">
        <Flame className="h-4 w-4 text-orange-300" />
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/80">
          Карта ликвидаций
        </span>
        <span className="ml-auto font-mono text-[10px] text-holo/35">оценка</span>
      </div>

      <p className="mb-2 font-mono text-[11px] leading-snug text-holo/55">{model.label}</p>

      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase">
        <span className="text-orange-300">шорты ↑</span>
        <span className="text-holo/30">liq</span>
        <span className="text-cyan-300">лонг ↓</span>
        <span className="ml-auto text-holo/35">
          купили {buyShare.toFixed(0)}% · продали {(100 - buyShare).toFixed(0)}%
        </span>
      </div>

      <div className="relative max-h-56 overflow-y-auto [scrollbar-width:thin]">
        {visible.map((bin) => {
          const isNow =
            model.currentPrice >= bin.priceLow && model.currentPrice < bin.priceHigh
          const shortPct = barPct(bin.shortLiq, model.maxLiq)
          const longPct = barPct(bin.longLiq, model.maxLiq)
          const sellPct = barPct(bin.sellVol + bin.askSize, model.maxFlow + model.maxBook)
          const buyPct = barPct(bin.buyVol + bin.bidSize, model.maxFlow + model.maxBook)
          return (
            <div
              key={bin.priceLow}
              className={`grid grid-cols-[1fr_4.6rem_1fr] items-center gap-1 py-[2px] ${
                isNow ? 'rounded bg-white/10' : ''
              }`}
            >
              <div className="flex h-3 items-center justify-end gap-0.5">
                {sellPct > 0 && (
                  <div
                    className="h-1 rounded-sm bg-rose-400/70"
                    style={{ width: `${Math.min(40, sellPct * 0.4)}%` }}
                    title="Продажи / аски"
                  />
                )}
                {shortPct > 0 && (
                  <div
                    className="h-2.5 rounded-sm bg-orange-400/80"
                    style={{ width: `${shortPct}%` }}
                    title="Ликвидации шортов"
                  />
                )}
              </div>
              <div
                className={`text-center font-mono text-[10px] ${
                  isNow ? 'font-bold text-white' : 'text-holo/45'
                }`}
              >
                {isNow ? '● ' : ''}
                {fmtPx(bin.price)}
              </div>
              <div className="flex h-3 items-center gap-0.5">
                {longPct > 0 && (
                  <div
                    className="h-2.5 rounded-sm bg-cyan-400/80"
                    style={{ width: `${longPct}%` }}
                    title="Ликвидации лонгов"
                  />
                )}
                {buyPct > 0 && (
                  <div
                    className="h-1 rounded-sm bg-emerald-400/70"
                    style={{ width: `${Math.min(40, buyPct * 0.4)}%` }}
                    title="Покупки / биды"
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] text-holo/45">
        <div>
          Оранжевый — где снимут шорты (forced buy).
          <br />
          Голубой — где снимут лонги (forced sell).
        </div>
        <div className="text-right">
          Тонкая полоска — реальные покупки/продажи и стакан.
          <br />
          MEXC не отдаёт ленту ликвидаций, это оценка по объёму и плечам.
        </div>
      </div>
    </div>
  )
}

export default LiquidationMapPanel
