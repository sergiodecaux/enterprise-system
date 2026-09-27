import { useEffect, useRef, useState } from 'react'
import { Bot, Send, Settings, Square, Trash2, X } from 'lucide-react'
import { getAdvisorToken, getAdvisorUrls, type AdvisorMode } from '../../api/advisor'
import { useAdvisorChat } from '../../hooks/useAdvisorChat'
import { useAdvisorStore } from '../../store/useAdvisorStore'
import { useAppStore } from '../../store/useAppStore'
import AdvisorMessage from './AdvisorMessage'
import AdvisorSettings from './AdvisorSettings'

interface QuickAction {
  label: string
  mode: AdvisorMode
  text: (coin: string | null) => string
  needsCoin?: boolean
  needsTrades?: boolean
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Рынок сейчас', mode: 'market', text: () => 'Что сейчас на рынке и куда смотреть?' },
  { label: 'Топ радара 141', mode: 'radar', text: () => 'Разбери топ радара 141: что самое интересное?' },
  {
    label: 'Разбор монеты',
    mode: 'coin',
    needsCoin: true,
    text: (coin) => `Разбери ${coin ?? 'текущую монету'}: есть ли сетап?`,
  },
  {
    label: 'Мои сделки',
    mode: 'trade',
    needsTrades: true,
    text: () => 'Дай мнение по моим активным сделкам.',
  },
]

const AdvisorPanel = () => {
  const open = useAdvisorStore((s) => s.open)
  const setOpen = useAdvisorStore((s) => s.setOpen)
  const messages = useAdvisorStore((s) => s.messages)
  const pendingAsk = useAdvisorStore((s) => s.pendingAsk)
  const clearMessages = useAdvisorStore((s) => s.clearMessages)
  const selectedCoin = useAppStore((s) => s.selectedCoin)
  const drawerOpen = useAppStore((s) => s.isDrawerOpen)
  const hasTrades = useAppStore((s) =>
    s.activeTrades.some((t) => t.status === 'ACTIVE' || t.status === 'BREAKEVEN')
  )
  const { send, stop, busy } = useAdvisorChat()

  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const configured = getAdvisorUrls().length > 0 && getAdvisorToken().length > 0

  useEffect(() => {
    if (open && !configured) setShowSettings(true)
  }, [open, configured])

  useEffect(() => {
    if (!open || !pendingAsk || busy || showSettings) return
    const req = useAdvisorStore.getState().consumeAsk()
    if (req) void send(req)
  }, [open, pendingAsk, busy, showSettings, send])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  const submit = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    void send({ mode: 'chat', text })
  }

  const coinLabel = selectedCoin ? selectedCoin.replace(/USDT$/, '') : null

  return (
    <>
      {!open && !drawerOpen && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Советник AI"
          className="fixed bottom-5 right-4 z-[60] flex h-12 w-12 items-center justify-center rounded-full border border-matrix/40 bg-space/95 text-matrix shadow-[0_0_18px_rgba(0,255,136,0.25)] backdrop-blur-sm transition-transform active:scale-95"
        >
          <Bot className="h-6 w-6" />
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-space/95 backdrop-blur-sm sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[80vh] sm:w-[420px] sm:rounded-2xl sm:border sm:border-hull-border">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-hull-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-matrix" />
              <span className="font-mono text-sm font-bold uppercase text-holo">Советник AI</span>
              {coinLabel && (
                <span className="rounded border border-hull-border px-1.5 py-0.5 font-mono text-[10px] text-holo/60">
                  {coinLabel}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                className={`rounded-lg p-2 hover:bg-hull-light ${showSettings ? 'text-matrix' : 'text-holo/60'}`}
                aria-label="Настройки советника"
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={clearMessages}
                disabled={busy}
                className="rounded-lg p-2 text-holo/60 hover:bg-hull-light disabled:opacity-40"
                aria-label="Очистить историю"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-holo/60 hover:bg-hull-light"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {showSettings ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <AdvisorSettings onDone={() => setShowSettings(false)} />
            </div>
          ) : (
            <>
              <div
                ref={listRef}
                className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 py-3"
                style={{ WebkitOverflowScrolling: 'touch' }}
              >
                {messages.length === 0 && (
                  <div className="px-2 py-6 text-center font-mono text-[12px] text-holo/40">
                    Спросите про рынок, радар 141, монету или свою сделку. Советник видит снимок
                    данных приложения, но не гарантирует результат.
                  </div>
                )}
                {messages.map((m) => (
                  <AdvisorMessage key={m.id} message={m} />
                ))}
              </div>

              <div className="flex-shrink-0 border-t border-hull-border/60 px-3 pb-3 pt-2">
                <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
                  {QUICK_ACTIONS.filter(
                    (a) => (!a.needsCoin || selectedCoin) && (!a.needsTrades || hasTrades)
                  ).map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void send({ mode: a.mode, text: a.text(coinLabel), symbol: selectedCoin })
                      }
                      className="flex-shrink-0 rounded-full border border-hull-border px-3 py-1 font-mono text-[11px] text-holo/70 hover:border-matrix/40 hover:text-matrix disabled:opacity-40"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submit()
                      }
                    }}
                    rows={2}
                    placeholder="Вопрос советнику…"
                    className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-hull-border bg-hull-light/40 px-3 py-2 font-mono text-[12px] text-holo outline-none focus:border-matrix/60"
                  />
                  {busy ? (
                    <button
                      type="button"
                      onClick={stop}
                      className="rounded-lg border border-alert/50 p-2.5 text-alert"
                      aria-label="Остановить"
                    >
                      <Square className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={submit}
                      disabled={!input.trim()}
                      className="rounded-lg border border-matrix/50 p-2.5 text-matrix disabled:opacity-40"
                      aria-label="Отправить"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

export default AdvisorPanel
