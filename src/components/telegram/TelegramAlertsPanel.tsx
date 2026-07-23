import { useEffect, useState } from 'react'
import { Bell, X, ExternalLink, Check } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useTelegramWebApp } from '../../hooks/useTelegramWebApp'
import {
  checkTelegramHealth,
  getTelegramBotLink,
  isTelegramAlertsConfigured,
  subscribeTelegramAlerts,
  sendTelegramAlert,
} from '../../api/telegram/alerts'

interface Props {
  isOpen: boolean
  onClose: () => void
}

const TelegramAlertsPanel = ({ isOpen, onClose }: Props) => {
  const { userId, isInTelegram, showAlert, haptic } = useTelegramWebApp()
  const settings = useAppStore((s) => s.telegramAlertSettings)
  const setSettings = useAppStore((s) => s.setTelegramAlertSettings)
  const watchedSetups = useAppStore((s) => s.watchedSetups)

  const [health, setHealth] = useState<{
    ok: boolean
    subscribers?: number
  } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    void checkTelegramHealth().then(setHealth)
  }, [isOpen])

  if (!isOpen) return null

  const botLink = getTelegramBotLink()
  const configured = isTelegramAlertsConfigured()

  const resolveChatId = (): number | null => {
    if (userId) return userId
    const m = settings.manualChatId.trim()
    if (m && /^-?\d+$/.test(m)) return Number(m)
    return settings.subscribedChatId
  }

  const handleSubscribe = async () => {
    const chatId = resolveChatId()
    if (!chatId) {
      showAlert(
        'Укажите Chat ID или откройте приложение внутри Telegram.\nУзнать ID: @userinfobot'
      )
      return
    }
    setBusy(true)
    try {
      const ok = await subscribeTelegramAlerts({
        chatId,
        sniper: settings.sniper,
        meme: settings.meme,
      })
      if (ok) {
        setSettings({
          subscribedChatId: chatId,
          lastSubscribeAt: Date.now(),
          enabled: true,
        })
        haptic.success()
        showAlert('✅ Подписка на алерты активна. Проверьте бота в Telegram.')
      } else {
        showAlert(
          'Не удалось подписаться. Проверьте VITE_MEXC_PROXY_URL и деплой worker.'
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async () => {
    setBusy(true)
    try {
      const chatId = resolveChatId() ?? undefined
      const result = await sendTelegramAlert({
        type: 'SYSTEM',
        title: 'Тестовый алерт',
        text: 'ENTERPRISE SYSTEM связан с Telegram. Сигналы будут приходить сюда.',
        chatId,
        dedupeKey: `test:${Date.now()}`,
      })
      if (result.ok) {
        haptic.success()
        showAlert('✅ Тест отправлен в Telegram')
      } else {
        showAlert(
          '❌ Не удалось отправить. Нужны TELEGRAM_BOT_TOKEN + ALERT_SECRET на worker и /start в боте.'
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed inset-x-4 top-16 z-50 mx-auto max-w-sm overflow-hidden rounded-2xl border border-hull-border bg-space shadow-2xl">
        <div className="flex items-center justify-between border-b border-hull-border/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-matrix" />
            <h2 className="font-mono text-sm font-bold uppercase text-holo">
              Telegram алерты
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 hover:bg-hull-light/40"
          >
            <X className="h-4 w-4 text-holo/60" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
          {!configured && (
            <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-3 font-mono text-[11px] text-yellow-200">
              Задайте <code>VITE_MEXC_PROXY_URL</code> на URL worker с Telegram
              routes. См. workers/mexc-proxy/README.md
            </div>
          )}

          <label className="flex items-center justify-between">
            <span className="font-mono text-xs text-holo/80">Включены</span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => setSettings({ enabled: e.target.checked })}
              className="accent-matrix"
            />
          </label>

          <label className="flex items-center justify-between">
            <span className="font-mono text-xs text-holo/80">Снайпер</span>
            <input
              type="checkbox"
              checked={settings.sniper}
              onChange={(e) => setSettings({ sniper: e.target.checked })}
              className="accent-matrix"
            />
          </label>

          <label className="flex items-center justify-between">
            <span className="font-mono text-xs text-holo/80">Мемы</span>
            <input
              type="checkbox"
              checked={settings.meme}
              onChange={(e) => setSettings({ meme: e.target.checked })}
              className="accent-matrix"
            />
          </label>

          <label className="flex items-center justify-between">
            <span className="font-mono text-xs text-holo/80">Слежение за сетапами</span>
            <input
              type="checkbox"
              checked={settings.setupWatch !== false}
              onChange={(e) => setSettings({ setupWatch: e.target.checked })}
              className="accent-matrix"
            />
          </label>

          <div>
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Мин. Confidence снайпер: {settings.minSniperConfidence}%
            </div>
            <input
              type="range"
              min={50}
              max={95}
              value={settings.minSniperConfidence}
              onChange={(e) =>
                setSettings({ minSniperConfidence: Number(e.target.value) })
              }
              className="h-1 w-full accent-matrix"
            />
          </div>

          <div>
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Мин. Heat мем: {settings.minMemeHeat}
            </div>
            <input
              type="range"
              min={30}
              max={90}
              value={settings.minMemeHeat}
              onChange={(e) =>
                setSettings({ minMemeHeat: Number(e.target.value) })
              }
              className="h-1 w-full accent-alert"
            />
          </div>

          <div>
            <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
              Chat ID {!isInTelegram && '(обязательно вне Telegram)'}
            </div>
            <input
              type="text"
              value={
                userId
                  ? String(userId)
                  : settings.manualChatId
              }
              disabled={!!userId}
              onChange={(e) => setSettings({ manualChatId: e.target.value })}
              placeholder="Например 123456789"
              className="w-full rounded-lg border border-hull-border bg-hull px-3 py-2 font-mono text-xs text-holo outline-none focus:border-matrix/50"
            />
            {userId && (
              <p className="mt-1 font-mono text-[10px] text-matrix/70">
                ID из Mini App: {userId}
              </p>
            )}
          </div>

          {settings.subscribedChatId && (
            <div className="flex items-center gap-2 font-mono text-[10px] text-matrix">
              <Check className="h-3 w-3" />
              Подписан: {settings.subscribedChatId}
            </div>
          )}

          {health && (
            <p className="font-mono text-[10px] text-holo/40">
              Worker: {health.ok ? 'OK' : 'DOWN'}
              {health.subscribers != null
                ? ` · подписчиков: ${health.subscribers}`
                : ''}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={busy || !configured}
              onClick={handleSubscribe}
              className="rounded-lg bg-matrix/20 py-2.5 font-mono text-xs font-bold uppercase text-matrix disabled:opacity-40"
            >
              Подписаться / обновить
            </button>
            <button
              type="button"
              disabled={busy || !configured}
              onClick={handleTest}
              className="rounded-lg border border-hull-border py-2.5 font-mono text-xs font-bold uppercase text-holo/70 disabled:opacity-40"
            >
              Тестовое сообщение
            </button>
            {botLink && (
              <a
                href={botLink}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 py-2.5 font-mono text-xs font-bold uppercase text-sky-300"
              >
                Открыть бота
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

              {watchedSetups.length > 0 && (
                <div className="rounded-lg border border-hull-border/50 bg-black/20 p-2">
                  <div className="mb-1 font-mono text-[10px] uppercase text-holo/40">
                    Активные watch: {watchedSetups.length}
                  </div>
                  <ul className="max-h-24 space-y-1 overflow-y-auto">
                    {watchedSetups.slice(0, 8).map((w) => (
                      <li
                        key={w.watchId}
                        className="font-mono text-[9px] text-holo/50"
                      >
                        {w.symbol} {w.setup.side} · {w.lastStatus}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

          <p className="font-mono text-[10px] leading-relaxed text-holo/35">
            1) Создайте бота у @BotFather 2) Задеплойте worker с секретами 3)
            Нажмите /start у бота 4) Включите алерты здесь. «Слежение за сетапами»
            — бот напишет, когда выбранный сетап станет READY (даже если Mini App
            закрыт, после деплоя worker).
          </p>
        </div>
      </div>
    </>
  )
}

export default TelegramAlertsPanel
