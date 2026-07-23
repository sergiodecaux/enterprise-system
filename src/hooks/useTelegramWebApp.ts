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
    const webApp = window.Telegram?.WebApp

    if (webApp) {
      setIsInTelegram(true)

      // Initialize WebApp only once per lifetime
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
    } else {
      setIsInTelegram(false)
      setUserLanguage('en')
      setUserId(null)
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
