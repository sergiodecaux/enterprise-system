import type { AiBinding } from '../env'
import {
  ProviderError,
  type ChatProvider,
  type ChatRequest,
  type ProviderErrorKind,
  type ProviderStream,
  type TokenUsage,
} from './types'

export function classifyWorkersAiError(err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err)
  let kind: ProviderErrorKind = 'unknown'
  if (/4006|daily free allocation|neurons/i.test(message)) kind = 'quota'
  else if (/3040|capacity|overloaded|too many requests|\b429\b/i.test(message)) kind = 'capacity'
  else if (/5035|5007|upgrade|no such model|not found|deprecated|\b403\b/i.test(message))
    kind = 'unavailable'
  else if (/5006|5021|invalid|bad input|\b400\b/i.test(message)) kind = 'bad_request'
  return new ProviderError(kind, message.slice(0, 300))
}

interface SseChunk {
  response?: unknown
  choices?: Array<{
    delta?: { content?: unknown }
    text?: unknown
    message?: { content?: unknown }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function chunkText(obj: SseChunk): string {
  if (typeof obj.response === 'string') return obj.response
  const c = obj.choices?.[0]
  const text = c?.delta?.content ?? c?.text ?? c?.message?.content
  return typeof text === 'string' ? text : ''
}

function toUsage(u: SseChunk['usage']): TokenUsage | null {
  if (!u) return null
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens }
}

/** Drops a leading <think>…</think> block if a model leaks its reasoning into content. */
function createThinkFilter(): (piece: string) => string {
  let state: 'probe' | 'thinking' | 'pass' = 'probe'
  let buf = ''
  return (piece) => {
    if (state === 'pass') return piece
    buf += piece
    if (state === 'probe') {
      const trimmed = buf.trimStart()
      if (trimmed.length < 7 && '<think>'.startsWith(trimmed)) return ''
      if (!trimmed.startsWith('<think>')) {
        state = 'pass'
        const out = buf
        buf = ''
        return out
      }
      state = 'thinking'
    }
    const end = buf.indexOf('</think>')
    if (end < 0) return ''
    state = 'pass'
    const out = buf.slice(end + '</think>'.length).trimStart()
    buf = ''
    return out
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onUsage: (u: TokenUsage) => void
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const filter = createThinkFilter()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') return
        let obj: SseChunk
        try {
          obj = JSON.parse(payload) as SseChunk
        } catch {
          continue
        }
        const usage = toUsage(obj.usage)
        if (usage) onUsage(usage)
        const text = filter(chunkText(obj))
        if (text) yield text
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function* once(text: string): AsyncGenerator<string> {
  if (text) yield text
}

export function workersAiProvider(
  ai: AiBinding,
  model: string,
  disableThinking: boolean
): ChatProvider {
  const run = (req: ChatRequest, withKwargs: boolean) => {
    const inputs: Record<string, unknown> = {
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    }
    if (withKwargs) inputs.chat_template_kwargs = { enable_thinking: false }
    return ai.run(model, inputs)
  }

  return {
    id: 'workers-ai',
    model,
    async open(req): Promise<ProviderStream> {
      let raw: unknown
      try {
        raw = await run(req, disableThinking)
      } catch (err) {
        const classified = classifyWorkersAiError(err)
        if (!disableThinking || classified.kind !== 'bad_request') throw classified
        try {
          raw = await run(req, false)
        } catch (retryErr) {
          throw classifyWorkersAiError(retryErr)
        }
      }

      let usage: TokenUsage | null = null
      if (raw instanceof ReadableStream) {
        return {
          provider: 'workers-ai',
          model,
          deltas: parseSse(raw as ReadableStream<Uint8Array>, (u) => {
            usage = u
          }),
          usage: () => usage,
        }
      }
      const obj = (raw ?? {}) as SseChunk
      usage = toUsage(obj.usage)
      return {
        provider: 'workers-ai',
        model,
        deltas: once(createThinkFilter()(chunkText(obj))),
        usage: () => usage,
      }
    },
  }
}
