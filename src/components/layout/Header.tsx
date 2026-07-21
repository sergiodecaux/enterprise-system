import { Shield } from 'lucide-react'
import StatusIndicator from './StatusIndicator'

const Header = () => {
  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-hull/95 backdrop-blur-sm border-b border-hull-border z-50">
      <div className="h-full px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-matrix" />
          <div className="flex items-baseline gap-1">
            <span className="text-sm font-mono font-bold text-matrix tracking-wider">
              ENTERPRISE
            </span>
            <span className="text-xs text-holo/60 font-mono">SYSTEM</span>
          </div>
        </div>

        <StatusIndicator />

        <div className="w-16" aria-hidden />
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-matrix to-transparent" />
    </header>
  )
}

export default Header
