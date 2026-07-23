import { useState } from 'react'
import {
  BarChart3,
  Flame,
  TrendingUp,
  Lightbulb,
  Trash2,
  Clock,
  Bot,
  RefreshCw,
} from 'lucide-react'
import {
  clearJournal,
  SETUP_LABELS,
  type ImprovementInsight,
  type SignalJournalEntry,
} from '../../engine/journal'
import {
  useJournalAnalytics,
  useJournalEntries,
} from '../../hooks/useSignalJournalResolver'
import { useBotJournalSync } from '../../hooks/useBotJournalSync'
import { useAppStore } from '../../store/useAppStore'

const severityStyle: Record<
  ImprovementInsight['severity'],
  string
> = {
  HIGH: 'border-alert/50 bg-alert/10 text-alert',
  MEDIUM: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300',
  LOW: 'border-holo/30 bg-hull text-holo/60',
  POSITIVE: 'border-matrix/40 bg-matrix/10 text-matrix',
}

const outcomeLabel = (e: SignalJournalEntry): string => {
  switch (e.status) {
    case 'WIN':
      return 'WIN'
    case 'LOSS':
      return 'LOSS'
    case 'TIMEOUT':
      return 'TIMEOUT'
    case 'MANUAL':
      return 'MANUAL'
    case 'INVALIDATED':
      return 'INV'
    default:
      return 'OPEN'
  }
}

const outcomeColor = (e: SignalJournalEntry): string => {
  if (e.status === 'WIN') return 'text-matrix'
  if (e.status === 'LOSS' || e.status === 'INVALIDATED') return 'text-alert'
  if (e.status === 'TIMEOUT') return 'text-yellow-400'
  if (e.status === 'OPEN') return 'text-holo/50'
  return 'text-holo/70'
}

