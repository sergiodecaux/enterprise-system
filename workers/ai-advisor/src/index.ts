/**
 * AI advisor worker — one codebase, deployed to N Cloudflare accounts (see wrangler.toml envs).
 * The client walks the ring (VITE_ADVISOR_URLS) and skips nodes that answer 429 "exhausted".
 *
 *   GET  /health  → node status (no auth)
 *   POST /chat    → SSE stream: event meta → data {"d": "..."}* → event done | event error
 */
import { authorize } from './auth'
import { intVar, type Env } from './env'
import {
  burstExceeded,
  markQuotaExhausted,
  recordRequest,
  usageState,
} from './limits'
import { buildMessages, isAdvisorMode, type AdvisorMode } from './prompt'
import {
  healthProviders,
  markModelCooldown,
  providerChain,
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ProviderStream,
  type ReasoningEffort,
} from './providers'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data',
  'Access-Control-Max-Age': '86400',
}

const MAX_BODY_BYTES = 128_000
const DEFAULT_MAX_OUTPUT_TOKENS = 900
const DEEP_MIN_OUTPUT_TOKENS = 1600
/** Workers AI counts hidden thinking tokens against max_tokens */
const WORKERS_THINKING_HEADROOM = 2000
const EXTERNAL_FIRST_TOKEN_MS = 30_000
const EXTERNAL_THINKING_FIRST_TOKEN_MS = 45_000
const LOCAL_FIRST_TOKEN_MS = 40_000
const LOCAL_THINKING_FIRST_TOKEN_MS = 90_000
/**
 * A provider that is slow to produce its first token is raced by the next one instead of
 * blocking the whole answer. The first token from any attempt wins; the rest are aborted.
 */
const HEDGE_DELAY_MS = 8_000
const HEDGE_DELAY_DEEP_MS = 15_000

interface ModeProfile {
  reasoning: ReasoningEffort
  thinking: boolean
  temperature: number
  minTokens?: number
}

/** Cheap modes keep thinking off/low; deep reads get a little more reasoning. */
const MODE_PROFILE: Record<AdvisorMode, ModeProfile> = {
  chat: { reasoning: 'low', thinking: false, temperature: 0.45 },
  market: { reasoning: 'low', thinking: false, temperature: 0.4 },
  radar: { reasoning: 'low', thinking: false, temperature: 0.3 },
  coin: { reasoning: 'medium', thinking: true, temperature: 0.3, minTokens: DEEP_MIN_OUTPUT_TOKENS },
  trade: { reasoning: 'medium', thinking: true, temperature: 0.25, minTokens: 1200 },
  setups: { reasoning: 'medium', thinking: true, temperature: 0.3, minTokens: DEEP_MIN_OUTPUT_TOKENS },
  opportunities: {
    reasoning: 'medium',
    thinking: true,
    temperature: 0.3,
    minTokens: DEEP_MIN_OUTPUT_TOKENS,
  },
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  })
}

interface ChatBody {
  messages?: unknown
  snapshot?: unknown
  mode?: unknown
}

function parseHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const { role, content } = m as { role?: unknown; content?: unknown }
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      out.push({ role, content })
    }
  }
  return out
}

/**
 * External free tiers may train on what they receive, so personal trading data never
 * leaves Workers AI unless `ALLOW_EXTERNAL_TRADES=1` is set explicitly.
 */
