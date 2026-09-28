import { intVar, type Env } from './env'

/**
 * Soft limits. The hard daily ceiling is Workers AI itself (10k neurons → error 4006),
 * which we remember here so later calls fail fast with 429 instead of hitting the model.
 * Cache API is per-colo and is a no-op on *.workers.dev, so counters are mirrored in
 * isolate memory; both are best-effort — fine for a single-user advisor.
 */

const CACHE_ORIGIN = 'https://ai-advisor.internal'
const DEFAULT_DAILY_CAP = 250
const BURST_WINDOW_MS = 60_000
const BURST_MAX = 8

const burst: number[] = []
const memory = new Map<string, number>()

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

function cacheKey(name: string): Request {
  return new Request(`${CACHE_ORIGIN}/${name}/${utcDay()}`)
}

async function readNumber(name: string): Promise<number> {
  const local = memory.get(`${name}/${utcDay()}`) ?? 0
  const hit = await caches.default.match(cacheKey(name)).catch(() => undefined)
  if (!hit) return local
  const n = Number(await hit.text())
  return Number.isFinite(n) ? Math.max(n, local) : local
}

async function writeNumber(name: string, value: number): Promise<void> {
  memory.set(`${name}/${utcDay()}`, value)
  const ttl = Math.max(60, Math.ceil((nextUtcMidnight() - Date.now()) / 1000))
  await caches.default.put(
    cacheKey(name),
    new Response(String(value), { headers: { 'Cache-Control': `max-age=${ttl}` } })
  )
}

export interface UsageState {
  used: number
  cap: number
  exhausted: boolean
  resetAt: number
}

export async function usageState(env: Env): Promise<UsageState> {
  const cap = intVar(env.DAILY_CAP, DEFAULT_DAILY_CAP)
  const [used, quotaHit] = await Promise.all([readNumber('used'), readNumber('quota')])
  return { used, cap, exhausted: quotaHit > 0 || used >= cap, resetAt: nextUtcMidnight() }
}

export function burstExceeded(now = Date.now()): boolean {
  while (burst.length && now - burst[0] > BURST_WINDOW_MS) burst.shift()
  return burst.length >= BURST_MAX
}

/** `countsDaily` = answered by this account's Workers AI (external providers don't spend its quota) */
export async function recordRequest(used: number, countsDaily: boolean): Promise<void> {
  burst.push(Date.now())
  if (countsDaily) await writeNumber('used', used + 1)
}

export async function markQuotaExhausted(): Promise<void> {
  await writeNumber('quota', 1)
}
