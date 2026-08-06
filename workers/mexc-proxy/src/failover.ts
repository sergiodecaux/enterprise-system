/**
 * Dual Cloudflare account failover.
 *
 * Primary (FAILOVER_ROLE=primary) runs until daily budget / subrequest failures.
 * Then POST to peer /telegram/failover/activate — standby takes TG webhooks + cron work.
 *
 * Secrets/vars (both workers):
 *   FAILOVER_ROLE=primary|standby
 *   FAILOVER_PEER_URL=https://other.workers.dev
 *   FAILOVER_SECRET=shared-random
 *   PUBLIC_BASE_URL=https://this.workers.dev
 *   FAILOVER_DAILY_BUDGET=80000  (Free ≈100k/day — leave headroom)
 */

export type FailoverRole = 'primary' | 'standby'

export interface FailoverState {
  role: FailoverRole
  /** This worker currently owns meme/elite cron + webhooks */
  active: boolean
  dayKey: string
  /** Approximate Worker invocations counted today */
  requestCount: number
  subrequestFails: number
  lastHandoffAt: number | null
  lastReason: string | null
  peerUrl: string | null
  updatedAt: number
}

export interface FailoverEnv {
  SUBSCRIBERS?: KVNamespace
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_SNIPER_BOT_TOKEN?: string
  FAILOVER_ROLE?: string
  FAILOVER_PEER_URL?: string
  FAILOVER_SECRET?: string
  PUBLIC_BASE_URL?: string
  FAILOVER_DAILY_BUDGET?: string
}

const STATE_KEY = 'telegram:failover_state'
const DEFAULT_DAILY_BUDGET = 80_000
const SUBREQUEST_FAIL_HANDOFF = 3

function dayKeyUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function roleOf(env: FailoverEnv): FailoverRole {
  return env.FAILOVER_ROLE === 'standby' ? 'standby' : 'primary'
}

function dailyBudget(env: FailoverEnv): number {
  const n = Number(env.FAILOVER_DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET)
  return Number.isFinite(n) && n > 1000 ? n : DEFAULT_DAILY_BUDGET
}

function defaultState(env: FailoverEnv): FailoverState {
  const role = roleOf(env)
  return {
    role,
    // Primary starts active; standby waits for handoff
    active: role === 'primary',
    dayKey: dayKeyUtc(),
    requestCount: 0,
    subrequestFails: 0,
    lastHandoffAt: null,
    lastReason: null,
    peerUrl: env.FAILOVER_PEER_URL ?? null,
    updatedAt: Date.now(),
  }
}

