/**
 * AI advisor client — walks the ring of ai-advisor workers (settings override →
 * VITE_ADVISOR_URLS → built-in ring). A node that answers 429 "exhausted" is skipped
 * until the next 00:00 UTC (persisted); network / 5xx / 404 errors cool a node down
 * for 2 minutes. The access token is built into the bundle (single-user app, it only
 * gates free Workers AI quota); a token saved in settings overrides it.
 */

export type AdvisorMode = 'chat' | 'market' | 'radar' | 'coin' | 'trade' | 'setups'

export interface AdvisorChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AdvisorMeta {
  node: string
  model: string
  provider: string
  url: string
}

export type AdvisorErrorKind = 'no_urls' | 'no_token' | 'auth' | 'exhausted' | 'unavailable' | 'stream'

export class AdvisorError extends Error {
  readonly kind: AdvisorErrorKind

  constructor(kind: AdvisorErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'AdvisorError'
  }
}

const BUILTIN_ADVISOR_URLS = [
  'https://ai-advisor.sergiodecaux.workers.dev',
  'https://ai-advisor-2.sergiodecaux.workers.dev',
  'https://ai-advisor-4.sergiodecaux.workers.dev',
  'https://ai-advisor.mexc-standby.workers.dev',
  'https://ai-advisor.mexc-c.workers.dev',
  'https://ai-advisor.mexc-f.workers.dev',
]
const BUILTIN_ADVISOR_TOKEN = 'e6d6023342fb603fb6733b6e5d6e34e2081b6fe638dbb235aebe9cdd73562ba3'

const TOKEN_KEY = 'advisor.token'
const URLS_KEY = 'advisor.urls'
const EXHAUSTED_KEY = 'advisor.exhausted'
const DEAD_COOLDOWN_MS = 2 * 60_000
const BURST_COOLDOWN_MS = 30_000

const deadUntil = new Map<string, number>()

function readLs(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeLs(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* private mode */
  }
}

function parseUrlList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter((u, i, all) => /^https?:\/\//.test(u) && all.indexOf(u) === i)
}

/** Token saved in settings on this device; empty = use the built-in one */
export function getAdvisorTokenOverride(): string {
  return readLs(TOKEN_KEY).trim()
}

export function getAdvisorToken(): string {
  return (
    getAdvisorTokenOverride() ||
    (import.meta.env.VITE_ADVISOR_TOKEN ?? '').trim() ||
    BUILTIN_ADVISOR_TOKEN
  )
}

export function setAdvisorToken(token: string): void {
  writeLs(TOKEN_KEY, token.trim())
}

/** Raw override from settings; empty = use VITE_ADVISOR_URLS */
export function getAdvisorUrlOverride(): string {
  return readLs(URLS_KEY)
}

export function setAdvisorUrlOverride(raw: string): void {
  writeLs(URLS_KEY, raw.trim())
}

export function getDefaultAdvisorUrls(): string[] {
  const fromEnv = parseUrlList(import.meta.env.VITE_ADVISOR_URLS ?? '')
  return fromEnv.length ? fromEnv : BUILTIN_ADVISOR_URLS
}

export function getAdvisorUrls(): string[] {
  const override = parseUrlList(getAdvisorUrlOverride())
  return override.length ? override : getDefaultAdvisorUrls()
}

export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

function readExhausted(now = Date.now()): Record<string, number> {
  try {
    const parsed = JSON.parse(readLs(EXHAUSTED_KEY) || '{}') as Record<string, number>
    const alive: Record<string, number> = {}
    for (const [url, until] of Object.entries(parsed)) {
      if (typeof until === 'number' && until > now) alive[url] = until
    }
    return alive
  } catch {
    return {}
  }
}

function markExhausted(url: string, resetAt?: number): void {
  const map = readExhausted()
  const until = resetAt && resetAt > Date.now() ? resetAt : nextUtcMidnight()
  map[url] = until
  writeLs(EXHAUSTED_KEY, JSON.stringify(map))
}

export function clearAdvisorExhausted(): void {
  writeLs(EXHAUSTED_KEY, '')
  deadUntil.clear()
}

export interface AdvisorNodeState {
  url: string
  exhaustedUntil: number | null
  coolingUntil: number | null
}

export function getAdvisorNodeStates(): AdvisorNodeState[] {
  const now = Date.now()
  const exhausted = readExhausted(now)
  return getAdvisorUrls().map((url) => {
    const dead = deadUntil.get(url) ?? 0
    return {
      url,
      exhaustedUntil: exhausted[url] ?? null,
      coolingUntil: dead > now ? dead : null,
    }
  })
}

/** Healthy nodes first (ring order), cooling ones as last resort; exhausted are skipped. */
function candidateOrder(urls: string[]): string[] {
  const now = Date.now()
  const exhausted = readExhausted(now)
  const usable = urls.filter((u) => !exhausted[u])
  const healthy = usable.filter((u) => (deadUntil.get(u) ?? 0) <= now)
  const cooling = usable.filter((u) => (deadUntil.get(u) ?? 0) > now)
  return [...healthy, ...cooling]
}

