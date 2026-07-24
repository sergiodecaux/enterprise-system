import { useCallback, useEffect, useState } from 'react'
import {
  fetchBotJournal,
  loadCachedBotJournal,
  type BotJournalPayload,
} from '../api/telegram/botJournal'

/**
 * Pulls bot/cron trades from Worker into the Mini App.
 */
export function useBotJournalSync(pollMs = 30_000) {
  const [payload, setPayload] = useState<BotJournalPayload | null>(() =>
    loadCachedBotJournal()
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchBotJournal()
      if (data) setPayload(data)
      else setError('Нет данных бота')
    } catch {
      setError('Не удалось загрузить журнал бота')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), pollMs)
    return () => window.clearInterval(id)
  }, [refresh, pollMs])

  return { payload, loading, error, refresh }
}
