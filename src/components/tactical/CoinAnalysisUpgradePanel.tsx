/**
 * Unified coin-analysis upgrades: historical WR, what-changed, ready gate,
 * structure vs pressure, playbook, idea status.
 */

import { useMemo } from 'react'
import {
  Activity,
  BookOpen,
  Gauge,
  History,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
} from 'lucide-react'
import type { CoinSignal } from '../../engine/types'
import type { CompositeAnalysis } from '../../engine/composite'
import {
  evaluateIdeaStatus,
  evaluateReadyGate,
  getWhatChanged,
  buildPlaybook,
} from '../../engine/analysis'
import { querySimilarSetups } from '../../engine/journal'
import { classifySmcSetup } from '../../engine/journal/classify'
import type { WorkerMarketContext } from '../../api/marketContext'
import { assetTypeLabel } from '../../i18n/displayMaps'

interface Props {
  signal: CoinSignal
  composite: CompositeAnalysis | null
  workerCtx: WorkerMarketContext | null
  /** bump when journal / snapshots refresh */
  refreshKey?: number
}

function gateColor(status: 'PASS' | 'PENDING' | 'FAIL'): string {
  if (status === 'PASS') return 'text-matrix border-matrix/30 bg-matrix/10'
  if (status === 'FAIL') return 'text-alert border-alert/30 bg-alert/10'
  return 'text-amber-200/90 border-amber-400/30 bg-amber-500/10'
}

function lifeIcon(life: 'ALIVE' | 'WATCH' | 'DEAD') {
  if (life === 'ALIVE') return ShieldCheck
  if (life === 'DEAD') return ShieldAlert
  return ShieldQuestion
}

function lifeClass(life: 'ALIVE' | 'WATCH' | 'DEAD'): string {
  if (life === 'ALIVE') return 'border-matrix/40 bg-matrix/10 text-matrix'
  if (life === 'DEAD') return 'border-alert/40 bg-alert/10 text-alert'
  return 'border-amber-400/40 bg-amber-500/10 text-amber-200'
}

