import { useState } from 'react'
import { Activity, History } from 'lucide-react'
import SegmentedControl from '../ui/SegmentedControl'
import { useAppStore } from '../../store/useAppStore'
import { useTradeCopilot } from '../../hooks/useTradeCopilot'
import { useBotJournalSync } from '../../hooks/useBotJournalSync'
import TradeCard from './TradeCard'
import JournalStatsPanel from './JournalStatsPanel'
import BotTradesPanel from './BotTradesPanel'

type TradeFilter = 'ACTIVE' | 'CLOSED' | 'BOT' | 'STATS'

const TradesView = () => {
  const activeTrades = useAppStore((s) => s.activeTrades)
  useTradeCopilot()
  const botJournal = useBotJournalSync(30_000)

  const [filter, setFilter] = useState<TradeFilter>('BOT')

  const filteredTrades =
    filter === 'ACTIVE'
      ? activeTrades.filter(
          (t) =>
            t.status === 'ACTIVE' ||
            t.status === 'BREAKEVEN' ||
            t.status === 'INVALIDATED'
        )
      : filter === 'CLOSED'
        ? activeTrades.filter(
            (t) => t.status === 'CLOSED_WIN' || t.status === 'CLOSED_LOSS'
          )
        : []

  const activeCount = activeTrades.filter(
    (t) =>
      t.status === 'ACTIVE' ||
      t.status === 'BREAKEVEN' ||
      t.status === 'INVALIDATED'
  ).length

  const closedCount = activeTrades.filter(
    (t) => t.status === 'CLOSED_WIN' || t.status === 'CLOSED_LOSS'
  ).length
  const botActiveCount =
    botJournal.payload?.entries.filter((entry) => entry.status === 'OPEN')
      .length ?? 0

  return (
    <div className="flex min-h-full flex-col bg-bg-base pb-6">
      <div className="z-10 border-b border-border bg-bg-base/95 px-3 py-2.5 backdrop-blur-sm min-[1100px]:sticky min-[1100px]:top-0">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="h-4 w-4 shrink-0 text-brand" />
            <h1 className="truncate font-sans text-[15px] font-semibold leading-5 text-text-primary">
              Сделки
            </h1>
          </div>
          <span className="tnum shrink-0 font-mono text-[11px] leading-4 text-text-muted">
            {filter === 'BOT'
              ? `бот · ${botActiveCount}`
              : filter === 'CLOSED'
                ? `архив · ${closedCount}`
                : `актив · ${activeCount}`}
          </span>
        </div>

        <SegmentedControl
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'ACTIVE', label: `Актив ${activeCount}` },
            { value: 'CLOSED', label: `Архив ${closedCount}` },
            { value: 'BOT', label: `Бот ${botActiveCount}` },
            { value: 'STATS', label: 'Lab' },
          ]}
          size="sm"
          stretch
          ariaLabel="Раздел сделок"
          className="w-full"
        />
      </div>

      <div className="flex-1 px-3 pt-3">
        {filter === 'STATS' && <JournalStatsPanel />}
        {filter === 'BOT' && (
          <BotTradesPanel
            payload={botJournal.payload}
            loading={botJournal.loading}
            error={botJournal.error}
            onRefresh={() => void botJournal.refresh()}
          />
        )}

        {filter !== 'STATS' && filter !== 'BOT' && filteredTrades.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-bg-panel/40 px-4 py-10 text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-border bg-bg-elevated text-text-muted">
              {filter === 'ACTIVE' ? (
                <Activity className="h-5 w-5" strokeWidth={1.7} />
              ) : (
                <History className="h-5 w-5" strokeWidth={1.7} />
              )}
            </span>
            <p className="mb-1 font-sans text-[13px] font-medium text-text-secondary">
              {filter === 'ACTIVE' ? 'Нет активных сделок' : 'История пуста'}
            </p>
            <p className="max-w-xs font-sans text-[11px] leading-4 text-text-muted">
              {filter === 'ACTIVE'
                ? 'Откройте сделку из вкладки «Снайпер» или посмотрите Lab — авто-учёт сигналов.'
                : 'Закрытые сделки появятся здесь.'}
            </p>
          </div>
        )}

        {filter !== 'STATS' && filter !== 'BOT' && filteredTrades.length > 0 && (
          <div className="space-y-2">
            {filteredTrades
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((trade) => (
                <TradeCard key={trade.id} trade={trade} />
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default TradesView
