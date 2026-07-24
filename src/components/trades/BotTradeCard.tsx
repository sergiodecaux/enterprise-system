import { Bot, Clock3, TrendingDown, TrendingUp } from 'lucide-react'
import type { BotJournalEntryDto } from '../../api/telegram/botJournal'

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
  emoji: string
  color: string
} {
  if (trade.status === 'OPEN' && !trade.filledAt) {
    return { label: 'ЖДЁТ ВХОД', emoji: '⏳', color: 'text-yellow-300' }
  }
  if (trade.status === 'OPEN') {
    return { label: 'В ПОЗИЦИИ', emoji: '🟢', color: 'text-matrix' }
  }
  if (trade.status === 'WIN') {
    return { label: 'WIN', emoji: '🎯', color: 'text-matrix' }
  }
  if (trade.status === 'BE') {
    return { label: 'BE', emoji: '🛡', color: 'text-sky-300' }
  }
  if (trade.status === 'INVALIDATED') {
    return { label: 'NO ENTRY', emoji: '⏭', color: 'text-holo/50' }
  }
  if (trade.status === 'TIMEOUT') {
    return { label: 'TIMEOUT', emoji: '⏱', color: 'text-yellow-300' }
  }
  return { label: 'LOSS', emoji: '🛑', color: 'text-alert' }
}

const BotTradeCard = ({ trade }: Props) => {
  const isLong = trade.side === 'LONG'
  const phase = phaseOf(trade)
  const DirectionIcon = isLong ? TrendingUp : TrendingDown
  const sideColor = isLong ? 'text-matrix' : 'text-alert'
  const sideBorder = isLong ? 'border-matrix/30' : 'border-alert/30'
  const tp1 = trade.target1 ?? trade.tp

  return (
    <div className={`rounded-xl border ${sideBorder} bg-hull/70 p-3`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Bot className="h-4 w-4 text-sky-300" />
            <span className="font-mono text-sm font-bold text-holo">
              {trade.displayName}
            </span>
            <span className={`flex items-center gap-1 font-mono text-[10px] font-bold ${sideColor}`}>
              <DirectionIcon className="h-3 w-3" />
              {trade.side}
            </span>
            <span className="rounded border border-hull-border px-1.5 py-0.5 font-mono text-[8px] text-holo/45">
              {trade.alertType}
            </span>
          </div>
          <p className="mt-1 font-mono text-[9px] text-holo/40">
            {trade.setup} · score {Math.round(trade.score)}
          </p>
        </div>
        <div className={`shrink-0 text-right font-mono text-[10px] font-bold ${phase.color}`}>
          {phase.emoji} {phase.label}
          {trade.pnlPercent != null && (
            <div className="mt-0.5 text-sm">
              {trade.pnlPercent >= 0 ? '+' : ''}
              {trade.pnlPercent.toFixed(2)}%
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <div className="rounded bg-black/25 p-2">
          <div className="font-mono text-[8px] uppercase text-holo/35">Зона / вход</div>
          <div className="mt-0.5 font-mono text-[10px] font-bold text-holo/80">
            {trade.zoneLow != null && trade.zoneHigh != null
              ? `${fmt(trade.zoneLow)}–${fmt(trade.zoneHigh)}`
              : fmt(trade.entryPrice)}
          </div>
        </div>
        <div className="rounded bg-black/25 p-2">
          <div className="font-mono text-[8px] uppercase text-alert/60">SL</div>
          <div className="mt-0.5 font-mono text-[10px] font-bold text-alert">
            {fmt(trade.sl)}
          </div>
        </div>
        <div className="rounded bg-black/25 p-2">
          <div className="font-mono text-[8px] uppercase text-matrix/60">TP1 · 35%</div>
          <div className="mt-0.5 font-mono text-[10px] font-bold text-matrix">
            {fmt(tp1)}
          </div>
        </div>
        <div className="rounded bg-black/25 p-2">
          <div className="font-mono text-[8px] uppercase text-matrix/60">TP2 · 45%</div>
          <div className="mt-0.5 font-mono text-[10px] font-bold text-matrix">
            {fmt(trade.tp)}
          </div>
        </div>
      </div>

      {trade.target3 != null && (
        <div className="mt-1.5 flex items-center justify-between rounded border border-sky-400/20 bg-sky-500/5 px-2 py-1.5">
          <span className="font-mono text-[9px] text-sky-200/60">
            TP3 runner · 20%
          </span>
          <span className="font-mono text-[10px] font-bold text-sky-200">
            {fmt(trade.target3)}
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-hull-border/40 pt-2">
        <span className="flex items-center gap-1 font-mono text-[8px] text-holo/35">
          <Clock3 className="h-3 w-3" />
          {new Date(trade.createdAt).toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {trade.filledAt ? ' · вход исполнен' : ''}
        </span>
        <span className="font-mono text-[8px] text-holo/40">
          MFE +{trade.mfePercent.toFixed(2)}% · MAE −{trade.maePercent.toFixed(2)}%
        </span>
      </div>
    </div>
  )
}

export default BotTradeCard
