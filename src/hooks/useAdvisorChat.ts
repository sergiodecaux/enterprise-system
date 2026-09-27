import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AdvisorError,
  streamAdvisorChat,
  type AdvisorChatMessage,
  type AdvisorMode,
} from '../api/advisor'
import { buildAdvisorSnapshot, type AdvisorDeskInput } from '../engine/advisor'
import { buildCompositeAnalysis } from '../engine/composite'
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

/** Snapshot token budget: deep coin / trade reads get the whole chart screen */
const SNAPSHOT_BUDGET: Record<AdvisorMode, number> = {
  chat: 6000,
  coin: 9000,
  trade: 7000,
  market: 3000,
  radar: 3000,
}

function buildDesk(symbol: string | null): AdvisorDeskInput | null {
  if (!symbol) return null
  const app = useAppStore.getState()
  const signal = app.signals.find((s) => s.symbol === symbol || s.internalSymbol === symbol)
  if (!signal) return null
  const key = signal.internalSymbol
  const book = app.orderBookMetrics[key] ?? null
  const aggression = app.buyerAggression[key] ?? signal.buyerAggression ?? null
  const whales = app.whaleWatcher[key] ?? null
  const dna = app.sessionDNA[key] ?? null
  const po3 = app.po3Analysis[key] ?? null
  let composite = null
  try {
    composite = buildCompositeAnalysis(signal, signal.memePulse ?? undefined, book, aggression, whales, dna, po3)
  } catch {
    composite = null
  }
  return {
    book,
    obDelta: app.obDelta[key] ?? null,
    spoofs: app.spoofAlerts[key] ?? [],
    icebergs: app.icebergAlerts[key] ?? [],
    cvd: app.liveTapeCvd[key] ?? null,
    tape: app.tapeMomentum[key] ?? null,
    aggression,
    whales,
    liquidityMap: app.liquidityMaps[key] ?? null,
    dna,
    po3,
    mmIntent: app.mmIntent[key] ?? null,
    surgical: app.surgicalEntries[key] ?? null,
    composite,
  }
}

export function buildCurrentSnapshot(
  symbol: string | null,
  tradeId: string | null,
  mode: AdvisorMode = 'chat'
) {
  const app = useAppStore.getState()
  const advisor = useAdvisorStore.getState()
  let journal = null
  try {
    journal = getAnalytics(loadJournal())
  } catch {
    journal = null
  }
  const readChart = symbol ? advisor.chartBySymbol[symbol] : undefined
  const deep = mode === 'coin' || mode === 'trade' || mode === 'chat'
  return buildAdvisorSnapshot({
    maxTokens: SNAPSHOT_BUDGET[mode],
    chart: deep && readChart ? readChart() : null,
    desk: deep ? buildDesk(symbol) : null,
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
      const { snapshot } = buildCurrentSnapshot(symbol, opts.tradeId ?? null, opts.mode)
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
