import { create } from 'zustand'
import type { AdvisorMode } from '../api/advisor'
import type { MarketBrief } from '../engine/brief/marketBrief'
import type { StructureRead } from '../engine/smc/structureRead'

export interface AdvisorUiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  mode: AdvisorMode
  createdAt: number
  pending?: boolean
  error?: string
  model?: string
  node?: string
  symbol?: string | null
}

export interface AdvisorAsk {
  mode: AdvisorMode
  text: string
  /** Flat symbol (BTCUSDT) */
  symbol?: string | null
  tradeId?: string | null
}

interface AdvisorState {
  open: boolean
  messages: AdvisorUiMessage[]
  pendingAsk: AdvisorAsk | null
  /** Latest analyses published by chart / drawer, keyed by flat or internal symbol */
  structureBySymbol: Record<string, StructureRead>
  briefBySymbol: Record<string, MarketBrief>
  setOpen: (open: boolean) => void
  ask: (req: AdvisorAsk) => void
  consumeAsk: () => AdvisorAsk | null
  addMessage: (msg: AdvisorUiMessage) => void
  patchMessage: (id: string, patch: Partial<AdvisorUiMessage>) => void
  appendToMessage: (id: string, text: string) => void
  clearMessages: () => void
  setStructure: (symbol: string, read: StructureRead | null) => void
  setBrief: (symbol: string, brief: MarketBrief | null) => void
}

const HISTORY_KEY = 'advisor.history'
const MAX_STORED = 30

function loadHistory(): AdvisorUiMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as AdvisorUiMessage[]
    return Array.isArray(parsed) ? parsed.filter((m) => !m.pending).slice(-MAX_STORED) : []
  } catch {
    return []
  }
}

function saveHistory(messages: AdvisorUiMessage[]): void {
  try {
    const done = messages.filter((m) => !m.pending).slice(-MAX_STORED)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(done))
  } catch {
    /* quota / private mode */
  }
}

export const useAdvisorStore = create<AdvisorState>((set, get) => ({
  open: false,
  messages: loadHistory(),
  pendingAsk: null,
  structureBySymbol: {},
  briefBySymbol: {},

  setOpen: (open) => set({ open }),

  ask: (req) => set({ open: true, pendingAsk: req }),

  consumeAsk: () => {
    const req = get().pendingAsk
    if (req) set({ pendingAsk: null })
    return req
  },

  addMessage: (msg) =>
    set((s) => {
      const messages = [...s.messages, msg]
      saveHistory(messages)
      return { messages }
    }),

  patchMessage: (id, patch) =>
    set((s) => {
      const messages = s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m))
      if (patch.pending === false) saveHistory(messages)
      return { messages }
    }),

  appendToMessage: (id, text) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, content: m.content + text } : m)),
    })),

  clearMessages: () => {
    saveHistory([])
    set({ messages: [] })
  },

  setStructure: (symbol, read) =>
    set((s) => {
      if (!read) {
        if (!(symbol in s.structureBySymbol)) return s
        const next = { ...s.structureBySymbol }
        delete next[symbol]
        return { structureBySymbol: next }
      }
      if (s.structureBySymbol[symbol] === read) return s
      return { structureBySymbol: { ...s.structureBySymbol, [symbol]: read } }
    }),

  setBrief: (symbol, brief) =>
    set((s) => {
      if (!brief || s.briefBySymbol[symbol] === brief) return s
      return { briefBySymbol: { ...s.briefBySymbol, [symbol]: brief } }
    }),
}))
