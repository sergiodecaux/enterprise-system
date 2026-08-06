/**
 * Tradable USDT-M universe for meme scan.
 * Public contract/detail + optional private risk_limit (account/region gate).
 */

const MEXC = 'https://contract.mexc.com'
const ACCOUNT_UNIVERSE_KEY = 'scanner:mexc_account_universe_v1'
const ACCOUNT_UNIVERSE_TTL_MS = 6 * 60 * 60_000

export interface MexcAuthEnv {
  MEXC_ACCESS_KEY?: string
  MEXC_SECRET_KEY?: string
  SUBSCRIBERS?: {
    get(key: string): Promise<string | null>
    put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number }
    ): Promise<unknown>
  }
}

interface ContractDetail {
  symbol: string
  displayNameEn?: string
  state?: number
  isHidden?: boolean
  apiAllowed?: boolean
  preMarket?: boolean
  quoteCoin?: string
  settleCoin?: string
  futureType?: number
  type?: number
  maxVol?: number
  appraisal?: boolean
  automaticDelivery?: boolean
  openingTime?: number
}

async function mexcPublicJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'EnterpriseSystem/2.0' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Signed GET for MEXC futures private endpoints. */
export async function mexcPrivateGet<T>(
  path: string,
  env: MexcAuthEnv,
  query = ''
): Promise<T | null> {
  const access = env.MEXC_ACCESS_KEY
  const secret = env.MEXC_SECRET_KEY
  if (!access || !secret) return null
  const ts = String(Date.now())
  const paramStr = query.startsWith('?') ? query.slice(1) : query
  const target = `${access}${ts}${paramStr}`
  const signature = await hmacSha256Hex(secret, target)
  const url = `${MEXC}${path}${
    query ? (query.startsWith('?') ? query : `?${query}`) : ''
  }`
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ApiKey: access,
        'Request-Time': ts,
        Signature: signature,
        'User-Agent': 'EnterpriseSystem/2.0',
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function isStrictPerpetualContract(
  c: ContractDetail | null | undefined
): boolean {
  if (!c?.symbol?.endsWith('_USDT')) return false
  if (c.state !== 0) return false
  if (c.isHidden) return false
  if (c.apiAllowed === false) return false
  if (c.preMarket) return false
  if (c.quoteCoin && c.quoteCoin !== 'USDT') return false
  if (c.settleCoin && c.settleCoin !== 'USDT') return false
  if (c.futureType != null && c.futureType !== 1) return false
  if (c.type != null && c.type !== 1) return false
  if (c.maxVol != null && c.maxVol <= 0) return false
  if (c.appraisal) return false
  if (c.automaticDelivery) return false
  const opening = Number(c.openingTime ?? 0)
  if (opening > Date.now()) return false
  const name = String(c.displayNameEn ?? '').toUpperCase()
  if (!name.includes('PERPETUAL')) return false
  return true
}

function tradableFromDetailPayload(
  data: ContractDetail | ContractDetail[] | null | undefined
): Set<string> {
  if (data == null) return new Set()
  const rows = Array.isArray(data) ? data : [data]
  const out = new Set<string>()
  for (const c of rows) {
    if (isStrictPerpetualContract(c)) out.add(c.symbol)
  }
  return out
}

async function fetchDetailCatalog(
  path: '/api/v1/contract/detail/country' | '/api/v1/contract/detail'
): Promise<Set<string>> {
  const json = await mexcPublicJson<{ data: ContractDetail | ContractDetail[] }>(
    path
  )
  return tradableFromDetailPayload(json?.data)
}

/**
 * Active USDT-M perpetuals.
 * Country catalog is preferred when healthy, but from CF IPs it often returns
 * 403 / HTML / a tiny region list (≥30) that excludes live meme pumps → empty
 * hotlist + silence. Fall back to global /detail whenever country is thin.
 */
export async function fetchPublicTradableSymbols(): Promise<Set<string>> {
  // Global /detail only — country catalog is often 403/tiny from CF and wasted a subrequest.
  const detail = await fetchDetailCatalog('/api/v1/contract/detail')
  if (detail.size >= 30) return detail
  const country = await fetchDetailCatalog('/api/v1/contract/detail/country')
  return country.size >= detail.size ? country : detail
}

/**
 * Symbols the API key can risk-trade (often mirrors region/account availability).
 * Cached in KV ~6h.
 */
export async function fetchAccountTradableSymbols(
  env: MexcAuthEnv
): Promise<Set<string> | null> {
  if (!env.MEXC_ACCESS_KEY || !env.MEXC_SECRET_KEY) return null

  if (env.SUBSCRIBERS) {
    try {
      const cached = await env.SUBSCRIBERS.get(ACCOUNT_UNIVERSE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as { at?: number; symbols?: string[] }
        if (
          parsed.at &&
          Date.now() - parsed.at < ACCOUNT_UNIVERSE_TTL_MS &&
          Array.isArray(parsed.symbols) &&
          parsed.symbols.length > 20
        ) {
          return new Set(parsed.symbols)
        }
      }
    } catch {
      /* rebuild */
    }
  }

  const json = await mexcPrivateGet<{
    success?: boolean
    data?: Record<string, unknown[]> | unknown[]
  }>('/api/v1/private/account/risk_limit', env)

  if (!json?.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
    return null
  }

  const out = new Set<string>()
  for (const sym of Object.keys(json.data)) {
    if (sym.endsWith('_USDT')) out.add(sym)
  }
  if (out.size < 20) return null

  if (env.SUBSCRIBERS) {
    try {
      await env.SUBSCRIBERS.put(
        ACCOUNT_UNIVERSE_KEY,
        JSON.stringify({ at: Date.now(), symbols: [...out] }),
        { expirationTtl: Math.floor(ACCOUNT_UNIVERSE_TTL_MS / 1000) }
      )
    } catch {
      /* ignore */
    }
  }
  return out
}

/**
 * Universe for meme hotlist/scan: public perps ∩ account risk_limit (if keys set).
 */
export async function resolveMemeTradableUniverse(
  env: MexcAuthEnv
): Promise<{ tradable: Set<string>; source: string }> {
  const pub = await fetchPublicTradableSymbols()
  const acct = await fetchAccountTradableSymbols(env)
  if (acct && acct.size > 20) {
    const out = new Set<string>()
    for (const s of pub) {
      if (acct.has(s)) out.add(s)
    }
    if (out.size >= 30) {
      return { tradable: out, source: `public∩account(${out.size})` }
    }
  }
  return {
    tradable: pub,
    source: acct ? `public_only_fallback(${pub.size})` : `public(${pub.size})`,
  }
}
