import {
  ProviderError,
  type ChatProvider,
  type ProviderErrorKind,
  type ProviderStream,
  type TokenUsage,
} from './types'
import { parseSse } from './workersAi'

export interface OpenAiCompatConfig {
  id: string
  baseUrl: string
  apiKey: string
  model: string
  extraHeaders?: Record<string, string>
}

/** Room for hidden reasoning tokens that reasoning models count against max_tokens */
const REASONING_HEADROOM = 4000
const OPEN_TIMEOUT_MS = 45_000

function classify(status: number, body: string): ProviderErrorKind {
  // External limits never mean this Cloudflare node is exhausted — only move to the next provider.
  if (status === 429 || status >= 500) return 'capacity'
  if (status === 401 || status === 403 || status === 404) return 'unavailable'
  if (status === 400 && /model/i.test(body)) return 'unavailable'
  if (status === 400) return 'bad_request'
  return 'unknown'
}

export function openAiCompatProvider(cfg: OpenAiCompatConfig): ChatProvider {
  return {
    id: cfg.id,
    model: cfg.model,
    async open(req): Promise<ProviderStream> {
      let res: Response
      try {
        res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
            ...cfg.extraHeaders,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: req.messages,
            max_tokens: req.maxTokens + REASONING_HEADROOM,
            temperature: req.temperature,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
        })
      } catch (err) {
        throw new ProviderError('capacity', `${cfg.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!res.ok || !res.body) {
        const text = (await res.text().catch(() => '')).slice(0, 300)
        throw new ProviderError(classify(res.status, text), `${cfg.id} HTTP ${res.status}: ${text}`)
      }

      let usage: TokenUsage | null = null
      return {
        provider: cfg.id,
        model: cfg.model,
        deltas: parseSse(res.body, (u) => {
          usage = u
        }),
        usage: () => usage,
      }
    },
  }
}
