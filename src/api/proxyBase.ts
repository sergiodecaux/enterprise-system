/**
 * Cloudflare Worker that proxies MEXC, news and Telegram alerts.
 * Vite env wins; production builds fall back so APK / static hosts
 * still work when `.env` was missing at `vite build`.
 */
const PRODUCTION_PROXY_FALLBACK = 'https://mexc-proxy.sergiodecaux.workers.dev'

export function getProxyBaseUrl(): string {
  const envUrl = import.meta.env.VITE_MEXC_PROXY_URL?.trim()
  if (envUrl) return envUrl.replace(/\/$/, '')
  if (import.meta.env.PROD) return PRODUCTION_PROXY_FALLBACK
  return ''
}
