import { DEFAULT_FALLBACK_MODEL, DEFAULT_PRIMARY_MODEL, type Env } from '../env'
import { openAiCompatProvider } from './openaiCompat'
import type { ChatProvider } from './types'
import { workersAiProvider } from './workersAi'

export * from './types'

interface ExternalSpec {
  id: string
  baseUrl: string
  key: (env: Env) => string | undefined
  model: (env: Env) => string | undefined
  defaultModel: string
  extraHeaders?: Record<string, string>
}

const EXTERNAL: ExternalSpec[] = [
  {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: (env) => env.GEMINI_API_KEY,
    model: (env) => env.GEMINI_MODEL,
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: (env) => env.OPENROUTER_API_KEY,
    model: (env) => env.OPENROUTER_MODEL,
    defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
    extraHeaders: { 'X-Title': 'enterprise-system advisor' },
  },
  {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    key: (env) => env.GROQ_API_KEY,
    model: (env) => env.GROQ_MODEL,
    defaultModel: 'openai/gpt-oss-120b',
  },
]

function externalChain(env: Env): ChatProvider[] {
  const order = (env.EXTERNAL_ORDER ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const specs = order.length
    ? order.map((id) => EXTERNAL.find((s) => s.id === id)).filter((s): s is ExternalSpec => !!s)
    : EXTERNAL
  return specs.flatMap((s) => {
    const apiKey = s.key(env)?.trim()
    if (!apiKey) return []
    return [
      openAiCompatProvider({
        id: s.id,
        baseUrl: s.baseUrl,
        apiKey,
        model: s.model(env)?.trim() || s.defaultModel,
        extraHeaders: s.extraHeaders,
      }),
    ]
  })
}

/**
 * Ordered provider chain for this node: external APIs first, then this account's Workers AI
 * (left out once the account's daily allocation is used up).
 */
export function providerChain(env: Env, opts: { workersAi?: boolean } = {}): ChatProvider[] {
  const disableThinking = env.DISABLE_THINKING !== '0'
  const models = [
    env.MODEL_PRIMARY?.trim() || DEFAULT_PRIMARY_MODEL,
    env.MODEL_FALLBACK?.trim() || DEFAULT_FALLBACK_MODEL,
  ].filter((m, i, all) => m && all.indexOf(m) === i)
  const local = opts.workersAi === false ? [] : models.map((m) => workersAiProvider(env.AI, m, disableThinking))
  return [...externalChain(env), ...local]
}
