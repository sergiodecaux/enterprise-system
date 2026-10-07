import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useTelegramWebApp } from './useTelegramWebApp'
import {
  isTelegramAlertsConfigured,
  subscribeTelegramAlerts,
} from '../api/telegram/alerts'
import { pushMemeAlert, pushRadar141Alert } from '../api/telegram/formatters'
import { logger } from '../utils/logger'

/**
 * Подписка на Telegram-алерты + пуш Meme / Radar141.
 * Снайперские сигналы — useSniperSignalFire.
 */
export function useTelegramAlerts() {
  const { userId, isInTelegram } = useTelegramWebApp()
  const settings = useAppStore((s) => s.telegramAlertSettings)
  const setSettings = useAppStore((s) => s.setTelegramAlertSettings)
  const memeSignals = useAppStore((s) => s.memeSignals)
  const radar141Rows = useAppStore((s) => s.radar141Rows)

  const sentMemeRef = useRef<Set<string>>(new Set())
  const sentRadarRef = useRef<Set<string>>(new Set())
  const subscribeOnceRef = useRef(false)

  const resolveChatId = useCallback((): number | null => {
    if (userId) return userId
    const manual = settings.manualChatId.trim()
    if (manual && /^-?\d+$/.test(manual)) return Number(manual)
    return settings.subscribedChatId
  }, [userId, settings.manualChatId, settings.subscribedChatId])

  // Auto-subscribe when Mini App opens or manual chat id set
  useEffect(() => {
    if (!settings.enabled || !isTelegramAlertsConfigured()) return
    if (subscribeOnceRef.current) return

    const chatId = resolveChatId()
    if (!chatId) return

    subscribeOnceRef.current = true
    void (async () => {
      const ok = await subscribeTelegramAlerts({
        chatId,
        sniper: settings.sniper,
        meme: settings.meme,
      })
      if (ok) {
        setSettings({
          subscribedChatId: chatId,
          lastSubscribeAt: Date.now(),
        })
        logger.info(`[TG] Subscribed chat ${chatId}`)
      } else {
        subscribeOnceRef.current = false
        logger.warn('[TG] Subscribe failed — check worker / secrets')
      }
    })()
  }, [
    settings.enabled,
    settings.sniper,
    settings.meme,
    resolveChatId,
    setSettings,
    isInTelegram,
  ])

  // Sniper fires + Telegram: useSniperSignalFire (persisted de-dupe)

  // Push meme critical / strong with setup tags
  useEffect(() => {
    if (!settings.enabled || !settings.meme) return
    if (!isTelegramAlertsConfigured()) return

    const chatId = resolveChatId() ?? undefined

    for (const meme of memeSignals) {
      if (meme.heatScore < settings.minMemeHeat) continue
      if (
        meme.quality !== 'CRITICAL' &&
        meme.quality !== 'STRONG' &&
        !meme.criticalAlert
      ) {
        continue
      }

      const key = `${meme.symbol}:${meme.setupTag ?? meme.quality}:${Math.floor(meme.heatScore / 10)}`
      if (sentMemeRef.current.has(key)) continue
      sentMemeRef.current.add(key)

      void pushMemeAlert(meme, chatId).then(() => {
        logger.info(`[TG] Meme alert ${key}`)
      })
    }
  }, [
    memeSignals,
    settings.enabled,
    settings.meme,
    settings.minMemeHeat,
    resolveChatId,
  ])

  useEffect(() => {
    if (!settings.enabled || settings.radar141 === false) return
    if (!isTelegramAlertsConfigured()) return
    const chatId = resolveChatId() ?? undefined

    for (const row of radar141Rows) {
      let kind: 'touch' | 'exit' | 'bounce' | null = null
      if (row.trigger === 'INSIDE_141') kind = 'touch'
      else if (
        row.trigger === 'EXIT_141' ||
        row.trigger === 'EXIT_FAIL' ||
        row.trigger === 'EXIT_HOLD'
      ) {
        kind = row.trigger === 'EXIT_HOLD' ? 'bounce' : 'exit'
      }
      else if (row.trigger === 'IN_GAP' && row.gapPct >= 1.2) kind = 'bounce'
      if (!kind) continue
      const key = `${row.internalSymbol}:${kind}:${row.trigger}`
      if (sentRadarRef.current.has(key)) continue
      sentRadarRef.current.add(key)
      void pushRadar141Alert({ row, kind, chatId })
    }
  }, [radar141Rows, settings.enabled, settings.radar141, resolveChatId])
}
