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
    <header className="fixed inset-x-0 top-0 z-50 h-12 border-b border-border bg-bg-panel/90 backdrop-blur-xl">
      <div className="flex h-full items-center gap-2 px-3">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand/10 shadow-[0_0_18px_-10px_rgba(53,224,161,0.6)]">
            <Shield className="h-4 w-4 text-brand" strokeWidth={2} />
          </span>
          <div className="hidden min-[360px]:block">
            <div className="flex items-baseline gap-1.5">
              <span className="font-sans text-[13px] font-semibold tracking-[0.12em] text-text-primary">
                ENTERPRISE
              </span>
              <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-text-muted">
                system
              </span>
            </div>
            <div className="mt-px font-sans text-[11px] font-normal leading-none text-text-muted">
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
            className="hidden items-center gap-1.5 rounded-md border border-brand/25 bg-brand/[0.07] px-2.5 py-1.5 font-sans text-[11px] font-medium text-brand transition-colors hover:border-brand/40 hover:bg-brand/10 min-[1280px]:flex"
            title="Найти сделки по всему рынку"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Найти сделки
          </button>

          <button
            type="button"
            onClick={() => openAdvisor(true)}
            className="flex h-10 w-10 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-elevated px-0 font-sans text-[11px] font-medium text-text-secondary transition-colors hover:border-market-info/35 hover:bg-market-info/[0.08] hover:text-market-info desk:h-7 desk:w-auto desk:px-2.5"
            title="AI-советник"
            aria-label="AI-советник"
          >
            <Bot className="h-4 w-4 desk:h-3.5 desk:w-3.5" />
            <span className="hidden desk:inline">Советник</span>
          </button>

          <button
            type="button"
            onClick={() => setAlertsOpen(true)}
            className="relative flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-text-secondary transition-colors hover:border-border hover:bg-bg-elevated hover:text-brand desk:h-8 desk:w-8"
            title="Telegram-алерты"
            aria-label="Telegram-алерты"
          >
            <Bell className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-brand/60 to-transparent" />

      <TelegramAlertsPanel
        isOpen={alertsOpen}
        onClose={() => setAlertsOpen(false)}
      />
    </header>
  )
}

export default Header