const JournalStatsPanel = () => {
  const analytics = useJournalAnalytics()
  const entries = useJournalEntries()
  const bump = useAppStore((s) => s.bumpJournalVersion)
  const { payload: bot, loading: botLoading, refresh: refreshBot } =
    useBotJournalSync()
  const [tab, setTab] = useState<'bot' | 'overview' | 'setups' | 'log'>('bot')

  const handleClear = () => {
    if (!window.confirm('Очистить журнал сигналов? Статистика обнулится.')) return
    clearJournal()
    bump()
  }

  const botA = bot?.analytics
  const gates = bot?.gates

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-matrix" />
            <h2 className="font-mono text-lg font-bold uppercase text-holo">
              Лаборатория сигналов
            </h2>
          </div>
          <p className="font-mono text-[10px] text-holo/40">
            Бот 24/7 + Mini App · TP/SL · адаптивные фильтры сканера
          </p>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => void refreshBot()}
            className="rounded-lg border border-hull-border p-2 text-holo/40 hover:border-matrix/40 hover:text-matrix"
            title="Обновить статистику бота"
          >
            <RefreshCw
              className={`h-4 w-4 ${botLoading ? 'animate-spin' : ''}`}
            />
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-lg border border-hull-border p-2 text-holo/40 hover:border-alert/40 hover:text-alert"
            title="Очистить локальный журнал Mini App"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {botA && (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Bot className="h-4 w-4 text-sky-300" />
            <span className="font-mono text-xs font-bold uppercase text-sky-300">
              Статистика бота (cron)
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label="Bot WR"
              value={`${botA.winRate.toFixed(0)}%`}
              sub={`${botA.wins}W / ${botA.losses}L`}
              accent="text-sky-300"
            />
            <StatTile
              label="Avg R"
              value={`${botA.avgR >= 0 ? '+' : ''}${botA.avgR.toFixed(2)}R`}
              sub={`PnL ${botA.avgPnl.toFixed(1)}%`}
              accent={botA.avgR >= 0 ? 'text-matrix' : 'text-alert'}
            />
            <StatTile
              label="Sample"
              value={`${botA.resolved}`}
              sub={`${botA.open} open · ${botA.timeouts} TO`}
              accent="text-holo/70"
            />
            <StatTile
              label="Gates"
              value={gates ? String(gates.minMemeScore) : '—'}
              sub={
                gates
                  ? `meme≥${gates.minMemeScore} · block ${gates.blockedSetups.length}`
                  : 'waiting'
              }
              accent="text-yellow-300"
            />
          </div>
          {gates && (gates.blockedSetups.length > 0 || gates.boostedSetups.length > 0) && (
            <div className="mt-2 font-mono text-[10px] text-holo/45">
              {gates.blockedSetups.length > 0 && (
                <div>Блок: {gates.blockedSetups.join(', ')}</div>
              )}
              {gates.boostedSetups.length > 0 && (
                <div className="text-matrix/70">
                  Boost: {gates.boostedSetups.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="App WR"
          value={`${analytics.winRate.toFixed(0)}%`}
          sub={`${analytics.wins}W / ${analytics.losses}L`}
          accent="text-matrix"
        />
        <StatTile
          label="Expectancy"
          value={`${analytics.expectancyR >= 0 ? '+' : ''}${analytics.expectancyR.toFixed(2)}R`}
          sub={`avg R ${analytics.avgR.toFixed(2)}`}
          accent={
            analytics.expectancyR >= 0 ? 'text-matrix' : 'text-alert'
          }
        />
        <StatTile
          label="Profit Factor"
          value={analytics.profitFactor.toFixed(2)}
          sub={`PnL ${analytics.avgPnl.toFixed(1)}%`}
          accent="text-holo"
        />
        <StatTile
          label="App Sample"
          value={`${analytics.resolved}`}
          sub={`${analytics.open} open · ${analytics.timeouts} TO`}
          accent="text-holo/70"
        />
      </div>

      <div className="flex gap-2">
        {(
          [
            { id: 'bot' as const, label: 'Бот' },
            { id: 'overview' as const, label: 'App' },
            { id: 'setups' as const, label: 'Сетапы' },
            { id: 'log' as const, label: 'Лог' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-2 py-2 font-mono text-[10px] font-bold uppercase ${
              tab === t.id
                ? 'border border-matrix/50 bg-matrix/15 text-matrix'
                : 'border border-hull-border bg-hull text-holo/40'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'bot' && (
        <div className="space-y-3">
          {!botA && (
            <p className="rounded-lg border border-hull-border bg-hull/50 p-4 text-center font-mono text-xs text-holo/40">
              Журнал бота ещё пуст или worker недоступен. После алертов в Telegram
              сюда подтянутся WIN/LOSS и адаптивные пороги.
            </p>
          )}
          {botA?.insights.map((ins) => (
            <div
              key={ins.id}
              className={`rounded-lg border p-3 ${severityStyle[ins.severity]}`}
            >
              <div className="mb-1 flex items-center gap-2">
                {ins.severity === 'POSITIVE' ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <Lightbulb className="h-3.5 w-3.5" />
                )}
                <span className="font-mono text-xs font-bold">{ins.title}</span>
              </div>
              <p className="font-mono text-[11px] leading-relaxed opacity-80">
                {ins.detail}
              </p>
            </div>
          ))}
          {botA && botA.bySetup.length > 0 && (
            <div className="space-y-2">
              <div className="font-mono text-[10px] uppercase text-holo/40">
                Сетапы бота
              </div>
              {botA.bySetup.map((s) => (
                <div
                  key={s.setup}
                  className="rounded-lg border border-hull-border bg-hull/40 px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-holo">
                      {s.setup}
                    </span>
                    <span
                      className={`font-mono text-xs font-bold ${
                        s.winRate >= 55 ? 'text-matrix' : 'text-alert'
                      }`}
                    >
                      {s.winRate.toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-holo/40">
                    {s.wins}W/{s.losses}L · {s.expectancyR.toFixed(2)}R · MAE{' '}
                    {s.avgMae.toFixed(1)}%
                  </div>
                </div>
              ))}
            </div>
          )}
          {bot?.entries && bot.entries.length > 0 && (
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {bot.entries.slice(0, 40).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between rounded border border-hull-border/40 bg-black/20 px-2 py-1.5 font-mono text-[10px]"
                >
                  <span className="text-holo/70">
                    {e.displayName} {e.side} · {e.setup}
                  </span>
                  <span
                    className={
                      e.status === 'WIN'
                        ? 'text-matrix'
                        : e.status === 'LOSS'
                          ? 'text-alert'
                          : e.status === 'TIMEOUT'
                            ? 'text-yellow-400'
                            : 'text-holo/40'
                    }
                  >
                    {e.status}
                    {e.pnlPercent != null
                      ? ` ${e.pnlPercent >= 0 ? '+' : ''}${e.pnlPercent.toFixed(1)}%`
                      : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-3">
          {analytics.insights.length === 0 && (
            <p className="rounded-lg border border-hull-border bg-hull/50 p-4 text-center font-mono text-xs text-holo/40">
              Пока мало данных. Держи Meme Radar / Снайпер включёнными — сигналы
              пишутся в журнал автоматически.
            </p>
          )}
          {analytics.insights.map((ins) => (
            <div
              key={ins.id}
              className={`rounded-lg border p-3 ${severityStyle[ins.severity]}`}
            >
              <div className="mb-1 flex items-center gap-2">
                {ins.severity === 'POSITIVE' ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <Lightbulb className="h-3.5 w-3.5" />
                )}
                <span className="font-mono text-xs font-bold">{ins.title}</span>
              </div>
              <p className="font-mono text-[11px] leading-relaxed opacity-80">
                {ins.detail}
              </p>
            </div>
          ))}

          {analytics.byConfidence.some((b) => b.total > 0) && (
            <div className="rounded-lg border border-hull-border bg-hull/40 p-3">
              <div className="mb-2 font-mono text-[10px] uppercase text-holo/40">
                Confidence → реальность
              </div>
              <div className="space-y-1.5">
                {analytics.byConfidence
                  .filter((b) => b.total > 0)
                  .map((b) => (
                    <div
                      key={b.label}
                      className="flex items-center justify-between font-mono text-[11px]"
                    >
                      <span className="text-holo/50">{b.label}</span>
                      <span className="text-holo/70">
                        n={b.total} · WR{' '}
                        <span
                          className={
                            b.winRate >= 55 ? 'text-matrix' : 'text-alert'
                          }
                        >
                          {b.winRate.toFixed(0)}%
                        </span>
                        {' · '}
                        {b.avgR.toFixed(2)}R
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {analytics.bySource.length > 0 && (
            <div className="rounded-lg border border-hull-border bg-hull/40 p-3">
              <div className="mb-2 font-mono text-[10px] uppercase text-holo/40">
                Источник
              </div>
              {analytics.bySource.map((s) => (
                <div
                  key={s.source}
                  className="flex justify-between font-mono text-[11px] text-holo/70"
                >
                  <span>{s.source}</span>
                  <span>
                    {s.total} · WR {s.winRate.toFixed(0)}% · {s.avgR.toFixed(2)}R
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'setups' && (
        <div className="space-y-2">
          {analytics.bySetup.length === 0 && (
            <p className="text-center font-mono text-xs text-holo/40">
              Нет сетапов в журнале
            </p>
          )}
          {analytics.bySetup.map((s) => (
            <div
              key={s.setupType}
              className="rounded-lg border border-hull-border bg-hull/50 p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Flame className="h-3.5 w-3.5 text-alert/70" />
                  <span className="font-mono text-xs font-bold text-holo">
                    {SETUP_LABELS[s.setupType]}
                  </span>
                </div>
                <span
                  className={`font-mono text-sm font-bold ${
                    s.winRate >= 55 ? 'text-matrix' : 'text-alert'
                  }`}
                >
                  {s.winRate.toFixed(0)}%
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1 font-mono text-[10px] text-holo/50">
                <span>
                  {s.wins}W/{s.losses}L/{s.timeouts}TO
                </span>
                <span>E[R] {s.expectancyR.toFixed(2)}</span>
                <span>conf {s.avgConfidence.toFixed(0)}%</span>
                <span>MFE {s.avgMfe.toFixed(1)}%</span>
                <span>MAE {s.avgMae.toFixed(1)}%</span>
                <span>n={s.total}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hull-border">
                <div
                  className={`h-full ${
                    s.winRate >= 55 ? 'bg-matrix' : 'bg-alert'
                  }`}
                  style={{ width: `${Math.min(100, s.winRate)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'log' && (
        <div className="space-y-2">
          {entries.length === 0 && (
            <p className="text-center font-mono text-xs text-holo/40">
              Журнал пуст
            </p>
          )}
          {[...entries]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 40)
            .map((e) => (
              <div
                key={e.id}
                className="rounded-lg border border-hull-border bg-hull/40 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs font-bold text-holo">
                      {e.displayName}{' '}
                      <span
                        className={
                          e.direction === 'LONG' ? 'text-matrix' : 'text-alert'
                        }
                      >
                        {e.direction}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-holo/40">
                      {SETUP_LABELS[e.setupType]} · {e.confidenceAtSignal}% ·{' '}
                      {e.source}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`font-mono text-xs font-bold ${outcomeColor(e)}`}
                    >
                      {outcomeLabel(e)}
                    </div>
                    {e.pnlPercent != null && (
                      <div className="font-mono text-[10px] text-holo/50">
                        {e.pnlPercent >= 0 ? '+' : ''}
                        {e.pnlPercent.toFixed(1)}% ·{' '}
                        {e.rMultiple?.toFixed(2) ?? '—'}R
                      </div>
                    )}
                    {e.status === 'OPEN' && (
                      <div className="flex items-center justify-end gap-1 font-mono text-[9px] text-holo/35">
                        <Clock className="h-2.5 w-2.5" />
                        MFE {e.mfePercent.toFixed(1)}% / MAE{' '}
                        {e.maePercent.toFixed(1)}%
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub: string
  accent: string
}) {
  return (
    <div className="rounded-lg border border-hull-border bg-hull/60 px-3 py-2">
      <div className="font-mono text-[9px] uppercase text-holo/40">{label}</div>
      <div className={`font-mono text-xl font-bold ${accent}`}>{value}</div>
      <div className="font-mono text-[9px] text-holo/35">{sub}</div>
    </div>
  )
}

export default JournalStatsPanel
