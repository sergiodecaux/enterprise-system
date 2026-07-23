import type { ConditionalSetup } from '../../engine/setups'

interface Props {
  setups: ConditionalSetup[]
  selectedId: string | null
  watchingIds: Set<string>
  onSelect: (setup: ConditionalSetup) => void
  onWatch: (setup: ConditionalSetup) => void
  onUnwatch?: (setup: ConditionalSetup) => void
  busy?: boolean
}

const statusLabel: Record<string, string> = {
  HYPOTHESIS: 'Гипотеза',
  ARMED: 'Вооружён',
  READY: 'ГОТОВ',
  INVALIDATED: 'Сломан',
  EXPIRED: 'Истёк',
}

const SetupPickerPanel = ({
  setups,
  selectedId,
  watchingIds,
  onSelect,
  onWatch,
  onUnwatch,
  busy,
}: Props) => {
  if (!setups.length) {
    return (
      <div className="rounded-xl border border-hull-border/50 bg-hull/40 p-3">
        <p className="font-mono text-xs text-holo/40">
          Сетапы не найдены — мало данных / нет уровней.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-holo/60">
          Подобранные сетапы
        </div>
        <div className="font-mono text-[9px] text-holo/30">
          {setups.length} шт. · условные + сейчас
        </div>
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {setups.map((s) => {
          const selected = selectedId === s.id
          const watching = watchingIds.has(s.id)
          const sideColor =
            s.side === 'LONG' ? 'text-matrix' : 'text-alert'
          const statusColor =
            s.status === 'READY'
              ? 'text-matrix'
              : s.status === 'ARMED'
                ? 'text-yellow-300'
                : s.status === 'INVALIDATED'
                  ? 'text-alert'
                  : 'text-holo/45'

          return (
            <div
              key={s.id}
              className={`rounded-xl border p-3 transition-colors ${
                selected
                  ? 'border-holo/40 bg-hull-light/30'
                  : 'border-hull-border bg-hull/50'
              }`}
            >
              <div className="mb-1.5 flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs font-bold ${sideColor}`}>
                      {s.side}
                    </span>
                    <span className="font-mono text-[10px] text-holo/40">
                      {s.kind}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-xs font-medium text-holo">
                    {s.title}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-bold text-holo">
                    {Math.round(s.probability)}%
                  </div>
                  <div className={`font-mono text-[9px] font-bold ${statusColor}`}>
                    {statusLabel[s.status] ?? s.status}
                  </div>
                </div>
              </div>

              <p className="mb-2 font-mono text-[10px] leading-relaxed text-holo/45">
                {s.triggerSummary}
              </p>

              <ul className="mb-2 space-y-0.5">
                {s.preconditions.slice(0, 4).map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-1.5 font-mono text-[9px] text-holo/40"
                  >
                    <span>
                      {p.status === 'MET'
                        ? '✓'
                        : p.status === 'FAILED'
                          ? '✗'
                          : '○'}
                    </span>
                    <span>{p.label}</span>
                  </li>
                ))}
              </ul>

              <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-black/25 p-1.5">
                <div className="text-center">
                  <div className="font-mono text-[8px] uppercase text-holo/30">
                    Limit
                  </div>
                  <div className="font-mono text-[10px] text-holo">
                    {s.limitEntry.toPrecision(6)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="font-mono text-[8px] uppercase text-holo/30">
                    TP
                  </div>
                  <div className="font-mono text-[10px] text-matrix/80">
                    {s.target.toPrecision(6)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="font-mono text-[8px] uppercase text-holo/30">
                    Inv
                  </div>
                  <div className="font-mono text-[10px] text-alert/80">
                    {s.invalidation.toPrecision(6)}
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onSelect(s)}
                  className="flex-1 rounded-lg border border-hull-border bg-black/30 py-1.5 font-mono text-[10px] font-bold text-holo hover:bg-hull-light/40"
                >
                  {selected ? 'Выбран' : 'Выбрать'}
                </button>
                <button
                  type="button"
                  disabled={busy || s.status === 'INVALIDATED'}
                  onClick={() =>
                    watching && onUnwatch ? onUnwatch(s) : onWatch(s)
                  }
                  className={`flex-1 rounded-lg py-1.5 font-mono text-[10px] font-bold disabled:opacity-40 ${
                    watching
                      ? 'border border-yellow-400/40 bg-yellow-400/10 text-yellow-300'
                      : 'bg-matrix/20 text-matrix'
                  }`}
                >
                  {watching ? 'Снять watch' : 'Следить'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SetupPickerPanel