function fmtPx(p: number | null): string {
  if (p == null || !(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

const CoinAnalysisUpgradePanel = ({
  signal,
  composite,
  workerCtx,
  refreshKey = 0,
}: Props) => {
  const classified = useMemo(() => classifySmcSetup(signal), [signal])
  const hist = useMemo(
    () =>
      querySimilarSetups({
        internalSymbol: signal.internalSymbol,
        direction: signal.direction,
        setupType: classified.setupType,
        tradeStyle: signal.tradeStyle ?? null,
        windowMs: 30 * 24 * 60 * 60 * 1000,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      signal.internalSymbol,
      signal.direction,
      classified.setupType,
      signal.tradeStyle,
      refreshKey,
    ]
  )

  const changed = useMemo(
    () => getWhatChanged(signal.internalSymbol, 20 * 60_000),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signal.internalSymbol, signal.probabilityPct, signal.scoreCard?.grade, signal.surgicalEntry?.status, signal.mmIntent?.preferredSide, refreshKey]
  )

  const gate = useMemo(() => evaluateReadyGate(signal), [signal])
  const idea = useMemo(() => evaluateIdeaStatus(signal), [signal])
  const playbook = useMemo(() => buildPlaybook(signal), [signal])

  const technical = composite?.confluenceBreakdown.technical
  const orderFlow = composite?.confluenceBreakdown.orderFlow
  const LifeIcon = lifeIcon(idea.life)

  const base = signal.internalSymbol.split('/')[0]?.toUpperCase() ?? ''
  const coinNews = workerCtx?.coinNews?.[base]

  return (
    <div className="space-y-3">
      {/* Idea status + historical WR */}
      <div className="grid grid-cols-2 gap-2">
        <div className={`rounded-xl border px-3 py-2.5 ${lifeClass(idea.life)}`}>
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wide opacity-80">
            <LifeIcon className="h-3.5 w-3.5" />
            Статус идеи
          </div>
          <div className="font-mono text-sm font-bold">{idea.label}</div>
          <div className="mt-0.5 font-mono text-[10px] opacity-80 leading-snug">
            {idea.reason}
          </div>
          {idea.invalidationPrice != null && (
            <div className="mt-1.5 font-mono text-[10px] opacity-70">
              Invalidation: {fmtPx(idea.invalidationPrice)}
              {idea.invalidationMessage
                ? ` · ${idea.invalidationMessage.slice(0, 42)}`
                : ''}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-hull-border bg-hull/40 px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wide text-holo/45">
            <History className="h-3.5 w-3.5" />
            История 30д
          </div>
          {hist.winRate != null ? (
            <>
              <div className="font-mono text-sm font-bold text-holo">
                Hist WR {hist.winRate.toFixed(0)}%
                <span className="ml-1 text-[10px] font-normal text-holo/45">
                  ({hist.wins}W/{hist.losses}L)
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-holo/50">
                {hist.avgR != null ? `avg R ${hist.avgR.toFixed(2)} · ` : ''}
                {hist.sample === 'GLOBAL' ? 'глоб. похожие' : 'эта монета'}
              </div>
            </>
          ) : (
            <div className="font-mono text-xs text-holo/45">
              Мало сделок в журнале
              {hist.open > 0 ? ` · open ${hist.open}` : ''}
            </div>
          )}
        </div>
      </div>

      {/* Ready gate */}
      <div className="rounded-xl border border-hull-border bg-hull/30 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
            <Gauge className="h-3.5 w-3.5" />
            Gate перед READY
          </div>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
              gate.ready
                ? 'bg-matrix/20 text-matrix'
                : 'bg-holo/10 text-holo/50'
            }`}
          >
            {gate.passCount}/{gate.needCount}
          </span>
        </div>
        <p className="mb-2 font-mono text-[11px] text-holo/60">{gate.summary}</p>
        <div className="space-y-1.5">
          {gate.items.map((item) => (
            <div
              key={item.id}
              className={`flex items-start justify-between gap-2 rounded-lg border px-2 py-1.5 ${gateColor(item.status)}`}
            >
              <div>
                <div className="font-mono text-[10px] font-bold uppercase">
                  {item.label}
                </div>
                <div className="font-mono text-[10px] opacity-85">
                  {item.detail}
                </div>
              </div>
              <span className="shrink-0 font-mono text-[9px] font-bold">
                {item.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Structure vs pressure */}
      {(technical || orderFlow) && (
        <div className="rounded-xl border border-hull-border bg-hull/30 p-3">
          <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
            <Activity className="h-3.5 w-3.5" />
            Структура vs давление
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-sky-400/25 bg-sky-500/5 px-2.5 py-2">
              <div className="font-mono text-[9px] uppercase text-sky-200/70">
                Структура (HTF)
              </div>
              <div className="font-mono text-lg font-bold text-sky-100">
                {technical?.score ?? '—'}
                <span className="text-[10px] text-holo/40">/100</span>
              </div>
              <div className="font-mono text-[10px] text-holo/50 leading-snug">
                {technical?.factors?.[0] ?? 'SMC / HTF / Fib'}
              </div>
            </div>
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/5 px-2.5 py-2">
              <div className="font-mono text-[9px] uppercase text-amber-200/70">
                Микро-давление
              </div>
              <div className="font-mono text-lg font-bold text-amber-100">
                {orderFlow?.score ?? '—'}
                <span className="text-[10px] text-holo/40">/100</span>
              </div>
              <div className="font-mono text-[10px] text-holo/50 leading-snug">
                {orderFlow?.factors?.[0] ??
                  signal.mmIntent?.label ??
                  'стакан / MM / лента'}
              </div>
            </div>
          </div>
          {workerCtx && (
            <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[9px] text-holo/45">
              {workerCtx.btcDominance != null && (
                <span className="rounded border border-hull-border px-1.5 py-0.5">
                  BTC.D {workerCtx.btcDominance.toFixed(1)}%
                  {workerCtx.btcDomDelta24h != null
                    ? ` ${workerCtx.btcDomDelta24h >= 0 ? '+' : ''}${workerCtx.btcDomDelta24h.toFixed(2)}пп`
                    : ''}
                </span>
              )}
              {(workerCtx.total3Usd != null || workerCtx.total3Delta24h != null) && (
                <span className="rounded border border-hull-border px-1.5 py-0.5">
                  TOTAL3{' '}
                  {workerCtx.total3Delta24h != null
                    ? `${workerCtx.total3Delta24h >= 0 ? '+' : ''}${workerCtx.total3Delta24h.toFixed(1)}%`
                    : 'ex BTC+ETH'}
                </span>
              )}
              {workerCtx.altBias && workerCtx.altBias !== 'NEUTRAL' && (
                <span
                  className={`rounded border px-1.5 py-0.5 ${
                    workerCtx.altBias === 'LONG'
                      ? 'border-emerald-400/30 text-emerald-300'
                      : 'border-rose-400/30 text-rose-300'
                  }`}
                >
                  {workerCtx.altBias === 'LONG' ? 'лонг альты' : 'шорт альты'}
                </span>
              )}
              {workerCtx.fearGreed != null && (
                <span className="rounded border border-hull-border px-1.5 py-0.5">
                  F&G {workerCtx.fearGreed}
                </span>
              )}
              {coinNews && (
                <span className="rounded border border-hull-border px-1.5 py-0.5">
                  News {coinNews.label}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* What changed */}
      {changed && (
        <div className="rounded-xl border border-hull-border bg-hull/30 p-3">
          <div className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
            Что изменилось · ~{changed.ageMin} мин
          </div>
          {changed.lines.length === 0 ? (
            <p className="font-mono text-[11px] text-holo/45">{changed.summary}</p>
          ) : (
            <ul className="space-y-1">
              {changed.lines.map((l) => (
                <li
                  key={l.id}
                  className="font-mono text-[11px] text-holo/70"
                >
                  <span className="text-holo/40">{l.label}:</span> {l.from} →{' '}
                  <span
                    className={
                      l.tone === 'up'
                        ? 'text-matrix'
                        : l.tone === 'down'
                          ? 'text-alert'
                          : l.tone === 'warn'
                            ? 'text-amber-300'
                            : 'text-holo'
                    }
                  >
                    {l.to}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Playbook */}
      <div className="rounded-xl border border-hull-border bg-hull/30 p-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-holo/50">
            <BookOpen className="h-3.5 w-3.5" />
            Playbook
          </div>
          <span className="font-mono text-[10px] font-bold text-holo/60">
            {assetTypeLabel[playbook.assetType]} · {playbook.setupLabel}
          </span>
        </div>
        <p className="mb-2 font-mono text-[11px] text-holo/70">
          {playbook.headline}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 font-mono text-[9px] uppercase text-matrix/70">
              Следить
            </div>
            <ul className="space-y-0.5">
              {playbook.focus.map((f) => (
                <li key={f} className="font-mono text-[10px] text-holo/65">
                  · {f}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 font-mono text-[9px] uppercase text-alert/70">
              Избегать
            </div>
            <ul className="space-y-0.5">
              {playbook.avoid.map((f) => (
                <li key={f} className="font-mono text-[10px] text-holo/65">
                  · {f}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {playbook.tradeStyle && (
          <div className="mt-2 font-mono text-[10px] text-holo/40">
            Стиль: {playbook.tradeStyle} · тег {playbook.setupTag}
          </div>
        )}
      </div>
    </div>
  )
}

export default CoinAnalysisUpgradePanel
