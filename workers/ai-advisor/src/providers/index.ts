import { DEFAULT_FALLBACK_MODEL, DEFAULT_PRIMARY_MODEL, type Env } from '../env'
import type { ChatProvider } from './types'
import { workersAiProvider } from './workersAi'

export * from './types'

/** Ordered provider chain for this node. External providers (GigaChat etc.) plug in here. */
export function providerChain(env: Env): ChatProvider[] {
  const disableThinking = env.DISABLE_THINKING !== '0'
  const models = [
    env.MODEL_PRIMARY?.trim() || DEFAULT_PRIMARY_MODEL,
    env.MODEL_FALLBACK?.trim() || DEFAULT_FALLBACK_MODEL,
  ].filter((m, i, all) => m && all.indexOf(m) === i)
  return models.map((m) => workersAiProvider(env.AI, m, disableThinking))
}
