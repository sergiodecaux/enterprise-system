import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useTelegramWebApp } from './useTelegramWebApp'
import {
  isTelegramAlertsConfigured,
  NEED_START_ELITE,
  syncTelegramFavorites,
} from '../api/telegram/alerts'
import { logger } from '../utils/logger'

export function useTelegramFavoritesSync() {
  const { userId, showAlert } = useTelegramWebApp()
  const favorites = useAppStore((s) => s.radarFavorites)
  const settings = useAppStore((s) => s.telegramAlertSettings)
  const lastSig = useRef('')
  const firstSync = useRef(true)

  useEffect(() => {
    if (!isTelegramAlertsConfigured()) return
    const chatId = userId
      ? userId
      : settings.manualChatId.trim() && /^-?\d+$/.test(settings.manualChatId.trim())
        ? Number(settings.manualChatId.trim())
        : settings.subscribedChatId
    if (!chatId) return

    const sig = `${chatId}:${favorites.join(',')}:${settings.favoritesDigest !== false}`
    if (sig === lastSig.current) return
    lastSig.current = sig

    const showNeedStart = !firstSync.current
    firstSync.current = false

    void (async () => {
      const res = await syncTelegramFavorites({
        chatId,
        symbols: favorites,
        digestOn: settings.favoritesDigest !== false,
        urgentOn: true,
      })
      if (res.ok) {
        logger.info(`[TG] Favorites synced ${favorites.length}`)
        return
      }
      if (res.reason === 'need_start' && showNeedStart) {
        showAlert(NEED_START_ELITE)
      } else if (!res.ok) {
        logger.warn('[TG] Favorites sync failed', res.reason)
      }
    })()
  }, [
    favorites,
    settings.favoritesDigest,
    settings.manualChatId,
    settings.subscribedChatId,
    userId,
    showAlert,
  ])
}
