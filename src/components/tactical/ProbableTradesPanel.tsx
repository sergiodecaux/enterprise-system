/**
 * Ranked probable trades: win%, path ladder 1R/2R/3R, magnet, global bias.
 */

import type { ConditionalSetup, TradeGlobalView, TradeMagnet } from '../../engine/setups'

interface Props {
  trades: ConditionalSetup[]
  globalView: TradeGlobalView | null
  magnet: TradeMagnet | null
  selectedId: string | null
  watchingIds: Set<string>
  onSelect: (setup: ConditionalSetup) => void
  onWatch: (setup: ConditionalSetup) => void
  busy?: boolean
}

function fmt(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

const biasColor = (b: TradeGlobalView['bias']) =>
  b === 'BULLISH'
    ? 'text-matrix'
    : b === 'BEARISH'
      ? 'text-alert'
      : 'text-holo/50'

const ProbableTradesPanel = ({
  trades,
  globalView,
  magnet,
  selectedId,
  watchingIds,
  onSelect,
  onWatch,
  busy,
}: Props) => {
  if (!trades.length && !globalView) return null

  return (
    <div className="space-y-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-sky-300/90">
          Вероятные сделки
        </div>
        <div className="font-mono text-[9px] text-holo/35">
          {trades.length} шт. ·{' '}
          {trades[0]?.tradeStyle === 'SCALP'
            ? '#SCALP'
            : trades[0]?.tradeStyle === 'SWING'
              ? '#SWING'
              : '#INTRA'}{' '}
          · 1R/2R/3R · бот
        </div>
      </div>

      {globalView && (
        <div className="rounded-lg border border-hull-border/50 bg-black/25 p-2">
          <div className={`font-mono text-[10px] font-bold ${biasColor(globalView.bias)}`}>
            Глобально: {globalView.bias}
          </div>
          <p className="mt-0.5 font-mono text-[10px] leading-snug text-holo/55">
            {globalView.summary}
          </p>
          {magnet && (
            <p className="mt-1 font-mono text-[9px] text-amber-200/80">
              Магнит рынка: {magnet.label} @ {fmt(magnet.price)}
            </p>
          )}
          {globalView.factors.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {globalView.factors.slice(0, 4).map((f) => (
                <li key={f} className="font-mono text-[9px] text-holo/40">
                  · {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
        {trades.map((s, idx) => {
          const selected = selectedId === s.id
          const watching = watchingIds.has(s.id)
          const ladder = s.targetsLadder
          const sideColor = s.side === 'LONG' ? 'text-matrix' : 'text-alert'
          return (
            <div
              key={s.id}
              className={`rounded-lg border p-2.5 transition-colors ${
                selected
                  ? 'border-sky-400/50 bg-hull-light/40'
                  : 'border-hull-border/60 bg-hull/40'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(s)}
                className="w-full text-left"
              >
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[9px] text-holo/30">
                        #{idx + 1}
                      </span>
                      <span className={`font-mono text-xs font-bold ${sideColor}`}>
                        {s.side}
                      </span>
                      <span className="font-mono text-[9px] text-holo/35">
                        {s.tradeStyle === 'SCALP'
                          ? '#SCALP'
                          : s.tradeStyle === 'SWING'
                            ? '#SWING'
                            : '#INTRA'}{' '}
                        · {s.kind}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] font-medium text-holo">
                      {s.title}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm font-bold text-sky-200">
                      {Math.round(s.probability)}%
                    </div>
                    <div className="font-mono text-[8px] uppercase text-holo/30">
                      P(win)
                    </div>
                  </div>
                </div>

                {ladder && (
                  <div className="mb-1.5 grid grid-cols-3 gap-1 rounded-md bg-black/30 p-1.5">
                    <div className="text-center">
                      <div className="font-mono text-[8px] text-holo/30">1R</div>
                      <div className="font-mono text-[10px] text-holo">
                        {fmt(ladder.r1)}
                      </div>
                      <div className="font-mono text-[8px] text-sky-300/70">
                        ~{ladder.pReach1}%
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="font-mono text-[8px] text-holo/30">2R</div>
                      <div className="font-mono text-[10px] text-matrix/90">
                        {fmt(ladder.r2)}
                      </div>
                      <div className="font-mono text-[8px] text-sky-300/70">
                        ~{ladder.pReach2}%
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="font-mono text-[8px] text-holo/30">3R</div>
                      <div className="font-mono text-[10px] text-amber-200/90">
                        {fmt(ladder.r3)}
                      </div>
                      <div className="font-mono text-[8px] text-sky-300/70">
                        ~{ladder.pReach3}%
                      </div>
                    </div>
                  </div>
                )}

                {s.magnet && (
                  <p className="mb-1 font-mono text-[9px] text-amber-200/70">
                    → {s.magnet.label} @ {fmt(s.magnet.price)}
                  </p>
                )}

                <ul className="mb-1.5 space-y-0.5">
                  {s.reasoning.slice(0, 3).map((r) => (
                    <li key={r} className="font-mono text-[9px] text-holo/40">
                      · {r}
                    </li>
                  ))}
                </ul>

                <div className="grid grid-cols-3 gap-1 font-mono text-[9px] text-holo/45">
                  <span>In {fmt(s.limitEntry)}</span>
                  <span className="text-alert/70">SL {fmt(s.invalidation)}</span>
                  <span className="text-matrix/70">TP2 {fmt(s.target)}</span>
                </div>
              </button>

              <button
                type="button"
                disabled={busy || s.status === 'INVALIDATED'}
                onClick={() => onWatch(s)}
                className={`mt-2 w-full rounded-lg py-1.5 font-mono text-[10px] font-bold disabled:opacity-40 ${
                  watching
                    ? 'border border-yellow-400/40 bg-yellow-400/10 text-yellow-300'
                    : 'bg-sky-500/20 text-sky-200'
                }`}
              >
                {watching ? 'В боте ✓' : 'В бот'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default ProbableTradesPanel
