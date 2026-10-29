import {
  Activity,
  Bot,
  Clock3,
  Hourglass,
  ShieldCheck,
  SkipForward,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import Badge from '../ui/Badge'
import type { BotJournalEntryDto } from '../../api/telegram/botJournal'
import { directionLabel } from '../../i18n/displayMaps'

interface Props {
  trade: BotJournalEntryDto
}

function fmt(price: number | null | undefined): string {
  if (!(price != null && price > 0)) return '—'
  if (price >= 1000) return price.toFixed(2)
  if (price >= 1) return price.toFixed(4)
  if (price >= 0.01) return price.toFixed(6)
  return price.toFixed(8)
}

function phaseOf(trade: BotJournalEntryDto): {
  label: string
  icon: LucideIcon
  color: string
} {
  if (trade.status === 'OPEN' && !trade.filledAt) {
    return { label: 'ЖДЁТ ВХОД', icon: Hourglass, color: 'text-market-warning' }
  }
  if (trade.status === 'OPEN') {
    return { label: 'В ПОЗИЦИИ', icon: Activity, color: 'text-market-long' }
  }
  if (trade.status === 'WIN') {
    return { label: 'WIN', icon: Target, color: 'text-market-long' }
  }
  if (trade.status === 'BE') {
    return { label: 'BE', icon: ShieldCheck, color: 'text-market-info' }
  }
  if (trade.status === 'INVALIDATED') {
    return { label: 'NO ENTRY', icon: SkipForward, color: 'text-text-muted' }
  }
  if (trade.status === 'TIMEOUT') {
    return { label: 'TIMEOUT', icon: Timer, color: 'text-market-warning' }
  }
  return { label: 'LOSS', icon: XCircle, color: 'text-market-short' }
}

const BotTradeCard = ({ trade }: Props) => {
  const isLong = trade.side === 'LONG'
  const phase = phaseOf(trade)
  const PhaseIcon = phase.icon
  const DirectionIcon = isLong ? TrendingUp : TrendingDown
  const tp1 = trade.target1 ?? trade.tp

  return (
    <div
      className={`relative overflow-hidden rounded-lg border bg-bg-panel p-3 ${
        isLong ? 'border-market-long/25' : 'border-market-short/25'
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[2px] ${
          isLong ? 'bg-market-long/70' : 'bg-market-short/70'
        }`}
      />

      <div className="pl-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Bot className="h-4 w-4 shrink-0 text-market-info" strokeWidth={1.8} />
              <span className="truncate font-mono text-[13px] font-semibold leading-5 text-text-primary">
                {trade.displayName}
              </span>
              <Badge tone={isLong ? 'long' : 'short'} uppercase>
                <DirectionIcon className="h-3 w-3" strokeWidth={2} />
                {directionLabel(trade.side)}
              </Badge>
              <Badge tone="neutral">
                {trade.alertType === 'SNIPER' ? 'Альты' : 'Мемы'}
              </Badge>
            </div>
            <p className="mt-0.5 font-mono text-[11px] leading-4 text-text-muted">
              {trade.setup} · score {Math.round(trade.score)}
            </p>
          </div>

          <div className={`shrink-0 text-right ${phase.color}`}>
            <span className="flex items-center justify-end gap-1 font-sans text-[11px] font-medium leading-4">
              <PhaseIcon className="h-3 w-3" strokeWidth={2} />
              {phase.label}
            </span>
            {trade.pnlPercent != null && (
              <div className="tnum mt-0.5 font-mono text-[13px] font-medium leading-4">
                {trade.pnlPercent >= 0 ? '+' : ''}
                {trade.pnlPercent.toFixed(2)}%
              </div>
            )}
          </div>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
          <div className="bg-bg-base/60 px-2.5 py-1.5">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              Зона / вход
            </div>
            <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-text-primary">
              {trade.zoneLow != null && trade.zoneHigh != null
                ? `${fmt(trade.zoneLow)}–${fmt(trade.zoneHigh)}`
                : fmt(trade.entryPrice)}
            </div>
          </div>
          <div className="bg-bg-base/60 px-2.5 py-1.5">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              SL
            </div>
            <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-market-short">
              {fmt(trade.sl)}
            </div>
          </div>
          <div className="bg-bg-base/60 px-2.5 py-1.5">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              TP1 · 35%
            </div>
            <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-market-long">
              {fmt(tp1)}
            </div>
          </div>
          <div className="bg-bg-base/60 px-2.5 py-1.5">
            <div className="font-sans text-[11px] leading-4 text-text-muted">
              TP2 · 45%
            </div>
            <div className="tnum mt-0.5 truncate font-mono text-[12px] font-medium leading-4 text-market-long">
              {fmt(trade.tp)}
            </div>
          </div>
        </div>

        {trade.target3 != null && (
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-market-info/20 bg-market-info/[0.05] px-2.5 py-1.5">
            <span className="font-sans text-[11px] leading-4 text-market-info/80">
              TP3 runner · 20%
            </span>
            <span className="tnum font-mono text-[11px] font-medium leading-4 text-market-info">
              {fmt(trade.target3)}
            </span>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
          <span className="flex items-center gap-1 font-mono text-[11px] leading-4 text-text-muted">
            <Clock3 className="h-3 w-3" />
            {new Date(trade.createdAt).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {trade.filledAt ? ' · вход исполнен' : ''}
          </span>
          <span className="tnum font-mono text-[11px] leading-4 text-text-muted">
            MFE +{trade.mfePercent.toFixed(2)}% · MAE −
            {trade.maePercent.toFixed(2)}%
          </span>
        </div>

        {trade.outcomeHeadline && trade.status !== 'OPEN' && (
          <div
            className={`mt-2 rounded-md border px-2.5 py-2 ${
              trade.status === 'WIN'
                ? 'border-market-long/20 bg-market-long/[0.05]'
                : trade.status === 'LOSS'
                  ? 'border-market-short/20 bg-market-short/[0.05]'
                  : 'border-border bg-bg-base/40'
            }`}
          >
            <div className="font-sans text-[11px] font-medium leading-4 text-text-secondary">
              Разбор · {trade.outcomeHeadline}
            </div>
            {trade.outcomeDetail && (
              <p className="mt-1 font-sans text-[11px] leading-4 text-text-muted">
                {trade.outcomeDetail}
              </p>
            )}
            {trade.outcomeLesson && (
              <p className="mt-1 font-sans text-[11px] leading-4 text-market-info/80">
                → {trade.outcomeLesson}
              </p>
            )}
            {trade.outcomeTags && trade.outcomeTags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {trade.outcomeTags.slice(0, 5).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] leading-4 text-text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default BotTradeCard
