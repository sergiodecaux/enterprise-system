import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Minus,
} from 'lucide-react'
import type { WorkerMarketContext } from '../../api/marketContext'
import { fmtTotal3Usd } from '../../engine/analysis/altMacro'
import {
  deriveMacroStructure,
  type IndexStructure,
  type MacroTrend,
} from '../../engine/analysis/macroStructure'

function trendTone(trend: MacroTrend): string {
  if (trend === 'UP') return 'text-market-long'
  if (trend === 'DOWN') return 'text-market-short'
  if (trend === 'RANGE') return 'text-text-secondary'
  return 'text-text-muted'
}

function TrendIcon({ trend }: { trend: MacroTrend }) {
  const className = `h-3 w-3 shrink-0 ${trendTone(trend)}`
  if (trend === 'UP') return <ArrowUpRight className={className} />
  if (trend === 'DOWN') return <ArrowDownRight className={className} />
  if (trend === 'RANGE') return <ArrowRight className={className} />
  return <Minus className={className} />
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
    <div className="rounded-md border border-border bg-bg-panel px-2 py-2">
      <div className="font-sans text-[11px] leading-4 text-text-muted">{label}</div>
      <div className="tnum mt-0.5 truncate font-mono text-[13px] font-medium leading-4 text-text-primary">
        {value}
      </div>
      <div className={`mt-0.5 flex items-center gap-1 font-mono text-[11px] leading-4 ${trendTone(s.trend)}`}>
        <TrendIcon trend={s.trend} />
        <span className="truncate">{locWord(s.location)}</span>
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
      ? 'text-market-long'
      : macro.bias === 'HEADWIND'
        ? 'text-market-short'
        : 'text-text-secondary'
  const biasDot =
    macro.bias === 'TAILWIND'
      ? 'bg-market-long'
      : macro.bias === 'HEADWIND'
        ? 'bg-market-short'
        : 'bg-text-muted'
  const biasWord =
    macro.bias === 'TAILWIND'
      ? 'Попутка альтам'
      : macro.bias === 'HEADWIND'
        ? 'Встречка альтам'
        : macro.bias === 'NA'
          ? 'Мало данных'
          : 'Смешанно'

  const srcNote = ctx?.macroSeries
    ? `${ctx.macroSeries.source}${ctx.macroSeries.reconstructed ? ', реконстр.' : ''}`
    : 'ждём данные'

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        <MacroCell
          label="BTC.D"
          value={ctx?.btcDominance != null ? `${ctx.btcDominance.toFixed(1)}%` : '—'}
          s={macro.btcD}
        />
        <MacroCell label="TOTAL3" value={fmtTotal3Usd(ctx?.total3Usd)} s={macro.total3} />
        <MacroCell label="OTHERS" value={fmtTotal3Usd(ctx?.othersUsd)} s={macro.others} />
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-panel px-2 py-1.5">
        <span className={`flex min-w-0 items-center gap-1.5 font-sans text-[11px] font-medium leading-4 ${biasTone}`}>
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${biasDot}`} />
          <span className="truncate">{biasWord}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] leading-4 text-text-muted">
          {srcNote}
        </span>
      </div>
    </div>
  )
}
