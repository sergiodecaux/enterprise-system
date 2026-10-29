import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  CandlestickChart,
  Clock3,
  Compass,
} from 'lucide-react'
import type { MarketBrief, StyleZonePlan, TfNarrative } from '../../engine/brief'

interface Props {
  brief: MarketBrief
  loading?: boolean
}

function fmt(price: number): string {
  if (!(price > 0)) return '—'
  if (price >= 1000) return price.toFixed(2)
  if (price >= 1) return price.toFixed(4)
  if (price >= 0.01) return price.toFixed(6)
  return price.toPrecision(5)
}

function lookTone(look: TfNarrative['look']): string {
  if (look === 'UP') return 'text-market-long'
  if (look === 'DOWN') return 'text-market-short'
  return 'text-text-muted'
}

function LookIcon({ look }: { look: TfNarrative['look'] }) {
  const className = `h-3 w-3 ${lookTone(look)}`
  if (look === 'UP') return <ArrowUp className={className} strokeWidth={2} />
  if (look === 'DOWN') return <ArrowDown className={className} strokeWidth={2} />
  return <ArrowRight className={className} strokeWidth={2} />
}

function TfCard({ tf }: { tf: TfNarrative }) {
  return (
    <div className="rounded-md border border-border bg-bg-base/40 px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between gap-1">
        <span className="font-mono text-[11px] font-medium leading-4 text-text-muted">
          {tf.timeframe}
        </span>
        <LookIcon look={tf.look} />
      </div>
      <div className="font-sans text-[11px] font-medium leading-4 text-text-primary">
        {tf.headline}
      </div>
      <p className="mt-1 font-sans text-[11px] leading-4 text-text-muted">
        {tf.detail}
      </p>
    </div>
  )
}

function StyleCard({ plan }: { plan: StyleZonePlan }) {
  const accent =
    plan.style === 'SCALP'
      ? 'border-market-warning/25 bg-market-warning/[0.04]'
      : plan.style === 'SWING'
        ? 'border-market-info/25 bg-market-info/[0.04]'
        : 'border-market-long/20 bg-market-long/[0.04]'
  const label =
    plan.style === 'SCALP'
      ? 'Скальп'
      : plan.style === 'SWING'
        ? 'Свинг'
        : 'Интрадей'
  const sideColor =
    plan.side === 'LONG'
      ? 'text-market-long'
      : plan.side === 'SHORT'
        ? 'text-market-short'
        : 'text-text-muted'

  return (
    <div className={`rounded-md border p-3 ${accent}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-sans text-[11px] font-medium leading-4 text-text-primary">
          {label}
        </span>
        <span
          className={`font-mono text-[11px] font-semibold leading-4 ${sideColor}`}
        >
          {plan.side === 'WAIT' ? 'WAIT' : plan.side}
        </span>
      </div>
      <p className="mb-2 font-sans text-[11px] leading-4 text-text-secondary">
        {plan.summary}
      </p>
      <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px] leading-4 text-text-muted">
        <div className="tnum">
          Зона: {fmt(plan.zoneFrom)} – {fmt(plan.zoneTo)}
        </div>
        <div className="tnum">Цель: {fmt(plan.target)}</div>
        <div className="tnum col-span-2">Инвал: {fmt(plan.invalidation)}</div>
        <div className="col-span-2 text-text-muted/80">{plan.holdHint}</div>
      </div>
    </div>
  )
}

const MarketBriefPanel = ({ brief, loading }: Props) => {
  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-bg-panel p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Compass className="h-4 w-4 shrink-0 text-market-info" strokeWidth={1.9} />
          <div className="min-w-0">
            <div className="font-sans text-[13px] font-medium leading-5 text-text-primary">
              Бриф рынка
            </div>
            <div className="tnum truncate font-mono text-[11px] leading-4 text-text-muted">
              {brief.displayName} · ${fmt(brief.price)}
              {loading ? ' · обновление…' : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-market-long/20 bg-market-long/[0.05] px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 font-sans text-[11px] font-medium leading-4 text-market-long">
          <Clock3 className="h-3 w-3" /> Сейчас
        </div>
        <div className="font-sans text-[13px] font-medium leading-5 text-text-primary">
          {brief.nowHeadline}
        </div>
        <p className="mt-1 font-sans text-[11px] leading-4 text-text-secondary">
          {brief.nowDetail}
        </p>
      </div>

      <div className="rounded-md border border-border bg-bg-base/40 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
          <CandlestickChart className="h-3 w-3" /> На графике
        </div>
        <p className="font-sans text-[11px] leading-4 text-text-secondary">
          {brief.chartStory}
        </p>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
          <CalendarDays className="h-3 w-3" /> Куда смотрят TF
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <TfCard tf={brief.week} />
          <TfCard tf={brief.day} />
          <TfCard tf={brief.h4} />
          <TfCard tf={brief.h1} />
        </div>
      </div>

      <div>
        <div className="mb-1.5 font-sans text-[11px] font-medium leading-4 text-text-muted">
          Зоны входа по стилю
        </div>
        <div className="space-y-2">
          {brief.styles.map((p) => (
            <StyleCard key={p.style} plan={p} />
          ))}
        </div>
      </div>
    </div>
  )
}

export default MarketBriefPanel