export async function loadFailoverState(
  env: FailoverEnv
): Promise<FailoverState> {
  const base = defaultState(env)
  try {
    const raw = await env.SUBSCRIBERS?.get(STATE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<FailoverState>
    const day = dayKeyUtc()
    const sameDay = parsed.dayKey === day
    return {
      ...base,
      ...parsed,
      role: base.role,
      dayKey: day,
      requestCount: sameDay ? Number(parsed.requestCount ?? 0) : 0,
      subrequestFails: sameDay ? Number(parsed.subrequestFails ?? 0) : 0,
      active:
        typeof parsed.active === 'boolean' ? parsed.active : base.active,
      peerUrl: env.FAILOVER_PEER_URL ?? parsed.peerUrl ?? null,
      updatedAt: Date.now(),
    }
  } catch {
    return base
  }
}

export async function saveFailoverState(
  env: FailoverEnv,
  state: FailoverState
): Promise<void> {
  try {
    await env.SUBSCRIBERS?.put(
      STATE_KEY,
      JSON.stringify({ ...state, updatedAt: Date.now() })
    )
  } catch {
    // best effort
  }
}

/** Call at start of every cron/HTTP that burns the Free daily quota. */
export async function bumpFailoverRequest(
  env: FailoverEnv,
  n = 1
): Promise<FailoverState> {
  const state = await loadFailoverState(env)
  state.requestCount += n
  await saveFailoverState(env, state)
  return state
}

export function failoverConfigured(env: FailoverEnv): boolean {
  return Boolean(env.FAILOVER_PEER_URL && env.FAILOVER_SECRET)
}

export async function shouldRunCronWork(
  env: FailoverEnv
): Promise<{ run: boolean; state: FailoverState; reason?: string }> {
  const state = await bumpFailoverRequest(env, 1)
  if (!failoverConfigured(env)) {
    return { run: true, state, reason: 'failover_disabled' }
  }
  if (!state.active) {
    return { run: false, state, reason: 'standby_idle' }
  }
  const budget = dailyBudget(env)
  if (state.requestCount >= budget) {
    return { run: false, state, reason: 'daily_budget' }
  }
  return { run: true, state }
}

function isSubrequestLimitError(msg: string): boolean {
  return /too many subrequests|subrequest.?limit|100000 requests/i.test(msg)
}

/** Record delivery/scan failure; auto-handoff after repeated CF limit hits. */
export async function noteFailoverFailure(
  env: FailoverEnv,
  error: string | null | undefined
): Promise<{ handedOff: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  if (!failoverConfigured(env) || !state.active) {
    return { handedOff: false, state }
  }
  if (!error || !isSubrequestLimitError(error)) {
    if (state.subrequestFails !== 0) {
      state.subrequestFails = 0
      await saveFailoverState(env, state)
    }
    return { handedOff: false, state }
  }
  state.subrequestFails += 1
  await saveFailoverState(env, state)
  if (state.subrequestFails < SUBREQUEST_FAIL_HANDOFF) {
    return { handedOff: false, state }
  }
  const handed = await handoffToPeer(env, `subrequest_fails×${state.subrequestFails}`)
  return { handedOff: handed.ok, state: handed.state }
}

export async function maybeHandoffOnBudget(
  env: FailoverEnv
): Promise<{ handedOff: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  if (!failoverConfigured(env) || !state.active) {
    return { handedOff: false, state }
  }
  if (state.requestCount < dailyBudget(env)) {
    return { handedOff: false, state }
  }
  const handed = await handoffToPeer(env, `daily_budget ${state.requestCount}`)
  return { handedOff: handed.ok, state: handed.state }
}

async function setTelegramWebhooks(
  env: FailoverEnv,
  baseUrl: string
): Promise<{ meme: boolean; sniper: boolean }> {
  const root = baseUrl.replace(/\/$/, '')
  const out = { meme: false, sniper: false }
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `${root}/telegram/webhook`,
            drop_pending_updates: false,
          }),
        }
      )
      const j = (await r.json()) as { ok?: boolean }
      out.meme = Boolean(j.ok)
    } catch {
      out.meme = false
    }
  }
  if (env.TELEGRAM_SNIPER_BOT_TOKEN) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_SNIPER_BOT_TOKEN}/setWebhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: `${root}/telegram/webhook/sniper`,
            drop_pending_updates: false,
          }),
        }
      )
      const j = (await r.json()) as { ok?: boolean }
      out.sniper = Boolean(j.ok)
    } catch {
      out.sniper = false
    }
  }
  return out
}

export async function activateThisWorker(
  env: FailoverEnv,
  reason: string
): Promise<{ ok: boolean; state: FailoverState; webhooks?: { meme: boolean; sniper: boolean } }> {
  const state = await loadFailoverState(env)
  state.active = true
  state.subrequestFails = 0
  state.lastHandoffAt = Date.now()
  state.lastReason = reason
  await saveFailoverState(env, state)

  const base = env.PUBLIC_BASE_URL
  let webhooks: { meme: boolean; sniper: boolean } | undefined
  if (base) {
    webhooks = await setTelegramWebhooks(env, base)
  }
  return { ok: true, state, webhooks }
}

export async function standbyThisWorker(
  env: FailoverEnv,
  reason: string
): Promise<FailoverState> {
  const state = await loadFailoverState(env)
  state.active = false
  state.lastHandoffAt = Date.now()
  state.lastReason = reason
  await saveFailoverState(env, state)
  return state
}

export async function handoffToPeer(
  env: FailoverEnv,
  reason: string
): Promise<{ ok: boolean; state: FailoverState; peer?: unknown }> {
  const state = await loadFailoverState(env)
  if (!state.active) return { ok: false, state }
  const peer = env.FAILOVER_PEER_URL?.replace(/\/$/, '')
  const secret = env.FAILOVER_SECRET
  if (!peer || !secret) {
    return { ok: false, state }
  }

  await standbyThisWorker(env, `handoff→peer: ${reason}`)

  try {
    const r = await fetch(`${peer}/telegram/failover/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Failover-Secret': secret,
      },
      body: JSON.stringify({
        reason,
        from: roleOf(env),
        at: Date.now(),
        publicBase: env.PUBLIC_BASE_URL ?? null,
      }),
    })
    const body = await r.json().catch(() => ({}))
    const next = await loadFailoverState(env)
    return { ok: r.ok, state: next, peer: body }
  } catch (err) {
    // Peer unreachable — try to stay active so bots don't go dark
    const rescued = await activateThisWorker(
      env,
      `peer_unreachable_rollback: ${reason}`
    )
    return {
      ok: false,
      state: rescued.state,
      peer: { error: String(err) },
    }
  }
}

export function authorizeFailover(
  request: Request,
  env: FailoverEnv
): boolean {
  const secret = env.FAILOVER_SECRET
  if (!secret) return false
  const hdr = request.headers.get('X-Failover-Secret')
  const url = new URL(request.url)
  const q = url.searchParams.get('secret')
  return hdr === secret || q === secret
}
