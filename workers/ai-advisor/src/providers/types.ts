export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  maxTokens: number
  temperature: number
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
}

export interface ProviderStream {
  provider: string
  model: string
  deltas: AsyncIterable<string>
  /** Filled once the stream has been fully consumed */
  usage: () => TokenUsage | null
}

/**
 * quota       — daily allocation is gone on this account (no point trying same-account models)
 * capacity    — temporary overload, another model may work
 * unavailable — model retired / not on this plan
 * bad_request — input rejected by this model
 */
export type ProviderErrorKind =
  | 'quota'
  | 'capacity'
  | 'unavailable'
  | 'bad_request'
  | 'unknown'

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind

  constructor(kind: ProviderErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'ProviderError'
  }
}

export interface ChatProvider {
  id: string
  model: string
  open(req: ChatRequest): Promise<ProviderStream>
}
