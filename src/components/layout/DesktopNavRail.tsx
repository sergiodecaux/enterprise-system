import { Bot, Keyboard } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useAdvisorStore } from '../../store/useAdvisorStore'
import { WORKSPACES, type WorkspaceId } from './workspaces'

interface Props {
  activeTab: WorkspaceId
  onSelect: (tab: WorkspaceId) => void
}

/** Узкий вертикальный рельс навигации ПК-терминала. */
const DesktopNavRail = ({ activeTab, onSelect }: Props) => {
  const signals = useAppStore((s) => s.signals)
  const activeTrades = useAppStore((s) => s.activeTrades)
  const radarRows = useAppStore((s) => s.radar141Rows)
  const isScanning = useAppStore((s) => s.isScanning)
  const setAdvisorOpen = useAdvisorStore((s) => s.setOpen)

  const badges: Partial<Record<WorkspaceId, number>> = {
    sniper: signals.filter((s) => s.hasActiveSetup).length,
    trades: activeTrades.filter((t) =>
      t.status === 'ACTIVE' || t.status === 'BREAKEVEN' || t.status === 'PARTIAL_CLOSE'
    ).length,
    radar: radarRows.filter(
      (r) => r.trigger === 'INSIDE_141' || r.trigger === 'EXIT_141'
    ).length,
  }

  return (
    <nav
      aria-label="Разделы терминала"
      className="flex w-[76px] shrink-0 flex-col border-r border-hull-border/80 bg-hull/35"
    >
      <div className="px-2 pb-1 pt-3 text-center">
        <span className="font-sans text-[8px] font-semibold uppercase tracking-[0.22em] text-holo/25">
          Разделы
        </span>
      </div>

      <div className="flex flex-col gap-1 px-2 py-1">
        {WORKSPACES.map(({ id, label, hint, icon: Icon, shortcut }) => {
          const active = activeTab === id
          const badge = badges[id] ?? 0
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-current={active ? 'page' : undefined}
              title={`${label} — ${hint} (${shortcut})`}
              className={`group relative flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2.5 transition-colors ${
                active
                  ? 'bg-matrix/[0.09] text-matrix'
                  : 'text-holo/40 hover:bg-white/[0.045] hover:text-holo/75'
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 rounded-full bg-matrix shadow-[0_0_12px_rgba(44,224,138,0.75)]" />
              )}

              <span
                className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                  active
                    ? 'border border-matrix/25 bg-matrix/10 shadow-[0_0_18px_-8px_rgba(44,224,138,0.9)]'
                    : 'border border-transparent group-hover:border-hull-border/70 group-hover:bg-hull-light/50'
                }`}
              >
                <Icon className="h-[17px] w-[17px]" strokeWidth={1.9} />
                {badge > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex min-w-[15px] items-center justify-center rounded-full border border-space bg-matrix px-1 font-mono text-[8px] font-bold leading-[13px] text-space">
                    {badge > 99 ? '99' : badge}
                  </span>
                )}
                {id === 'radar' && isScanning && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                )}
              </span>

              <span className="font-sans text-[9px] font-semibold uppercase leading-none tracking-[0.08em]">
                {label}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-2 border-t border-hull-border/60 px-2 py-3">
        <button
          type="button"
          onClick={() => setAdvisorOpen(true)}
          title="AI-советник"
          className="group flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-holo/40 transition-colors hover:bg-accent/[0.08] hover:text-accent"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/20 bg-accent/[0.07] transition-colors group-hover:border-accent/40 group-hover:bg-accent/10">
            <Bot className="h-[17px] w-[17px]" strokeWidth={1.9} />
          </span>
          <span className="font-sans text-[9px] font-semibold uppercase tracking-[0.08em]">
            AI
          </span>
        </button>

        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-hull-border/60 text-holo/25"
          title="Горячие клавиши: Alt+1…4 — разделы, Ctrl+K — поиск"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </span>
      </div>
    </nav>
  )
}

export default DesktopNavRail
