import {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_PRIMARY_MODEL,
  type Env,
} from '../env'
import type { AdvisorMode } from '../prompt'
import { openAiCompatProvider } from './openaiCompat'
import type { ChatProvider, ProviderErrorKind } from './types'
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

/**
 * Free-tier-first external providers. Gemini is the strongest free option, Nemotron
 * via OpenRouter is the backup when Gemini is rate-limited or the key is missing.
 */
const EXTERNAL: ExternalSpec[] = [
  {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: (env) => env.GEMINI_API_KEY,
    model: (env) => env.GEMINI_MODEL,
    defaultModel: 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.8-flash',
  },
  {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: (env) => env.OPENROUTER_API_KEY,
    model: (env) => env.OPENROUTER_MODEL,
    defaultModel: 'nvidia/nemotron-3.5-super-vl:free,nvidia/nemotron-3-ultra-550b-a55b:free',
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

/** Models that just failed are skipped for a while, so one dead model does not tax every request. */
const COOLDOWN_MS: Record<ProviderErrorKind, number> = {
  quota: 10 * 60_000,
  capacity: 2 * 60_000,
  unavailable: 10 * 60_000,
  bad_request: 2 * 60_000,
  unknown: 60_000,
}
const coolingUntil = new Map<string, number>()

function modelKey(id: string, model: string): string {
  return `${id}:${model}`
}

export function markModelCooldown(id: string, model: string, kind: ProviderErrorKind): void {
  coolingUntil.set(modelKey(id, model), Date.now() + COOLDOWN_MS[kind])
}

export function isModelCooling(id: string, model: string, now = Date.now()): boolean {
  const until = coolingUntil.get(modelKey(id, model))
  if (until == null) return false
  if (until <= now) {
    coolingUntil.delete(modelKey(id, model))
    return false
  }
  return true
}

function splitModels(raw: string | undefined, fallback: string): string[] {
  const source = raw?.trim() || fallback
  return source
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
}

function externalChain(env: Env, ignoreCooldown: boolean): ChatProvider[] {
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
    return splitModels(s.model(env), s.defaultModel)
      .filter((model) => ignoreCooldown || !isModelCooling(s.id, model))
      .map((model) =>
        openAiCompatProvider({
          id: s.id,
          baseUrl: s.baseUrl,
          apiKey,
          model,
          extraHeaders: s.extraHeaders,
        })
      )
  })
}

export interface ChainOptions {
  /** false when this account's Workers AI daily allocation is gone */
  workersAi?: boolean
  /** `trade` keeps personal/trade data on Workers AI unless externally allowed */
  mode?: AdvisorMode
  /** /health wants to list every configured model, including cooling ones */
  ignoreCooldown?: boolean
}

/**
 * Hybrid routing:
 *   - normal modes → external free providers first (Gemini → OpenRouter → Groq), Workers AI as backup;
 *   - `trade` → Workers AI first, external only with `ALLOW_EXTERNAL_TRADES=1`
 *     (trades/journal are stripped from the snapshot for every external provider anyway).
 */
export function providerChain(env: Env, opts: ChainOptions = {}): ChatProvider[] {
  const ignoreCooldown = opts.ignoreCooldown === true
  const allowThinking = env.DISABLE_THINKING === '0'
  const models = [
    ...splitModels(env.MODEL_PRIMARY, DEFAULT_PRIMARY_MODEL),
    ...splitModels(env.MODEL_FALLBACK, DEFAULT_FALLBACK_MODEL),
  ].filter((m, i, all) => all.indexOf(m) === i)

  const local =
    opts.workersAi === false
      ? []
      : models
          .filter((model) => ignoreCooldown || !isModelCooling('workers-ai', model))
          .map((model) => workersAiProvider(env.AI, model, allowThinking))

  const externalAllowed = opts.mode !== 'trade' || env.ALLOW_EXTERNAL_TRADES === '1'
  const external = externalAllowed ? externalChain(env, ignoreCooldown) : []

  const chain = opts.mode === 'trade' ? [...local, ...external] : [...external, ...local]
  // Everything is cooling: better to retry a known-bad model than report a fake quota error.
  if (!chain.length && !ignoreCooldown) {
    return providerChain(env, { ...opts, ignoreCooldown: true })
  }
  return chain
}

/** Human-readable provider list for `/health` (secrets are never exposed). */
export interface HealthProvider {
  id: string
  model: string
  external: boolean
}

export function healthProviders(env: Env): HealthProvider[] {
  return providerChain(env, { ignoreCooldown: true }).map((p) => ({
    id: p.id,
    model: p.model,
    external: p.external === true,
  }))
}
