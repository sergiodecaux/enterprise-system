import { useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import { logger } from '../../utils/logger'

const ProGate = () => {
  const { t } = useTranslation()
  const isProUser = useAppStore((state) => state.isProUser)
  const setProUser = useAppStore((state) => state.setProUser)
  const [isOpen, setIsOpen] = useState(false)

  const { isInTelegram, haptic } = useTelegramWebApp()

  const handleUpgrade = () => {
    // TODO: Implement actual Telegram Stars payment via Bot API
    haptic.impact()
    
    // For now, just simulate upgrade
    if (isInTelegram && window.Telegram?.WebApp) {
      // In production, open payment flow
      // window.Telegram.WebApp.openInvoice(...)
      logger.info('Opening Telegram Stars payment...')
    }
    
    // Temporary: allow upgrade for testing
    setProUser(true)
    setIsOpen(false)
  }

  const handleClose = () => {
    setIsOpen(false)
  }

  // Don't show if already pro
  if (isProUser) return null

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50"
          onClick={handleClose}
        />
      )}

      {/* Pro Gate Modal */}
      <div
        className={`fixed bottom-0 left-0 right-0 bg-space border-t border-hull-border rounded-t-2xl p-6 z-50 transition-transform duration-300 ${
          isOpen ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-mono font-bold text-matrix mb-1">
              {t('pro_title')}
            </h2>
            <p className="text-sm text-holo/60 font-mono">
              {t('pro_subtitle')}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-hull-light rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-holo/60" />
          </button>
        </div>

        <div className="space-y-3 mb-6">
          <div className="flex items-center gap-3 text-sm font-mono text-holo">
            <div className="w-2 h-2 bg-matrix rounded-full" />
            {t('pro_feature_1')}
          </div>
          <div className="flex items-center gap-3 text-sm font-mono text-holo">
            <div className="w-2 h-2 bg-matrix rounded-full" />
            {t('pro_feature_2')}
          </div>
          <div className="flex items-center gap-3 text-sm font-mono text-holo">
            <div className="w-2 h-2 bg-matrix rounded-full" />
            {t('pro_feature_3')}
          </div>
        </div>

        <button
          onClick={handleUpgrade}
          className="w-full py-3 bg-matrix/20 text-matrix border border-matrix/50 rounded-lg font-mono font-bold uppercase tracking-wider hover:bg-matrix/30 transition-colors neon-glow"
        >
          {t('pro_button')}
        </button>

        <p className="text-center text-xs text-holo/40 font-mono mt-3">
          {t('pro_price')}
        </p>
      </div>

      {/* Floating upgrade button (when drawer is closed) */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-4 right-4 w-14 h-14 bg-matrix/20 text-matrix border border-matrix/50 rounded-full flex items-center justify-center font-mono font-bold text-lg hover:bg-matrix/30 transition-colors neon-glow z-40"
          aria-label="Upgrade to Pro"
        >
          ⭐
        </button>
      )}
    </>
  )
}

export default ProGate
