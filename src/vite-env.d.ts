/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean
  readonly MODE: string
  readonly VITE_MEXC_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
