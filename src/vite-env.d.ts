/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly MODE: string
  readonly VITE_MEXC_PROXY_URL?: string
  readonly VITE_ALERT_SECRET?: string
  readonly VITE_TELEGRAM_BOT_USERNAME?: string
  /** Comma-separated ai-advisor worker URLs (ring order). Not secret. */
  readonly VITE_ADVISOR_URLS?: string
  /** Overrides the built-in ai-advisor access token */
  readonly VITE_ADVISOR_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
