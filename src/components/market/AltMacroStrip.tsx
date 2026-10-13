import type { WorkerMarketContext } from '../../api/marketContext'
import { fmtTotal3Usd } from '../../engine/analysis/altMacro'
import {
  deriveMacroStructure,
  type IndexStructure,
  type MacroTrend,
} from '../../engine/analysis/macroStructure'

function trendTone(trend: MacroTrend): string {
  if (trend === 'UP') return 'text-emerald-300'
  if (trend === 'DOWN') return 'text-rose-300'
  if (trend === 'RANGE') return 'text-white/70'
  return 'text-white/35'
}

function trendArrow(trend: MacroTrend): string {
  if (trend === 'UP') return '↑'
  if (trend === 'DOWN') return '↓'
  if (trend === 'RANGE') return '→'
  return '·'
}

function locWord(loc: IndexStructure['location']): string {
  if (loc === 'HIGH') return 'сопрот.'
  if (loc === 'LOW') return 'поддержка'
  if (loc === 'MID') return 'середина'
  return '—'
}

function MacroCell({
  label,
  value,
  s,
}: {
  label: string
  value: string
  s: IndexStructure
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-2 text-center">
      <div className="font-mono text-[9px] uppercase text-white/40">{label}</div>
      <div className="font-mono text-sm font-bold text-white">{value}</div>
      <div className={`font-mono text-[9px] ${trendTone(s.trend)}`}>
        {trendArrow(s.trend)} {locWord(s.location)}
      </div>
    </div>
  )
}

export function AltMacroStrip({ ctx }: { ctx: WorkerMarketContext | null }) {
  const macro = deriveMacroStructure({
    btcD: ctx?.macroSeries?.btcD,
    total3: ctx?.macroSeries?.total3,
    others: ctx?.macroSeries?.others,
  })

  const biasTone =
    macro.bias === 'TAILWIND'
      ? 'text-emerald-300'
      : macro.bias === 'HEADWIND'
        ? 'text-rose-300'
        : 'text-white/70'
  const biasWord =
    macro.bias === 'TAILWIND'
      ? 'ПОПУТКА АЛЬТАМ'
      : macro.bias === 'HEADWIND'
        ? 'ВСТРЕЧКА АЛЬТАМ'
        : macro.bias === 'NA'
          ? 'МАЛО ДАННЫХ'
          : 'СМЕШАННО'

  const srcNote = ctx?.macroSeries
    ? `${ctx.macroSeries.source}${ctx.macroSeries.reconstructed ? ', реконстр.' : ''}`
    : 'ждём данные'

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-2">
        <MacroCell
          label="BTC.D"
          value={ctx?.btcDominance != null ? `${ctx.btcDominance.toFixed(1)}%` : '—'}
          s={macro.btcD}
        />
        <MacroCell label="TOTAL3" value={fmtTotal3Usd(ctx?.total3Usd)} s={macro.total3} />
        <MacroCell label="OTHERS" value={fmtTotal3Usd(ctx?.othersUsd)} s={macro.others} />
      </div>
      <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
        <span className={`font-mono text-[11px] font-bold ${biasTone}`}>{biasWord}</span>
        <span className="font-mono text-[9px] text-white/35">{srcNote}</span>
      </div>
    </div>
  )
}
