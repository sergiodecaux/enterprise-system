import { useState } from 'react'
import { Shield, Bell } from 'lucide-react'
import StatusIndicator from './StatusIndicator'
import TelegramAlertsPanel from '../telegram/TelegramAlertsPanel'

const Header = () => {
  const [alertsOpen, setAlertsOpen] = useState(false)

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-14 border-b border-hull-border bg-hull/95 backdrop-blur-sm">
      <div className="flex h-full items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-matrix" />
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-sm font-bold tracking-wider text-matrix">
              ENTERPRISE
            </span>
            <span className="font-mono text-xs text-holo/60">SYSTEM</span>
          </div>
        </div>

        <StatusIndicator />

        <button
          type="button"
          onClick={() => setAlertsOpen(true)}
          className="flex w-16 items-center justify-end rounded-lg p-1.5 text-holo/50 transition-colors hover:bg-hull-light/50 hover:text-matrix"
          title="Telegram алерты"
        >
          <Bell className="h-4 w-4" />
        </button>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-matrix to-transparent" />

      <TelegramAlertsPanel
        isOpen={alertsOpen}
        onClose={() => setAlertsOpen(false)}
      />
    </header>
  )
}

export default Header
