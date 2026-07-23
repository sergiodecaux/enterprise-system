import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useTelegramWebApp } from './useTelegramWebApp'
import {
  isTelegramAlertsConfigured,
  subscribeTelegramAlerts,
} from '../api/telegram/alerts'
import { pushCoinSignalAlert, pushMemeAlert } from '../api/telegram/formatters'
import { isSniperQuality, toSniperSignal } from '../engine/sniperMode'
import { logger } from '../utils/logger'

/**
 * Подписка на Telegram-алерты + пуш новых Sniper/Meme сигналов.
 */
export function useTelegramAlerts() {
  const { userId, isInTelegram } = useTelegramWebApp()
  const settings = useAppStore((s) => s.telegramAlertSettings)
  const setSettings = useAppStore((s) => s.setTelegramAlertSettings)
  const signals = useAppStore((s) => s.signals)
  const memeSignals = useAppStore((s) => s.memeSignals)

  const sentSniperRef = useRef<Set<string>>(new Set())
  const sentMemeRef = useRef<Set<string>>(new Set())
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

  // Push sniper-quality setups
  useEffect(() => {
    if (!settings.enabled || !settings.sniper) return
    if (!isTelegramAlertsConfigured()) return

    for (const signal of signals) {
      if (!isSniperQuality(signal)) continue
      let sniper
      try {
        sniper = toSniperSignal(signal)
      } catch {
        continue
      }

      if (sniper.calibratedWinRate < settings.minSniperConfidence) continue

      const key = `${sniper.symbol}:${sniper.direction}:${sniper.tradeStyle}`
      if (sentSniperRef.current.has(key)) continue
      sentSniperRef.current.add(key)

      void pushCoinSignalAlert(sniper).then(() => {
        logger.info(`[TG] Sniper alert ${key}`)
      })
    }
  }, [signals, settings.enabled, settings.sniper, settings.minSniperConfidence])

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
}
