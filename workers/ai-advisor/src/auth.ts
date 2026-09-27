import type { Env } from './env'

const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
async function verifyTelegramInitData(env: Env, initData: string): Promise<boolean> {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim()
  const allowed = (env.ALLOWED_TG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!botToken || allowed.length === 0 || !initData) return false

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return false
  params.delete('hash')

  const authDate = Number(params.get('auth_date'))
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) {
    return false
  }

  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = await hmac(new TextEncoder().encode('WebAppData'), botToken)
  const expected = toHex(await hmac(secret, dataCheck))
  if (!safeEqual(expected, hash)) return false

  try {
    const user = JSON.parse(params.get('user') ?? '{}') as { id?: number }
    return user.id != null && allowed.includes(String(user.id))
  } catch {
    return false
  }
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string }

export async function authorize(request: Request, env: Env): Promise<AuthResult> {
  const expected = env.ADVISOR_TOKEN?.trim()
  if (!expected) {
    return { ok: false, status: 503, error: 'ADVISOR_TOKEN is not configured on this node' }
  }

  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (token && safeEqual(token, expected)) return { ok: true }

  const initData = request.headers.get('X-Telegram-Init-Data') ?? ''
  if (initData && (await verifyTelegramInitData(env, initData))) return { ok: true }

  return { ok: false, status: 401, error: 'Unauthorized' }
}
