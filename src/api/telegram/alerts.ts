/**
 * Client for Telegram alerts via Cloudflare Worker.
 */

import type { ConditionalSetup, WatchedSetup } from '../../engine/setups'

export type AlertType = 'SNIPER' | 'MEME' | 'SYSTEM' | 'SETUP_WATCH'

export interface TelegramAlertPayload {
  type: AlertType
  title: string
  text: string
  dedupeKey?: string
  chatId?: number
}

function getProxyBase(): string {
  const envUrl = import.meta.env.VITE_MEXC_PROXY_URL as string | undefined
  if (envUrl && envUrl.trim()) {
    return envUrl.replace(/\/$/, '')
  }
  return ''
}

function getAlertSecret(): string {
  return (import.meta.env.VITE_ALERT_SECRET as string | undefined)?.trim() ?? ''
}

export function isTelegramAlertsConfigured(): boolean {
  return Boolean(getProxyBase())
}

export function getTelegramBotUsername(): string {
  return (
    (import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined)?.trim() ??
    ''
  )
}

export function getTelegramBotLink(): string | null {
  const u = getTelegramBotUsername().replace(/^@/, '')
  return u ? `https://t.me/${u}` : null
}

async function postJson(
  path: string,
  body: unknown,
  withSecret = false
): Promise<Response> {
  const base = getProxyBase()
  if (!base) throw new Error('VITE_MEXC_PROXY_URL not set')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (withSecret) {
    const secret = getAlertSecret()
    if (secret) headers['X-Alert-Secret'] = secret
  }

  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** Подписать chat_id на алерты */
export async function subscribeTelegramAlerts(input: {
  chatId: number
  username?: string
  sniper?: boolean
  meme?: boolean
}): Promise<boolean> {
  try {
    const res = await postJson('/telegram/subscribe', input)
    return res.ok
  } catch {
    return false
  }
}

export async function unsubscribeTelegramAlerts(
  chatId: number
): Promise<boolean> {
  try {
    const res = await postJson('/telegram/unsubscribe', { chatId })
    return res.ok
  } catch {
    return false
  }
}

/** Отправить сигнал всем подписчикам (или одному chatId) */
export async function sendTelegramAlert(
  payload: TelegramAlertPayload
): Promise<{ ok: boolean; skipped?: boolean }> {
  try {
    const res = await postJson('/telegram/alert', payload, true)
    if (!res.ok) return { ok: false }
    const data = (await res.json()) as { skipped?: string }
    return { ok: true, skipped: data.skipped === 'dedup' }
  } catch {
    return { ok: false }
  }
}

export async function checkTelegramHealth(): Promise<{
  ok: boolean
  subscribers?: number
} | null> {
  const base = getProxyBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/telegram/health`)
    if (!res.ok) return { ok: false }
    return (await res.json()) as { ok: boolean; subscribers?: number }
  } catch {
    return null
  }
}

/** Создать офлайн-watch сетапа на worker */
export async function createWatchedSetup(input: {
  chatId: number
  setup: ConditionalSetup
  symbol: string
  internalSymbol: string
  ttlHours?: number
}): Promise<WatchedSetup | null> {
  try {
    const res = await postJson('/telegram/watch', input, true)
    if (!res.ok) return null
    const data = (await res.json()) as { ok: boolean; watch?: WatchedSetup }
    return data.watch ?? null
  } catch {
    return null
  }
}

export async function removeWatchedSetup(input: {
  chatId: number
  watchId: string
}): Promise<boolean> {
  try {
    const res = await postJson('/telegram/watch/delete', input, true)
    return res.ok
  } catch {
    return false
  }
}

export async function listWatchedSetups(
  chatId: number
): Promise<WatchedSetup[]> {
  const base = getProxyBase()
  if (!base) return []
  try {
    const res = await fetch(
      `${base}/telegram/watches?chatId=${encodeURIComponent(String(chatId))}`
    )
    if (!res.ok) return []
    const data = (await res.json()) as { watches?: WatchedSetup[] }
    return data.watches ?? []
  } catch {
    return []
  }
}
