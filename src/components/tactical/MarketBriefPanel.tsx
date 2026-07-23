import { Compass, Clock3, CalendarDays, CandlestickChart } from 'lucide-react'
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

function lookColor(look: TfNarrative['look']): string {
  if (look === 'UP') return 'text-matrix'
  if (look === 'DOWN') return 'text-alert'
  return 'text-holo/55'
}

function TfCard({ tf }: { tf: TfNarrative }) {
  return (
    <div className="rounded-lg border border-hull-border/60 bg-black/25 px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between gap-1">
        <span className="font-mono text-[10px] font-bold uppercase text-holo/40">
          {tf.timeframe}
        </span>
        <span className={`font-mono text-[10px] font-bold ${lookColor(tf.look)}`}>
          {tf.look === 'UP' ? '↑' : tf.look === 'DOWN' ? '↓' : '↔'}
        </span>
      </div>
      <div className="font-mono text-[11px] font-bold text-holo leading-snug">
        {tf.headline}
      </div>
      <p className="mt-1 font-mono text-[10px] leading-relaxed text-holo/50">
        {tf.detail}
      </p>
    </div>
  )
}

function StyleCard({ plan }: { plan: StyleZonePlan }) {
  const accent =
    plan.style === 'SCALP'
      ? 'border-amber-500/40 bg-amber-500/5'
      : plan.style === 'SWING'
        ? 'border-sky-500/40 bg-sky-500/5'
        : 'border-matrix/35 bg-matrix/5'
  const label =
    plan.style === 'SCALP'
      ? '⚡ Скальп'
      : plan.style === 'SWING'
        ? '🕯 Свинг'
        : '🎯 Интрадей'
  const sideColor =
    plan.side === 'LONG'
      ? 'text-matrix'
      : plan.side === 'SHORT'
        ? 'text-alert'
        : 'text-holo/50'

  return (
    <div className={`rounded-xl border p-3 ${accent}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-bold text-holo">{label}</span>
        <span className={`font-mono text-xs font-black ${sideColor}`}>
          {plan.side === 'WAIT' ? 'WAIT' : plan.side} · {plan.probability}%
        </span>
      </div>
      <p className="mb-2 font-mono text-[11px] leading-relaxed text-holo/75">
        {plan.summary}
      </p>
      <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] text-holo/45">
        <div>
          Зона: {fmt(plan.zoneFrom)} – {fmt(plan.zoneTo)}
        </div>
        <div>
          Цель: {fmt(plan.target)}
        </div>
        <div className="col-span-2">Инвал: {fmt(plan.invalidation)}</div>
        <div className="col-span-2 text-holo/35">{plan.holdHint}</div>
      </div>
    </div>
  )
}

const MarketBriefPanel = ({ brief, loading }: Props) => {
  return (
    <div className="space-y-3 rounded-xl border border-hull-border bg-hull/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-matrix" />
          <div>
            <div className="font-mono text-xs font-bold uppercase tracking-wider text-holo">
              Бриф рынка
            </div>
            <div className="font-mono text-[10px] text-holo/40">
              {brief.displayName} · ${fmt(brief.price)}
              {loading ? ' · обновление…' : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-matrix/20 bg-matrix/5 px-3 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase text-matrix/70">
          <Clock3 className="h-3 w-3" /> Сейчас
        </div>
        <div className="font-mono text-sm font-bold text-holo leading-snug">
          {brief.nowHeadline}
        </div>
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-holo/55">
          {brief.nowDetail}
        </p>
      </div>

      <div className="rounded-lg border border-hull-border/50 bg-black/20 px-3 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase text-holo/40">
          <CandlestickChart className="h-3 w-3" /> На графике
        </div>
        <p className="font-mono text-[11px] leading-relaxed text-holo/65">
          {brief.chartStory}
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase text-holo/40">
          <CalendarDays className="h-3 w-3" /> Куда смотрят TF
        </div>
        <div className="grid grid-cols-2 gap-2">
          <TfCard tf={brief.week} />
          <TfCard tf={brief.day} />
          <TfCard tf={brief.h4} />
          <TfCard tf={brief.h1} />
        </div>
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase text-holo/40">
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
