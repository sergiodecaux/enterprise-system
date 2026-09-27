import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AdvisorError,
  streamAdvisorChat,
  type AdvisorChatMessage,
  type AdvisorMode,
} from '../api/advisor'
import { buildAdvisorSnapshot } from '../engine/advisor'
import { getAnalytics, loadJournal } from '../engine/journal/storage'
import { useAdvisorStore, type AdvisorUiMessage } from '../store/useAdvisorStore'
import { useAppStore } from '../store/useAppStore'
import { getCachedWorkerMarketContext, loadWorkerMarketContext } from './useWorkerMarketContext'

const HISTORY_TURNS = 8
const MIN_GAP_MS = 3_000

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Only user→assistant pairs with a real answer: chat templates expect strict alternation. */
function answeredTurns(messages: AdvisorUiMessage[]): AdvisorChatMessage[] {
  const done = messages.filter((m) => !m.pending)
  const out: AdvisorChatMessage[] = []
  for (let i = 0; i < done.length - 1; i++) {
    const u = done[i]
    const a = done[i + 1]
    if (u.role === 'user' && a.role === 'assistant' && !a.error && a.content.trim()) {
      out.push({ role: 'user', content: u.content }, { role: 'assistant', content: a.content })
      i++
    }
  }
  return out
}

export interface AdvisorSendOptions {
  mode: AdvisorMode
  text: string
  symbol?: string | null
  tradeId?: string | null
}

export function buildCurrentSnapshot(symbol: string | null, tradeId: string | null) {
  const app = useAppStore.getState()
  const advisor = useAdvisorStore.getState()
  let journal = null
  try {
    journal = getAnalytics(loadJournal())
  } catch {
    journal = null
  }
  return buildAdvisorSnapshot({
    now: Date.now(),
    focusSymbol: symbol,
    focusTradeId: tradeId,
    signals: app.signals,
    marketContext: app.marketContext,
    worker: getCachedWorkerMarketContext(),
    radarRows: app.radar141Rows,
    activeTrades: app.activeTrades,
    journal,
    structure: symbol ? advisor.structureBySymbol[symbol] ?? null : null,
    brief: symbol ? advisor.briefBySymbol[symbol] ?? null : null,
  })
}

export function useAdvisorChat() {
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const lastSentAt = useRef(0)

  useEffect(() => () => abortRef.current?.abort(), [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const send = useCallback(async (opts: AdvisorSendOptions) => {
    const text = opts.text.trim()
    if (!text || abortRef.current) return
    if (Date.now() - lastSentAt.current < MIN_GAP_MS) return
    lastSentAt.current = Date.now()

    const store = useAdvisorStore.getState()
    const symbol = opts.symbol ?? useAppStore.getState().selectedCoin ?? null
    const history = answeredTurns(store.messages).slice(-HISTORY_TURNS)

    const userMsg = {
      id: newId(),
      role: 'user' as const,
      content: text,
      mode: opts.mode,
      createdAt: Date.now(),
      symbol,
    }
    const replyId = newId()
    store.addMessage(userMsg)
    store.addMessage({
      id: replyId,
      role: 'assistant',
      content: '',
      mode: opts.mode,
      createdAt: Date.now(),
      pending: true,
      symbol,
    })

    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)

    try {
      if (!getCachedWorkerMarketContext()) await loadWorkerMarketContext().catch(() => null)
      const { snapshot } = buildCurrentSnapshot(symbol, opts.tradeId ?? null)
      const meta = await streamAdvisorChat({
        messages: [...history, { role: 'user', content: text }],
        snapshot,
        mode: opts.mode,
        signal: controller.signal,
        onMeta: (m) => useAdvisorStore.getState().patchMessage(replyId, { model: m.model, node: m.node }),
        onDelta: (d) => useAdvisorStore.getState().appendToMessage(replyId, d),
      })
      const reply = useAdvisorStore.getState().messages.find((m) => m.id === replyId)
      useAdvisorStore.getState().patchMessage(replyId, {
        pending: false,
        model: meta.model,
        node: meta.node,
        error: reply?.content.trim() ? undefined : 'Пустой ответ модели',
      })
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError'
      const message = aborted
        ? 'Остановлено'
        : err instanceof AdvisorError
          ? err.message
          : `Ошибка: ${(err as Error).message}`
      useAdvisorStore.getState().patchMessage(replyId, { pending: false, error: message })
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }, [])

  return { send, stop, busy }
}
