import { useEffect, useRef, useCallback, useMemo } from 'react'
import { fetchOhlcv } from '../api/mexc'
import {
  calcPnlAndR,
  getAnalytics,
  journalTimeoutMs,
  loadJournal,
  resolveJournalEntry,
  type JournalAnalytics,
  type SignalJournalEntry,
} from '../engine/journal'
import { logger } from '../utils/logger'
import { useAppStore } from '../store/useAppStore'

const RESOLVE_INTERVAL_MS = 45_000
const COIN_DELAY_MS = 200

/**
 * Авто-резолв OPEN сигналов журнала по цене vs TP1/SL + timeout.
 * Обновляет MFE/MAE для анализа просадок.
 */
export function useSignalJournalResolver() {
  const bump = useAppStore((s) => s.bumpJournalVersion)
  const isMounted = useRef(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const resolveOne = useCallback(
    async (entry: SignalJournalEntry): Promise<boolean> => {
      try {
        const candles = await fetchOhlcv(entry.internalSymbol, '1m', 5)
        if (!candles.length || !isMounted.current) return false
        const price = candles[candles.length - 1][4]

        const favPct =
          entry.direction === 'LONG'
            ? ((price - entry.entryPrice) / entry.entryPrice) * 100
            : ((entry.entryPrice - price) / entry.entryPrice) * 100
        const advPct = -favPct

        const mfePercent = Math.max(entry.mfePercent, favPct)
        const maePercent = Math.max(entry.maePercent, advPct > 0 ? advPct : 0)

        const hitTp =
          entry.direction === 'LONG' ? price >= entry.tp1 : price <= entry.tp1
        const hitSl =
          entry.direction === 'LONG' ? price <= entry.sl : price >= entry.sl
        const timedOut = Date.now() - entry.createdAt >= journalTimeoutMs(entry)

        if (hitTp || hitSl || timedOut) {
          const status = hitTp ? 'WIN' : hitSl ? 'LOSS' : 'TIMEOUT'
          const exitPrice = hitTp ? entry.tp1 : hitSl ? entry.sl : price
          const { pnlPercent, rMultiple } = calcPnlAndR({
            direction: entry.direction,
            entry: entry.entryPrice,
            exit: exitPrice,
            sl: entry.sl,
          })
          resolveJournalEntry(entry.id, {
            status,
            resolvedAt: Date.now(),
            exitPrice,
            pnlPercent,
            rMultiple,
            mfePercent,
            maePercent,
            resolveSource: timedOut && !hitTp && !hitSl ? 'TIMEOUT' : 'AUTO',
          })
          return true
        }

        resolveJournalEntry(entry.id, { mfePercent, maePercent })
        return false
      } catch (err) {
        logger.warn(`[Journal] resolve ${entry.symbol}`, err)
        return false
      }
    },
    []
  )

  const tick = useCallback(async () => {
    const open = loadJournal().filter((e) => e.status === 'OPEN')
    if (!open.length) {
      bump()
      return
    }

    const batch = open.slice(0, 12)
    for (const entry of batch) {
      if (!isMounted.current) break
      await resolveOne(entry)
      await new Promise((r) => setTimeout(r, COIN_DELAY_MS))
    }
    bump()
  }, [resolveOne, bump])

  useEffect(() => {
    isMounted.current = true
    tick()
    intervalRef.current = setInterval(tick, RESOLVE_INTERVAL_MS)
    return () => {
      isMounted.current = false
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [tick])
}

export function useJournalEntries(): SignalJournalEntry[] {
  const version = useAppStore((s) => s.journalVersion)
  return useMemo(() => {
    void version
    return loadJournal()
  }, [version])
}

export function useJournalAnalytics(): JournalAnalytics {
  const entries = useJournalEntries()
  return useMemo(() => getAnalytics(entries), [entries])
}
