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
      className="flex w-14 shrink-0 flex-col border-r border-border bg-bg-panel/40"
    >
      <div className="flex flex-col gap-1 px-1.5 py-2">
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
              className={`group relative flex w-full flex-col items-center gap-1 rounded-lg px-0.5 py-2 transition-colors ${
                active
                  ? 'bg-brand/[0.08] text-brand'
                  : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-full bg-brand" />
              )}

              <span
                className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                  active
                    ? 'border border-brand/20 bg-brand/10'
                    : 'border border-transparent group-hover:border-border group-hover:bg-bg-elevated/60'
                }`}
              >
                <Icon className="h-[17px] w-[17px]" strokeWidth={1.9} />
                {badge > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex min-w-[15px] items-center justify-center rounded-full border border-bg-base bg-brand px-1 font-mono text-[11px] font-semibold leading-[13px] text-bg-base">
                    {badge > 99 ? '99' : badge}
                  </span>
                )}
                {id === 'radar' && isScanning && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-market-warning" />
                )}
              </span>

              <span className="font-sans text-[11px] font-medium leading-none">
                {label}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-2 border-t border-border/70 px-1.5 py-3">
        <button
          type="button"
          onClick={() => setAdvisorOpen(true)}
          title="AI-советник"
          className="group flex w-full flex-col items-center gap-1 rounded-lg px-0.5 py-1.5 text-text-secondary transition-colors hover:bg-market-info/[0.08] hover:text-market-info"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-market-info/20 bg-market-info/[0.07] transition-colors group-hover:border-market-info/40 group-hover:bg-market-info/10">
            <Bot className="h-[17px] w-[17px]" strokeWidth={1.9} />
          </span>
          <span className="font-sans text-[11px] font-medium leading-none">
            AI
          </span>
        </button>

        <span
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border/70 text-text-muted"
          title="Горячие клавиши: Alt+1…4 — разделы, Ctrl+K — поиск"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </span>
      </div>
    </nav>
  )
}

export default DesktopNavRail
