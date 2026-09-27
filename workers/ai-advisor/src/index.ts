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
import { providerChain, ProviderError, type ChatMessage, type ProviderStream } from './providers'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data',
  'Access-Control-Max-Age': '86400',
}

const MAX_BODY_BYTES = 64_000
const DEFAULT_MAX_OUTPUT_TOKENS = 900

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

async function openFirstAvailable(
  env: Env,
  messages: ChatMessage[]
): Promise<ProviderStream | ProviderError> {
  const maxTokens = intVar(env.MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS)
  let lastError = new ProviderError('unknown', 'No providers configured')
  for (const provider of providerChain(env)) {
    try {
      return await provider.open({ messages, maxTokens, temperature: 0.4 })
    } catch (err) {
      lastError =
        err instanceof ProviderError ? err : new ProviderError('unknown', String(err))
      console.warn(`[advisor] ${provider.model} failed: ${lastError.kind} ${lastError.message}`)
      if (lastError.kind === 'quota') return lastError
    }
  }
  return lastError
}

function sseResponse(
  stream: ProviderStream,
  node: string,
  ctx: ExecutionContext
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  const send = (event: string | null, data: unknown) =>
    writer.write(
      enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    )

  const pump = async () => {
    try {
      await send('meta', { provider: stream.provider, model: stream.model, node })
      for await (const piece of stream.deltas) {
        await send(null, { d: piece })
      }
      await send('done', { usage: stream.usage() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/4006|daily free allocation|neurons/i.test(message)) await markQuotaExhausted()
      await send('error', { message: message.slice(0, 300) }).catch(() => undefined)
    } finally {
      await writer.close().catch(() => undefined)
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
  if (usage.exhausted) {
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

  const messages = buildMessages({ history, snapshot: body.snapshot, mode })
  const opened = await openFirstAvailable(env, messages)
  if (opened instanceof ProviderError) {
    if (opened.kind === 'quota') {
      ctx.waitUntil(markQuotaExhausted())
      return json(
        { ok: false, error: 'Workers AI daily allocation used up', exhausted: true, resetAt: usage.resetAt },
        429
      )
    }
    return json({ ok: false, error: opened.message, kind: opened.kind }, 502)
  }

  ctx.waitUntil(recordRequest(usage.used))
  return sseResponse(opened, env.NODE_LABEL ?? '?', ctx)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

    if (url.pathname === '/health' && request.method === 'GET') {
      const usage = await usageState(env)
      return json({
        ok: true,
        node: env.NODE_LABEL ?? '?',
        configured: Boolean(env.ADVISOR_TOKEN?.trim()),
        telegramAuth: Boolean(env.TELEGRAM_BOT_TOKEN && env.ALLOWED_TG_IDS),
        models: providerChain(env).map((p) => p.model),
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
