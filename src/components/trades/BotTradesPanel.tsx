import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { BotJournalPayload } from '../../api/telegram/botJournal'
import BotTradeCard from './BotTradeCard'

interface Props {
  payload: BotJournalPayload | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

const BotTradesPanel = ({ payload, loading, error, onRefresh }: Props) => {
  const [tab, setTab] = useState<'ACTIVE' | 'HISTORY'>('ACTIVE')
  const entries = payload?.entries ?? []
  const active = useMemo(
    () =>
      entries
        .filter((entry) => entry.status === 'OPEN')
        .sort((a, b) => b.createdAt - a.createdAt),
    [entries]
  )
  const history = useMemo(
    () =>
      entries
        .filter((entry) => entry.status !== 'OPEN')
        .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt)),
    [entries]
  )
  const shown = tab === 'ACTIVE' ? active : history

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-sky-400/25 bg-sky-500/[0.06] p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-xs font-bold uppercase text-sky-200">
              Сделки бота
            </div>
            <p className="mt-1 font-mono text-[9px] leading-relaxed text-holo/45">
              Синхронизация с Worker каждые 30 секунд. TP2 — основной результат,
              TP3 — остаток позиции.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-lg border border-sky-400/30 bg-sky-500/10 p-2 text-sky-200 disabled:opacity-40"
            aria-label="Обновить сделки бота"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-black/20 p-2">
            <div className="font-mono text-base font-bold text-yellow-300">
              {active.filter((entry) => !entry.filledAt).length}
            </div>
            <div className="font-mono text-[8px] uppercase text-holo/35">Ждут зону</div>
          </div>
          <div className="rounded bg-black/20 p-2">
            <div className="font-mono text-base font-bold text-matrix">
              {active.filter((entry) => Boolean(entry.filledAt)).length}
            </div>
            <div className="font-mono text-[8px] uppercase text-holo/35">В позиции</div>
          </div>
          <div className="rounded bg-black/20 p-2">
            <div className="font-mono text-base font-bold text-holo/70">
              {history.length}
            </div>
            <div className="font-mono text-[8px] uppercase text-holo/35">Закрыто</div>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('ACTIVE')}
          className={`flex-1 rounded-lg border px-3 py-2 font-mono text-[10px] font-bold uppercase ${
            tab === 'ACTIVE'
              ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
              : 'border-hull-border bg-hull text-holo/40'
          }`}
        >
          Активные ({active.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('HISTORY')}
          className={`flex-1 rounded-lg border px-3 py-2 font-mono text-[10px] font-bold uppercase ${
            tab === 'HISTORY'
              ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
              : 'border-hull-border bg-hull text-holo/40'
          }`}
        >
          История ({history.length})
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-alert/30 bg-alert/5 p-2 font-mono text-[10px] text-alert">
          {error}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="py-10 text-center">
          <div className="text-4xl opacity-25">🤖</div>
          <p className="mt-2 font-mono text-xs text-holo/45">
            {loading
              ? 'Загружаю сделки бота…'
              : tab === 'ACTIVE'
                ? 'Сейчас нет активных сделок бота'
                : 'История бота пока пуста'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((trade) => (
            <BotTradeCard key={trade.id} trade={trade} />
          ))}
        </div>
      )}
    </div>
  )
}

export default BotTradesPanel