function allExhaustedError(): AdvisorError {
  const until = Object.values(readExhausted())
  const resetAt = until.length ? Math.min(...until) : nextUtcMidnight()
  const time = new Date(resetAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return new AdvisorError('exhausted', `Дневной лимит исчерпан на всех узлах. Сброс в ${time}.`)
}

function telegramInitData(): string {
  const w = window as unknown as { Telegram?: { WebApp?: { initData?: string } } }
  return w.Telegram?.WebApp?.initData ?? ''
}

interface ErrorBody {
  error?: string
  exhausted?: boolean
  resetAt?: number
}

async function readErrorBody(res: Response): Promise<ErrorBody> {
  try {
    return (await res.json()) as ErrorBody
  } catch {
    return {}
  }
}

interface SseEvent {
  event: string
  data: string
}

async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let sep = buffer.indexOf('\n\n')
      while (sep >= 0) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf('\n\n')
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trim())
        }
        if (data.length) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export interface StreamAdvisorOptions {
  messages: AdvisorChatMessage[]
  snapshot: unknown
  mode: AdvisorMode
  signal?: AbortSignal
  onMeta?: (meta: AdvisorMeta) => void
  onDelta: (text: string) => void
}

export async function streamAdvisorChat(opts: StreamAdvisorOptions): Promise<AdvisorMeta> {
  const urls = getAdvisorUrls()
  if (!urls.length) {
    throw new AdvisorError('no_urls', 'Не задан список узлов советника (VITE_ADVISOR_URLS или настройки).')
  }
  const token = getAdvisorToken()
  const initData = telegramInitData()
  if (!token && !initData) {
    throw new AdvisorError('no_token', 'Введите токен доступа в настройках советника.')
  }

  const order = candidateOrder(urls)
  if (!order.length) throw allExhaustedError()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (initData) headers['X-Telegram-Init-Data'] = initData
  const body = JSON.stringify({ messages: opts.messages, snapshot: opts.snapshot, mode: opts.mode })

  let authFailures = 0
  let lastProblem = ''

  for (const url of order) {
    let res: Response
    try {
      res = await fetch(`${url}/chat`, { method: 'POST', headers, body, signal: opts.signal })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      deadUntil.set(url, Date.now() + DEAD_COOLDOWN_MS)
      lastProblem = 'нет связи'
      continue
    }

    if (!res.ok) {
      const info = await readErrorBody(res)
      if (res.status === 401 || res.status === 403) {
        authFailures++
        lastProblem = 'токен не принят'
      } else if (res.status === 429 && info.exhausted) {
        markExhausted(url, info.resetAt)
        lastProblem = 'лимит узла исчерпан'
      } else if (res.status === 429) {
        deadUntil.set(url, Date.now() + BURST_COOLDOWN_MS)
        lastProblem = 'слишком часто'
      } else {
        deadUntil.set(url, Date.now() + DEAD_COOLDOWN_MS)
        lastProblem = info.error ?? `HTTP ${res.status}`
      }
      continue
    }

    deadUntil.delete(url)
    let meta: AdvisorMeta = { node: '?', model: '?', provider: '?', url }
    let gotText = false
    let streamProblem = ''
    try {
      for await (const ev of readSse(res, opts.signal)) {
        let data: Record<string, unknown>
        try {
          data = JSON.parse(ev.data) as Record<string, unknown>
        } catch {
          continue
        }
        if (ev.event === 'meta') {
          meta = {
            url,
            node: String(data.node ?? '?'),
            model: String(data.model ?? '?'),
            provider: String(data.provider ?? '?'),
          }
          opts.onMeta?.(meta)
        } else if (ev.event === 'error') {
          streamProblem = String(data.message ?? 'ошибка модели')
          break
        } else if (ev.event === 'done') {
          return meta
        } else if (typeof data.d === 'string' && data.d) {
          gotText = true
          opts.onDelta(data.d)
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      streamProblem = 'обрыв связи'
    }
    if (!streamProblem) return meta

    const quota = /4006|daily free allocation|neurons/i.test(streamProblem)
    if (quota) markExhausted(url)
    else deadUntil.set(url, Date.now() + DEAD_COOLDOWN_MS)
    // Text already shown to the user can't be replayed from another node.
    if (gotText) throw new AdvisorError('stream', `Ответ прерван: ${streamProblem}`)
    lastProblem = quota ? 'лимит узла исчерпан' : streamProblem
  }

  if (authFailures === order.length) {
    throw new AdvisorError('auth', 'Токен доступа не принят ни одним узлом.')
  }
  if (!candidateOrder(urls).length) throw allExhaustedError()
  throw new AdvisorError('unavailable', `Советник недоступен (${lastProblem}). Попробуйте позже.`)
}

export interface AdvisorHealth {
  url: string
  ok: boolean
  node?: string
  configured?: boolean
  models?: string[]
  used?: number
  cap?: number
  exhausted?: boolean
  error?: string
}

export async function probeAdvisorNodes(): Promise<AdvisorHealth[]> {
  return Promise.all(
    getAdvisorUrls().map(async (url): Promise<AdvisorHealth> => {
      try {
        const res = await fetch(`${url}/health`, { headers: { Accept: 'application/json' } })
        if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` }
        const data = (await res.json()) as Omit<AdvisorHealth, 'url'>
        return { ...data, url, ok: true }
      } catch (err) {
        return { url, ok: false, error: (err as Error).message }
      }
    })
  )
}
