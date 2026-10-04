import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'
import { emitSniperFires, sniperFireKey } from '../engine/sniper/fire'
import {
  isTelegramAlertsConfigured,
} from '../api/telegram/alerts'
import { pushSniperAlert } from '../api/telegram/formatters'
import { logger } from '../utils/logger'

/**
 * Always-on: when a coin becomes sniper-quality, write a durable journal
 * row and (if Telegram alerts are on) push one alert. De-dupe is persisted
 * so scan ticks / remounts do not spam the same coin+side+style.
 */
export function useSniperSignalFire() {
  const signals = useAppStore((s) => s.signals)
  const buyerAggression = useAppStore((s) => s.buyerAggression)
  const bumpJournal = useAppStore((s) => s.bumpJournalVersion)
  const settings = useAppStore((s) => s.telegramAlertSettings)
  const sentRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!signals.length) return

    const enriched = signals.map((s) => ({
      ...s,
      buyerAggression:
        buyerAggression[s.internalSymbol] ?? s.buyerAggression ?? null,
    }))

    const { newly, markedKeys } = emitSniperFires(enriched)
    if (newly.length || markedKeys.length) bumpJournal()

    if (!settings.enabled || !settings.sniper) return
    if (!isTelegramAlertsConfigured()) return

    for (const signal of newly) {
      if (signal.calibratedWinRate < settings.minSniperConfidence) continue
      const key = sniperFireKey(signal)
      if (sentRef.current.has(key)) continue
      sentRef.current.add(key)
      void pushSniperAlert(signal).then(() => {
        logger.info(`[TG] Sniper fire ${key}`)
      })
    }
  }, [
    signals,
    buyerAggression,
    bumpJournal,
    settings.enabled,
    settings.sniper,
    settings.minSniperConfidence,
  ])
}
