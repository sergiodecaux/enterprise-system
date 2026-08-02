/**
 * Panel for «Найти сигнал»: live tape + primary call + scenario tree + SMC drive.
 */

import type { ConditionalSetup } from '../../engine/setups'
import type {
  LiveScenario,
  LiveSignalResult,
} from '../../engine/trades/findLiveSignal'
import type { LiveMarketRead } from '../../engine/trades/liveMarketRead'

interface Props {
  result: LiveSignalResult | null
  selectedId: string | null
  watchingIds: Set<string>
  busy?: boolean
  onSelectSetup: (setup: ConditionalSetup) => void
  onWatchSetup: (setup: ConditionalSetup) => void
  onSelectScenario: (scenario: LiveScenario) => void
}

function sideColor(side: LiveScenario['side']): string {
  if (side === 'LONG') return 'text-matrix'
  if (side === 'SHORT') return 'text-alert'
  return 'text-holo/50'
}

function kindTag(kind: LiveScenario['kind']): string {
  switch (kind) {
    case 'ZONE_TEST_BOUNCE':
      return 'ТЕСТ ЗОНЫ'
    case 'ZONE_BREAK':
      return 'ПРОБОЙ'
    case 'MM_HUNT':
      return 'SMC HUNT'
    case 'CONTINUATION':
      return 'ПРОДОЛЖЕНИЕ'
    case 'REVERSAL':
      return 'РАЗВОРОТ'
    case 'SEQUENCE_LIMIT':
      return 'ПРЕДЕЛ SEQ'
    case 'WAIT':
      return 'ЖДАТЬ'
    default:
      return kind
  }
}

function reactionTag(r: LiveMarketRead['reaction']): string {
  switch (r) {
    case 'BOUNCE_NO_HOLD':
      return 'ОТСКОК БЕЗ ЗАКРЕПА'
    case 'BOUNCE_HELD':
      return 'ОТСКОК ДЕРЖИТ'
    case 'CONSOLIDATING':
      return 'КРЕПИТСЯ'
    case 'BREAKING':
      return 'СЛОМ ЗОНЫ'
    case 'IN_ZONE_TESTING':
      return 'ТЕСТ ЗОНЫ'
    case 'APPROACHING':
      return 'ПОДХОД'
    case 'EXTENDED':
      return 'ДАЛЕКО'
    default:
      return r
  }
}

