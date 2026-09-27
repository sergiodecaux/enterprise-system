import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  clearAdvisorExhausted,
  getAdvisorNodeStates,
  getAdvisorToken,
  getAdvisorUrlOverride,
  getDefaultAdvisorUrls,
  probeAdvisorNodes,
  setAdvisorToken,
  setAdvisorUrlOverride,
  type AdvisorHealth,
} from '../../api/advisor'
import { buildCurrentSnapshot } from '../../hooks/useAdvisorChat'
import { useAppStore } from '../../store/useAppStore'

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

const AdvisorSettings = ({ onDone }: { onDone: () => void }) => {
  const [token, setToken] = useState(getAdvisorToken)
  const [urls, setUrls] = useState(getAdvisorUrlOverride)
  const [health, setHealth] = useState<AdvisorHealth[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [, setTick] = useState(0)
  const selectedCoin = useAppStore((s) => s.selectedCoin)
  const defaults = getDefaultAdvisorUrls()
  const nodes = getAdvisorNodeStates()

  const save = () => {
    setAdvisorToken(token)
    setAdvisorUrlOverride(urls)
    onDone()
  }

  const probe = async () => {
    setAdvisorUrlOverride(urls)
    setProbing(true)
    try {
      setHealth(await probeAdvisorNodes())
    } finally {
      setProbing(false)
    }
  }

  const snap = buildCurrentSnapshot(selectedCoin, null)

  return (
    <div className="space-y-3 font-mono text-[12px] text-holo/80">
      <label className="block">
        <span className="mb-1 block text-[10px] uppercase text-holo/50">
          Токен доступа (хранится только на этом устройстве)
        </span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ADVISOR_TOKEN"
          autoComplete="off"
          className="w-full rounded-lg border border-hull-border bg-space px-3 py-2 text-holo outline-none focus:border-matrix/60"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[10px] uppercase text-holo/50">
          Узлы советника (через запятую или с новой строки; пусто = из сборки)
        </span>
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          rows={3}
          placeholder={defaults.join('\n') || 'https://ai-advisor.<subdomain>.workers.dev'}
          className="w-full resize-none rounded-lg border border-hull-border bg-space px-3 py-2 text-[11px] text-holo outline-none focus:border-matrix/60"
        />
      </label>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase text-holo/50">Состояние узлов</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                clearAdvisorExhausted()
                setTick((t) => t + 1)
              }}
              className="rounded border border-hull-border px-2 py-0.5 text-[10px] text-holo/60 hover:text-holo"
            >
              Сбросить отметки
            </button>
            <button
              type="button"
              onClick={() => void probe()}
              disabled={probing}
              className="flex items-center gap-1 rounded border border-hull-border px-2 py-0.5 text-[10px] text-holo/60 hover:text-holo disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${probing ? 'animate-spin' : ''}`} />
              Проверить
            </button>
          </div>
        </div>
        {nodes.length === 0 && <div className="text-alert">Узлы не заданы</div>}
        {nodes.map((n) => {
          const h = health?.find((x) => x.url === n.url)
          return (
            <div key={n.url} className="rounded border border-hull-border/60 px-2 py-1 text-[10px]">
              <div className="truncate text-holo/70">{n.url.replace(/^https?:\/\//, '')}</div>
              <div className="text-holo/50">
                {n.exhaustedUntil
                  ? `исчерпан до ${timeLabel(n.exhaustedUntil)}`
                  : n.coolingUntil
                    ? `пауза до ${timeLabel(n.coolingUntil)}`
                    : 'готов'}
                {h &&
                  (h.ok
                    ? ` · узел ${h.node} · ${h.used ?? 0}/${h.cap ?? '?'} сегодня${h.configured ? '' : ' · НЕТ ADVISOR_TOKEN'}${h.exhausted ? ' · лимит' : ''}`
                    : ` · ошибка: ${h.error}`)}
              </div>
            </div>
          )
        })}
      </div>

      <div className="text-[10px] text-holo/40">
        Снимок контекста сейчас: ~{snap.approxTokens} токенов ({snap.chars} символов)
        {snap.trimmed.length ? ` · урезано: ${snap.trimmed.join(', ')}` : ''}
      </div>

      <button
        type="button"
        onClick={save}
        className="w-full rounded-lg border border-matrix/40 bg-matrix/10 py-2 text-[12px] font-bold uppercase text-matrix hover:bg-matrix/20"
      >
        Сохранить
      </button>
    </div>
  )
}

export default AdvisorSettings
