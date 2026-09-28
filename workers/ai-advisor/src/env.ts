/** Minimal Workers AI binding surface — avoids the model-name overloads of `Ai`. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  AI: AiBinding
  /** Personal access token (wrangler secret). Without it the worker refuses to serve. */
  ADVISOR_TOKEN?: string
  /** Optional: Telegram Mini App auth via initData HMAC (wrangler secret) */
  TELEGRAM_BOT_TOKEN?: string
  /** Comma-separated Telegram user ids allowed with initData auth */
  ALLOWED_TG_IDS?: string
  MODEL_PRIMARY?: string
  MODEL_FALLBACK?: string
  /** Soft per-account daily request cap (Workers AI free = 10k neurons/day) */
  DAILY_CAP?: string
  MAX_OUTPUT_TOKENS?: string
  /** "0" keeps model reasoning on (costs more neurons and latency) */
  DISABLE_THINKING?: string
  /** Human label of this node in the ring, e.g. "A" */
  NODE_LABEL?: string
  /** External OpenAI-compatible providers (wrangler secrets); tried before Workers AI */
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GROQ_API_KEY?: string
  GROQ_MODEL?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  /** Comma-separated order of external providers, e.g. "gemini,openrouter,groq" */
  EXTERNAL_ORDER?: string
}

export const DEFAULT_PRIMARY_MODEL = '@cf/google/gemma-4-26b-a4b-it'
export const DEFAULT_FALLBACK_MODEL = '@cf/zai-org/glm-4.7-flash'

export function intVar(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