function sanitizeSnapshot(
  snapshot: unknown,
  external: boolean,
  opts: { allowTradeData: boolean }
): unknown {
  if (!external || snapshot == null) return snapshot

  let data: unknown = snapshot
  if (typeof snapshot === 'string') {
    try {
      data = JSON.parse(snapshot)
    } catch {
      return snapshot
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  try {
    data = JSON.parse(JSON.stringify(data))
  } catch {
    return snapshot
  }

  const root = data as Record<string, unknown>
  if (!opts.allowTradeData) {
    delete root.trades
    delete root.journal
    delete root.focusTradeId
  }
  // The watchlist is never needed for an external answer.
  const hunt = root.hunt
  if (hunt && typeof hunt === 'object' && !Array.isArray(hunt)) {
    delete (hunt as Record<string, unknown>).watches
  }
  return root
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([
    promise.finally(() => {
      if (timer != null) clearTimeout(timer)
    }),
    timeout,
  ])
}

/**
 * Pulls the first token before the SSE response is committed. A provider that accepts
 * the request and then stalls cannot block the answer — the next provider is tried.
 */
async function withFirstToken(stream: ProviderStream, ms: number): Promise<ProviderStream> {
  const iter = stream.deltas[Symbol.asyncIterator]()
  let first: IteratorResult<string>
  try {
    first = await withTimeout(iter.next(), ms, 'first token timeout')
  } catch (err) {
    // Do not await: a stalled read inside the generator would never unwind.
    if (iter.return) void iter.return().catch(() => undefined)
    throw err
  }
  if (first.done || !first.value) {
    if (iter.return) await iter.return().catch(() => undefined)
    throw new ProviderError('capacity', `${stream.provider}: empty stream`)
  }

  return {
    ...stream,
    deltas: (async function* () {
      yield first.value
      try {
        for (;;) {
          const next = await iter.next()
          if (next.done) return
          yield next.value
        }
      } finally {
        if (iter.return) void iter.return().catch(() => undefined)
      }
    })(),
  }
}

interface OpenInput {
  history: ChatMessage[]
  snapshot: unknown
  mode: AdvisorMode
  signal?: AbortSignal
}

async function openFirstAvailable(
  chain: ChatProvider[],
  env: Env,
  input: OpenInput
): Promise<ProviderStream | ProviderError> {
  const base = intVar(env.MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS)
  const profile = MODE_PROFILE[input.mode]
  const maxTokens = Math.max(base, profile.minTokens ?? base)
  const allowTradeData = input.mode === 'trade' && env.ALLOW_EXTERNAL_TRADES === '1'
  // Global kill switch: "1" disables Workers AI thinking even in deep modes.
  const thinking = env.DISABLE_THINKING === '1' ? false : profile.thinking
  const hedgeMs = profile.thinking ? HEDGE_DELAY_DEEP_MS : HEDGE_DELAY_MS

  if (!chain.length) return new ProviderError('unknown', 'No providers configured')
  if (input.signal?.aborted) return new ProviderError('unknown', 'Client aborted')

  const controllers = new Map<number, AbortController>()
  /** Attempts aborted by us (winner found / request failed) must not poison model cooldowns. */
  const cancelled = new Set<number>()

  return new Promise<ProviderStream | ProviderError>((resolve) => {
    let nextIndex = 0
    let pending = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastError = new ProviderError('unknown', 'No providers configured')

    const clearHedge = () => {
      if (timer != null) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const finish = (result: ProviderStream | ProviderError, winnerId?: number) => {
      if (settled) return
      settled = true
      clearHedge()
      for (const [id, controller] of controllers) {
        if (id === winnerId) continue
        cancelled.add(id)
        controller.abort()
      }
      resolve(result)
    }

    const launch = (): void => {
      if (settled || nextIndex >= chain.length) return
      const id = nextIndex
      const provider = chain[nextIndex++]
      const external = provider.external === true
      const controller = new AbortController()
      controllers.set(id, controller)

      // Keep the attempt tied to the client connection so stop/disconnect aborts it.
      const clientSignal = input.signal
      if (clientSignal) {
        const onAbort = () => controller.abort()
        clientSignal.addEventListener('abort', onAbort, { once: true })
        controller.signal.addEventListener(
          'abort',
          () => clientSignal.removeEventListener('abort', onAbort),
          { once: true }
        )
      }

      pending++
      const providerMaxTokens = external
        ? maxTokens
        : maxTokens + (thinking ? WORKERS_THINKING_HEADROOM : 0)
      const firstTokenMs = external
        ? thinking
          ? EXTERNAL_THINKING_FIRST_TOKEN_MS
          : EXTERNAL_FIRST_TOKEN_MS
        : thinking
          ? LOCAL_THINKING_FIRST_TOKEN_MS
          : LOCAL_FIRST_TOKEN_MS

      const attempt = (async () => {
        const stream = await provider.open({
          messages: buildMessages({
            history: input.history,
            snapshot: sanitizeSnapshot(input.snapshot, external, { allowTradeData }),
            mode: input.mode,
          }),
          maxTokens: providerMaxTokens,
          temperature: profile.temperature,
          reasoningEffort: profile.reasoning,
          thinking,
          signal: controller.signal,
        })
        return withFirstToken(stream, firstTokenMs)
      })()

      attempt.then(
        (stream) => {
          pending--
          if (settled) {
            cancelled.add(id)
            controller.abort()
            void stream.deltas[Symbol.asyncIterator]().return?.()
            return
          }
          finish(stream, id)
        },
        (err: unknown) => {
          pending--
          if (settled) return
          // Client abort or an intentional loser cancellation — not the model's fault.
          if (cancelled.has(id) || controller.signal.aborted) {
            if (input.signal?.aborted) finish(new ProviderError('unknown', 'Client aborted'))
            else if (pending === 0 && nextIndex >= chain.length) finish(lastError)
            return
          }
          const failure =
            err instanceof ProviderError ? err : new ProviderError('unknown', String(err))
          lastError = failure
          markModelCooldown(provider.id, provider.model, failure.kind)
          console.warn(
            `[advisor] ${provider.id}/${provider.model} failed: ${failure.kind} ${failure.message}`
          )
          // External quota is classified as capacity; a real Workers AI quota ends the chain.
          if (failure.kind === 'quota') {
            finish(failure)
            return
          }
          if (pending === 0) {
            // Nothing is running: move to the next model immediately instead of idling.
            clearHedge()
            if (nextIndex < chain.length) launch()
            else finish(failure)
          }
        }
      )

      if (nextIndex < chain.length) {
        clearHedge()
        timer = setTimeout(() => {
          timer = undefined
          console.log(`[advisor] hedge: ${chain[nextIndex - 1]?.id ?? '?'} is slow, racing next model`)
          launch()
        }, hedgeMs)
      }
    }

    launch()
  })
}

function sseResponse(
  stream: ProviderStream,
  node: string,
  ctx: ExecutionContext,
  signal: AbortSignal
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  let aborted = false
  const send = (event: string | null, data: unknown) =>
    writer.write(
      enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    )

  const onAbort = () => {
    aborted = true
    writer.abort().catch(() => undefined)
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  const pump = async () => {
    try {
      if (aborted) return
      await send('meta', { provider: stream.provider, model: stream.model, node })
      for await (const piece of stream.deltas) {
        if (aborted) break
        await send(null, { d: piece })
      }
      if (!aborted) await send('done', { usage: stream.usage() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/4006|daily free allocation|neurons/i.test(message)) await markQuotaExhausted()
      if (!aborted) {
        await send('error', { message: message.slice(0, 300) }).catch(() => undefined)
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (!aborted) await writer.close().catch(() => undefined)
    }
  }
  ctx.waitUntil(pump())

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Advisor-Node': node,
    },
  })
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authorize(request, env)
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status)

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Body too large' }, 413)
  let body: ChatBody
  try {
    body = JSON.parse(raw) as ChatBody
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  const history = parseHistory(body.messages)
  if (!history.some((m) => m.role === 'user')) {
    return json({ ok: false, error: 'No user message' }, 400)
  }
  const mode: AdvisorMode = isAdvisorMode(body.mode) ? body.mode : 'chat'

  const usage = await usageState(env)
  const chain = providerChain(env, { workersAi: !usage.exhausted, mode })
  if (!chain.length) {
    return json(
      { ok: false, error: 'Daily limit reached on this node', exhausted: true, resetAt: usage.resetAt },
      429
    )
  }
  if (burstExceeded()) {
    return json({ ok: false, error: 'Too many requests, slow down', exhausted: false }, 429, {
      'Retry-After': '20',
    })
  }

  const opened = await openFirstAvailable(chain, env, {
    history,
    snapshot: body.snapshot,
    mode,
    signal: request.signal,
  })
  if (opened instanceof ProviderError) {
    if (opened.kind === 'quota' || (usage.exhausted && opened.kind !== 'bad_request')) {
      ctx.waitUntil(markQuotaExhausted())
      return json(
        { ok: false, error: 'Workers AI daily allocation used up', exhausted: true, resetAt: usage.resetAt },
        429
      )
    }
    return json({ ok: false, error: opened.message, kind: opened.kind }, 502)
  }

  ctx.waitUntil(recordRequest(usage.used, opened.provider === 'workers-ai'))
  return sseResponse(opened, env.NODE_LABEL ?? '?', ctx, request.signal)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

    if (url.pathname === '/health' && request.method === 'GET') {
      const usage = await usageState(env)
      const providers = healthProviders(env)
      return json({
        ok: true,
        node: env.NODE_LABEL ?? '?',
        configured: Boolean(env.ADVISOR_TOKEN?.trim()),
        telegramAuth: Boolean(env.TELEGRAM_BOT_TOKEN && env.ALLOWED_TG_IDS),
        models: providers.map((p) => p.model),
        providers,
        externalTradeData: env.ALLOW_EXTERNAL_TRADES === '1',
        ...usage,
      })
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      try {
        return await handleChat(request, env, ctx)
      } catch (err) {
        console.error('[advisor] chat failed', err)
        return json({ ok: false, error: 'Internal error' }, 500)
      }
    }

    return json({ ok: false, error: 'Not found' }, 404)
  },
}
