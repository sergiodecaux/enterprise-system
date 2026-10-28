import { useState } from 'react'
import { Bell, Bot, Shield, Sparkles } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import MarketRibbon from './MarketRibbon'
import TelegramAlertsPanel from '../telegram/TelegramAlertsPanel'
import { useAdvisorStore } from '../../store/useAdvisorStore'

const Header = () => {
  const [alertsOpen, setAlertsOpen] = useState(false)
  const openAdvisor = useAdvisorStore((s) => s.setOpen)
  const askAdvisor = useAdvisorStore((s) => s.ask)

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-14 border-b border-hull-border/80 bg-hull/90 backdrop-blur-xl">
      <div className="flex h-full items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-matrix/25 bg-gradient-to-br from-matrix/20 to-transparent shadow-glow">
            <Shield className="h-4 w-4 text-matrix" strokeWidth={2} />
          </span>
          <div className="hidden min-[360px]:block">
            <div className="flex items-baseline gap-1.5">
              <span className="font-sans text-[12px] font-bold tracking-[0.17em] text-holo sm:text-[13px]">
                ENTERPRISE
              </span>
              <span className="font-sans text-[9px] font-medium uppercase tracking-[0.15em] text-holo/35 sm:text-[10px]">
                system
              </span>
            </div>
            <div className="mt-px font-sans text-[8px] font-medium uppercase tracking-[0.2em] text-matrix/60 sm:text-[9px]">
              живой терминал
            </div>
          </div>
        </div>

        <div className="hidden min-w-0 flex-1 justify-center min-[1100px]:flex">
          <MarketRibbon />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <StatusIndicator />

          <button
            type="button"
            onClick={() =>
              askAdvisor({
                mode: 'opportunities',
                text: 'Найди лучшие сделки прямо сейчас по всему рынку',
              })
            }
            className="hidden items-center gap-1.5 rounded-lg border border-amber-300/25 bg-amber-300/[0.07] px-2.5 py-1.5 font-sans text-[11px] font-semibold text-amber-200/90 transition-colors hover:border-amber-300/45 hover:bg-amber-300/[0.12] hover:text-amber-100 min-[1280px]:flex"
            title="Найти сделки по всему рынку"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Найти сделки
          </button>

          <button
            type="button"
            onClick={() => openAdvisor(true)}
            className="flex items-center gap-1.5 rounded-lg border border-hull-border/80 bg-hull-light/40 px-2 py-1.5 font-sans text-[11px] font-semibold text-holo/70 transition-colors hover:border-accent/35 hover:bg-accent/[0.08] hover:text-accent sm:px-2.5"
            title="AI-советник"
            aria-label="AI-советник"
          >
            <Bot className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Советник</span>
          </button>

          <button
            type="button"
            onClick={() => setAlertsOpen(true)}
            className="relative rounded-lg border border-transparent p-1.5 text-holo/45 transition-colors hover:border-hull-border/80 hover:bg-hull-light/60 hover:text-matrix"
            title="Telegram-алерты"
            aria-label="Telegram-алерты"
          >
            <Bell className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-matrix/70 to-transparent" />

      <TelegramAlertsPanel
        isOpen={alertsOpen}
        onClose={() => setAlertsOpen(false)}
      />
    </header>
  )
}

export default Header
