import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useTelegramWebApp } from './useTelegramWebApp'
import { FAVORITE_LIMIT_RU } from '../engine/telegram/types'

export function useRadarFavoriteToggle() {
  const toggle = useAppStore((s) => s.toggleRadarFavorite)
  const { showAlert, haptic } = useTelegramWebApp()

  return useCallback(
    (internalSymbol: string) => {
      const result = toggle(internalSymbol)
      if (!result.ok && result.reason === 'limit') {
        haptic.warning()
        showAlert(FAVORITE_LIMIT_RU)
      }
      return result
    },
    [toggle, showAlert, haptic]
  )
}
