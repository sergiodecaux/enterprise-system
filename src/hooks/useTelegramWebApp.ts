import { useEffect, useState, useCallback } from 'react'

// Telegram WebApp type definitions
interface TelegramWebApp {
  ready: () => void
  expand: () => void
  setHeaderColor: (color: string) => void
  setBackgroundColor: (color: string) => void
  showAlert?: (message: string, callback?: () => void) => void
  initDataUnsafe?: {
    user?: {
      id: number
      language_code?: string
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  HapticFeedback: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void
  }
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp
    }
  }
}

// Module-level flag to ensure initialization happens only once
let isInitialized = false

/**
 * Custom hook for Telegram Mini App integration
 * Handles WebApp initialization, theming, and haptic feedback
 * Initializes Telegram WebApp ONLY ONCE per application lifetime
 */
export const useTelegramWebApp = () => {
  const [isInTelegram, setIsInTelegram] = useState(false)
  const [userLanguage, setUserLanguage] = useState('en')
  const [userId, setUserId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const apply = (webApp: TelegramWebApp) => {
      if (cancelled) return
      setIsInTelegram(true)

      if (!isInitialized) {
        isInitialized = true
        webApp.ready()
        webApp.expand()
        try {
          webApp.setHeaderColor('#0a0a0a')
          webApp.setBackgroundColor('#0a0a0a')
        } catch {
          /* older Telegram clients */
        }
      }

      const lang = webApp.initDataUnsafe?.user?.language_code || 'en'
      setUserLanguage(lang)

      const id = webApp.initDataUnsafe?.user?.id || null
      setUserId(id)
    }

    const tick = () => {
      const webApp = window.Telegram?.WebApp
      if (webApp) {
        apply(webApp)
        return true
      }
      return false
    }

    if (tick()) {
      return () => {
        cancelled = true
      }
    }

    // telegram-web-app.js loads async from index.html — wait a few seconds
    const started = Date.now()
    timer = window.setInterval(() => {
      if (tick() || Date.now() - started > 4000) {
        if (timer != null) window.clearInterval(timer)
      }
    }, 50)

    return () => {
      cancelled = true
      if (timer != null) window.clearInterval(timer)
    }
  }, [])

  // Haptic feedback functions
  const haptic = {
    impact: useCallback((style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'medium') => {
      if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.HapticFeedback.impactOccurred(style)
      }
    }, []),

    notification: useCallback((type: 'success' | 'warning' | 'error') => {
      if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred(type)
      }
    }, []),

    success: useCallback(() => {
      if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred('success')
      }
    }, []),

    error: useCallback(() => {
      if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred('error')
      }
    }, []),

    warning: useCallback(() => {
      if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred('warning')
      }
    }, []),
  }

  const showAlert = useCallback((message: string) => {
    if (window.Telegram?.WebApp?.showAlert) {
      window.Telegram.WebApp.showAlert(message)
    } else {
      window.alert(message)
    }
  }, [])

  return {
    isInTelegram,
    userLanguage,
    haptic,
    showAlert,
    userId,
  }
}