function fmtPx(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

const SignalNowPanel = ({
  result,
  selectedId,
  watchingIds,
  busy,
  onSelectSetup,
  onWatchSetup,
  onSelectScenario,
}: Props) => {
  if (!result) return null
  const {
    primary,
    scenarios,
    bestSetup,
    driveNarrative,
    smcLines,
    phaseLabel,
    globalView,
    magnet,
    liveMarket,
    sequence,
  } = result

  const seqLive =
    sequence && sequence.expiresAt > Date.now() ? sequence : null

  return (
    <div className="space-y-2 rounded-xl border border-amber-400/35 bg-amber-500/[0.06] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-amber-200/90">
          Сигнал сейчас
        </div>
        <div className="max-w-[55%] truncate text-right font-mono text-[9px] text-holo/40">
          {phaseLabel}
        </div>
      </div>

      {/* One narrative: now → limit → action */}
      <div className="rounded-lg border border-amber-400/35 bg-black/30 p-2.5">
        <div className="space-y-2">
          {liveMarket && (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[8px] font-bold uppercase tracking-wide text-sky-300/80">
                  1 · Что происходит
                </span>
                <span className="font-mono text-[8px] uppercase text-sky-300/55">
                  {reactionTag(liveMarket.reaction)}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[10px] leading-snug text-holo/75">
                {liveMarket.whatNow}
              </p>
            </div>
          )}

          {seqLive && (
            <div
              className={`rounded border px-2 py-1.5 ${
                seqLive.allowedInRegime
                  ? 'border-cyan-400/35 bg-cyan-500/[0.07]'
                  : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[8px] font-bold uppercase tracking-wide text-cyan-200/85">
                  2 · Предел процесса
                </span>
                <span className="font-mono text-[9px] font-bold text-cyan-300">
                  ~{seqLive.confidence}%
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[10px] leading-snug text-holo/75">
                {seqLive.title}
                {!seqLive.allowedInRegime ? ' · regime off' : ''}
              </p>
              {seqLive.histWr && seqLive.histWr.decided >= 3 && (
                <p className="mt-0.5 font-mono text-[8px] text-holo/40">
                  Journal WR {seqLive.histWr.winRate?.toFixed(0) ?? '—'}% (n=
                  {seqLive.histWr.decided})
                </p>
              )}
            </div>
          )}

          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="font-mono text-[8px] font-bold uppercase tracking-wide text-amber-200/70">
                  {seqLive ? '3' : '2'} · Что делать
                </span>
                <div className="mt-0.5 font-mono text-[9px] uppercase text-amber-200/55">
                  {kindTag(primary.kind)}
                </div>
                <div
                  className={`mt-0.5 font-mono text-[12px] font-bold ${sideColor(primary.side)}`}
                >
                  {primary.side !== 'FLAT' ? `${primary.side} · ` : ''}
                  {primary.title}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[16px] font-bold text-amber-100">
                  {primary.winPct}%
                </div>
              </div>
            </div>
            <p className="mt-1 font-mono text-[10px] leading-snug text-holo/60">
              {primary.summary}
            </p>
            {primary.steps.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {primary.steps.slice(0, 3).map((s) => (
                  <li key={s} className="font-mono text-[9px] text-holo/45">
                    · {s}
                  </li>
                ))}
              </ul>
            )}
            {primary.invalidation && (
              <p className="mt-1 font-mono text-[9px] text-alert/70">
                Инвалидация: {primary.invalidation}
              </p>
            )}
            {bestSetup && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onSelectSetup(bestSetup)
                    onSelectScenario(primary)
                  }}
                  className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-amber-100"
                >
                  На график
                </button>
                <button
                  type="button"
                  disabled={busy || watchingIds.has(bestSetup.id)}
                  onClick={() => onWatchSetup(bestSetup)}
                  className="rounded border border-matrix/40 bg-matrix/10 px-2 py-1 font-mono text-[9px] font-bold uppercase text-matrix"
                >
                  {watchingIds.has(bestSetup.id) ? 'В слежении' : 'В бот'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {liveMarket?.nearestBounce && (
        <div className="rounded-lg border border-sky-400/25 bg-sky-500/[0.05] p-2">
          <div className="font-mono text-[9px] font-bold uppercase text-sky-200/80">
            Ближайший отскок → D1 / W
          </div>
          <div
            className={`mt-0.5 font-mono text-[11px] font-bold ${sideColor(liveMarket.nearestBounce.side)}`}
          >
            {liveMarket.nearestBounce.side} от{' '}
            {liveMarket.nearestBounce.zoneLabel} @{' '}
            {fmtPx(liveMarket.nearestBounce.zoneMid)} · ~
            {liveMarket.nearestBounce.winPct}%
          </div>
          {liveMarket.nearestBounce.targets.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {liveMarket.nearestBounce.targets.map((t) => (
                <span
                  key={`${t.tf}-${t.price}`}
                  className="rounded border border-sky-400/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[8px] text-sky-100/80"
                >
                  {t.tf} {t.side === 'ABOVE' ? '↑' : '↓'} {fmtPx(t.price)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Drive / SMC */}
      <div className="rounded-lg border border-hull-border/50 bg-black/20 p-2">
        <div className="font-mono text-[9px] font-bold uppercase text-holo/50">
          Как гонят цену · Smart Money
        </div>
        <p className="mt-1 font-mono text-[10px] leading-snug text-holo/65">
          {driveNarrative}
        </p>
        {globalView && (
          <p
            className={`mt-1 font-mono text-[9px] ${sideColor(
              globalView.bias === 'BULLISH'
                ? 'LONG'
                : globalView.bias === 'BEARISH'
                  ? 'SHORT'
                  : 'FLAT'
            )}`}
          >
            Глобально: {globalView.bias}
            {magnet ? ` · магнит ${magnet.label}` : ''}
          </p>
        )}
        {smcLines.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {smcLines.slice(0, 5).map((l) => (
              <li key={l} className="font-mono text-[9px] text-holo/40">
                · {l}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Alternatives */}
      {scenarios.length > 1 && (
        <div>
          <div className="mb-1 font-mono text-[9px] font-bold uppercase text-holo/45">
            Варианты развития
          </div>
          <div className="max-h-52 space-y-1.5 overflow-y-auto overscroll-contain">
            {scenarios.map((sc) => {
              const active = sc.id === primary.id
              const setup = sc.setupId
                ? result.trades.find((t) => t.id === sc.setupId)
                : null
              return (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => {
                    onSelectScenario(sc)
                    if (setup) onSelectSetup(setup)
                  }}
                  className={`block w-full rounded-lg border p-2 text-left transition-colors ${
                    active
                      ? 'border-amber-400/45 bg-amber-500/10'
                      : selectedId && setup && selectedId === setup.id
                        ? 'border-sky-400/40 bg-hull-light/40'
                        : 'border-hull-border/50 bg-hull/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] text-holo/40">
                      {kindTag(sc.kind)}
                    </span>
                    <span
                      className={`font-mono text-[11px] font-bold ${sideColor(sc.side)}`}
                    >
                      {sc.winPct}%
                    </span>
                  </div>
                  <div className={`font-mono text-[10px] font-bold ${sideColor(sc.side)}`}>
                    {sc.side !== 'FLAT' ? `${sc.side} · ` : ''}
                    {sc.title}
                  </div>
                  <p className="mt-0.5 line-clamp-2 font-mono text-[9px] text-holo/45">
                    {sc.summary}
                  </p>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default SignalNowPanel
