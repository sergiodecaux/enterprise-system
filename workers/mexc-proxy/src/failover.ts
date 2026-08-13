/**
 * Dual Cloudflare account failover.
 *
 * Primary runs until daily budget / subrequest failures.
 * Critical: handoff must NOT run inside a tick that already hit
 * «Too many subrequests» — that fetch to peer also fails. Instead we
 * set a pending flag and hand off at the START of the next cron
 * (fresh subrequest budget).
 *
 * Secrets/vars (both workers):
 *   FAILOVER_ROLE=primary|standby
 *   FAILOVER_PEER_URL=https://other.workers.dev
 *   FAILOVER_SECRET=shared-random
 *   PUBLIC_BASE_URL=https://this.workers.dev
 *   FAILOVER_DAILY_BUDGET=80000
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
  /** Set when handoff needed but current tick is out of subrequests */
  pendingHandoff: boolean
  pendingReason: string | null
  lastHandoffAt: number | null
  lastReason: string | null
  peerUrl: string | null
  updatedAt: number
}

export interface FailoverEnv {
  SUBSCRIBERS?: KVNamespace
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_SNIPER_BOT_TOKEN?: string
  ALERT_SECRET?: string
  FAILOVER_ROLE?: string
  FAILOVER_PEER_URL?: string
  FAILOVER_SECRET?: string
  PUBLIC_BASE_URL?: string
  FAILOVER_DAILY_BUDGET?: string
}

export type FailoverSubscriberPayload = {
  chatId: number
  username?: string
  alertsEnabled?: boolean
  memeAlerts?: boolean
  sniperAlerts?: boolean
  joinedAt?: number
}

const STATE_KEY = 'telegram:failover_state'
const REQ_COUNT_KEY = 'telegram:failover_reqcount'
/** Sticky owner — cron must not fight KV races on `active` */
const OWNER_KEY = 'telegram:failover_owner'
const DEFAULT_DAILY_BUDGET = 80_000
/** Handoff after this many subrequest-limit hits (sticky within the day) */
const SUBREQUEST_FAIL_HANDOFF = 5
/** Primary reclaim if idle this long — prevents dual-idle silence after bad handoff */
const PRIMARY_IDLE_RECLAIM_MS = 10 * 60_000

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

async function readOwner(env: FailoverEnv): Promise<FailoverRole | null> {
  try {
    const raw = await env.SUBSCRIBERS?.get(OWNER_KEY)
    if (raw === 'primary' || raw === 'standby') return raw
  } catch {
    /* ignore */
  }
  return null
}

async function writeOwner(env: FailoverEnv, owner: FailoverRole): Promise<void> {
  try {
    await env.SUBSCRIBERS?.put(OWNER_KEY, owner, {
      expirationTtl: 60 * 60 * 36,
    })
  } catch {
    /* ignore */
  }
}

function defaultState(env: FailoverEnv): FailoverState {
  const role = roleOf(env)
  return {
    role,
    active: role === 'primary',
    dayKey: dayKeyUtc(),
    requestCount: 0,
    subrequestFails: 0,
    pendingHandoff: false,
    pendingReason: null,
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
    const [raw, countRaw, owner] = await Promise.all([
      env.SUBSCRIBERS?.get(STATE_KEY) ?? Promise.resolve(null),
      env.SUBSCRIBERS?.get(REQ_COUNT_KEY) ?? Promise.resolve(null),
      readOwner(env),
    ])
    if (!raw) {
      if (owner) base.active = owner === base.role
      return base
    }
    const parsed = JSON.parse(raw) as Partial<FailoverState>
    const day = dayKeyUtc()
    const sameDay = parsed.dayKey === day
    let reqFromCount = 0
    if (countRaw && sameDay) {
      try {
        const c = JSON.parse(countRaw) as { dayKey?: string; n?: number }
        if (c.dayKey === day) reqFromCount = Number(c.n ?? 0) || 0
      } catch {
        /* ignore */
      }
    }
    const reqFromState = sameDay ? Number(parsed.requestCount ?? 0) : 0
    const activeFromState =
      typeof parsed.active === 'boolean' ? parsed.active : base.active
    return {
      ...base,
      ...parsed,
      role: base.role,
      dayKey: day,
      requestCount: Math.max(reqFromCount, reqFromState),
      subrequestFails: sameDay ? Number(parsed.subrequestFails ?? 0) : 0,
      pendingHandoff: sameDay ? Boolean(parsed.pendingHandoff) : false,
      pendingReason: sameDay ? parsed.pendingReason ?? null : null,
      // OWNER key wins over stale `active` boolean
      active: owner != null ? owner === base.role : activeFromState,
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
    await env.SUBSCRIBERS?.put(
      REQ_COUNT_KEY,
      JSON.stringify({ dayKey: state.dayKey, n: state.requestCount })
    )
  } catch {
    // best effort
  }
}

/**
 * Bump daily invocation counter WITHOUT rewriting active/handoff flags.
 * Prevents KV eventual-consistency stomps that left both workers idle.
 */
export async function bumpFailoverRequest(
  env: FailoverEnv,
  n = 1
): Promise<FailoverState> {
  const state = await loadFailoverState(env)
  const next = state.requestCount + n
  state.requestCount = next
  try {
    await env.SUBSCRIBERS?.put(
      REQ_COUNT_KEY,
      JSON.stringify({ dayKey: state.dayKey, n: next })
    )
  } catch {
    /* ignore */
  }
  return state
}

export function failoverConfigured(env: FailoverEnv): boolean {
  return Boolean(env.FAILOVER_PEER_URL && env.FAILOVER_SECRET)
}

const PEER_FETCH_MS = 2500
/** Skip peer HTTP after failure — dead standby was stalling every cron */
const PEER_DEAD_COOLDOWN_MS = 30 * 60_000
let peerDeadUntil = 0

function peerLikelyDead(): boolean {
  return Date.now() < peerDeadUntil
}

function markPeerDead(): void {
  peerDeadUntil = Date.now() + PEER_DEAD_COOLDOWN_MS
}

function peerAbortSignal(): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      return AbortSignal.timeout(PEER_FETCH_MS)
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** Ask peer to go idle (best-effort). Prevents dual-active after reclaim. */
async function requestPeerStandby(
  env: FailoverEnv,
  reason: string
): Promise<boolean> {
  const peer = env.FAILOVER_PEER_URL?.replace(/\/$/, '')
  const secret = env.FAILOVER_SECRET || env.ALERT_SECRET
  if (!peer || !secret || peerLikelyDead()) return false
  try {
    const r = await fetch(`${peer}/telegram/failover/standby`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Failover-Secret': secret,
        'X-Alert-Secret': secret,
      },
      body: JSON.stringify({ reason, from: roleOf(env), at: Date.now() }),
      signal: peerAbortSignal(),
    })
    if (!r.ok) markPeerDead()
    return r.ok
  } catch {
    markPeerDead()
    return false
  }
}

async function peerFailoverSnapshot(
  env: FailoverEnv
): Promise<{ active?: boolean; role?: string } | null> {
  const peer = env.FAILOVER_PEER_URL?.replace(/\/$/, '')
  if (!peer || peerLikelyDead()) return null
  try {
    const r = await fetch(`${peer}/telegram/failover/status`, {
      method: 'GET',
      signal: peerAbortSignal(),
    })
    if (!r.ok) {
      markPeerDead()
      return null
    }
    return (await r.json()) as { active?: boolean; role?: string }
  } catch {
    markPeerDead()
    return null
  }
}

export async function shouldRunCronWork(
  env: FailoverEnv
): Promise<{ run: boolean; state: FailoverState; reason?: string }> {
  let state = await bumpFailoverRequest(env, 1)
  if (!failoverConfigured(env)) {
    return { run: true, state, reason: 'failover_disabled' }
  }

  // Dual-active guard: standby yields ONLY if primary truly owns (not a race after we activated)
  if (state.active && roleOf(env) === 'standby') {
    const justTook =
      Date.now() - (state.lastHandoffAt ?? 0) < 20 * 60_000 &&
      /manual_relieve|manual_or_peer_activate|handoff|peer_activate|ACTIVE|standby_keeps/i.test(
        state.lastReason ?? ''
      )
    if (justTook) {
      // Keep baton — push primary idle again (KV race often leaves A.active=true)
      await requestPeerStandby(env, 'standby_keeps_ownership')
      return { run: true, state, reason: 'standby_owner' }
    }
    const peer = await peerFailoverSnapshot(env)
    if (peer?.role === 'primary' && peer.active === true) {
      state = await standbyThisWorker(env, 'yield_to_active_primary')
      return { run: false, state, reason: 'yield_to_primary' }
    }
  }

  // Primary: if standby reports active, yield (KV can lag and keep A.active=true)
  if (state.active && roleOf(env) === 'primary') {
    const peer = await peerFailoverSnapshot(env)
    if (peer?.role === 'standby' && peer.active === true) {
      state = await standbyThisWorker(env, 'yield_to_active_standby')
      return { run: false, state, reason: 'yield_to_standby' }
    }
    if (state.pendingHandoff || state.subrequestFails >= SUBREQUEST_FAIL_HANDOFF) {
      state.pendingHandoff = false
      state.pendingReason = null
      state.subrequestFails = 0
      state.lastReason = 'primary_clear_stuck_handoff'
      await saveFailoverState(env, state)
    }
  }

  if (!state.active) {
    // Primary reclaim only when peer is NOT actively owning
    if (roleOf(env) === 'primary') {
      const owner = await readOwner(env)
      if (owner === 'standby') {
        // OWNER=standby but peer dead/unreachable → dual-idle silence. Reclaim.
        const peer = await peerFailoverSnapshot(env)
        if (!(peer?.role === 'standby' && peer.active === true)) {
          const healed = await activateThisWorker(
            env,
            'self_heal_standby_unreachable'
          )
          state = healed.state
        } else {
          return { run: false, state, reason: 'standby_idle_owner_key' }
        }
      }
      const age = Date.now() - (state.lastHandoffAt ?? 0)
      const peerAskedIdle =
        /peer_idle_for|standby_keeps_ownership|manual_standby|manual_relieve|yield_to_active_standby/i.test(
          state.lastReason ?? ''
        )
      // Honor peer ownership window — don't snatch back for ~1h after relieve
      if (peerAskedIdle && age < 60 * 60_000) {
        return { run: false, state, reason: 'standby_idle_peer_owns' }
      }
      const badIdle =
        /pending_handoff_peer_already_active|yield_to_active|dual/i.test(
          state.lastReason ?? ''
        )
      const stale =
        badIdle || !state.lastHandoffAt || age >= PRIMARY_IDLE_RECLAIM_MS
      if (stale) {
        const peer = await peerFailoverSnapshot(env)
        // Real failover: standby owns and primary idled via successful handoff
        const cleanHandoff = /handoff→peer|manual_handoff/i.test(
          state.lastReason ?? ''
        )
        if (
          !badIdle &&
          cleanHandoff &&
          peer?.role === 'standby' &&
          peer.active === true &&
          age < PRIMARY_IDLE_RECLAIM_MS * 3
        ) {
          return { run: false, state, reason: 'peer_active_wait' }
        }
        const healed = await activateThisWorker(
          env,
          badIdle ? 'self_heal_undo_dual_idle' : 'self_heal_primary_reclaim'
        )
        state = healed.state
      } else {
        return { run: false, state, reason: 'standby_idle' }
      }
    } else {
      return { run: false, state, reason: 'standby_idle' }
    }
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

async function markPendingHandoff(
  env: FailoverEnv,
  reason: string
): Promise<FailoverState> {
  const state = await loadFailoverState(env)
  state.pendingHandoff = true
  state.pendingReason = reason.slice(0, 200)
  state.lastReason = `pending_handoff: ${reason}`.slice(0, 220)
  await saveFailoverState(env, state)
  return state
}

/**
 * Record delivery/scan failure.
 * Do NOT hand off inside the same broken tick — queue for next cron.
 * Fail counter is sticky (no reset on next OK) so 2 hits in a day switch.
 */
export async function noteFailoverFailure(
  env: FailoverEnv,
  error: string | null | undefined
): Promise<{ handedOff: boolean; pending: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  if (!failoverConfigured(env) || !state.active) {
    return { handedOff: false, pending: false, state }
  }
  if (!error || !isSubrequestLimitError(error)) {
    return { handedOff: false, pending: false, state }
  }
  state.subrequestFails += 1
  await saveFailoverState(env, state)
  if (state.subrequestFails < SUBREQUEST_FAIL_HANDOFF) {
    return { handedOff: false, pending: false, state }
  }
  // Queue — peer fetch from this invocation usually also hits the cap
  const pending = await markPendingHandoff(
    env,
    `subrequest_fails×${state.subrequestFails}`
  )
  return { handedOff: false, pending: true, state: pending }
}

export async function maybeHandoffOnBudget(
  env: FailoverEnv,
  payload?: {
    memeSubs?: FailoverSubscriberPayload[]
    sniperSubs?: FailoverSubscriberPayload[]
  }
): Promise<{ handedOff: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  if (!failoverConfigured(env) || !state.active) {
    return { handedOff: false, state }
  }
  if (state.requestCount < dailyBudget(env)) {
    return { handedOff: false, state }
  }
  const handed = await handoffToPeer(
    env,
    `daily_budget ${state.requestCount}`,
    payload
  )
  if (!handed.ok) {
    const pending = await markPendingHandoff(
      env,
      `daily_budget ${state.requestCount}`
    )
    return { handedOff: false, state: pending }
  }
  return { handedOff: true, state: handed.state }
}

/** Run at cron start with fresh subrequest budget. */
export async function processPendingHandoff(
  env: FailoverEnv,
  payload?: {
    memeSubs?: FailoverSubscriberPayload[]
    sniperSubs?: FailoverSubscriberPayload[]
  }
): Promise<{ handedOff: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  if (!failoverConfigured(env) || !state.active || !state.pendingHandoff) {
    return { handedOff: false, state }
  }
  const reason = state.pendingReason ?? 'pending_handoff'
  const handed = await handoffToPeer(env, reason, payload)
  if (handed.ok) {
    const next = await loadFailoverState(env)
    next.pendingHandoff = false
    next.pendingReason = null
    await saveFailoverState(env, next)
    return { handedOff: true, state: next }
  }
  return { handedOff: false, state: handed.state }
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
): Promise<{
  ok: boolean
  state: FailoverState
  webhooks?: { meme: boolean; sniper: boolean }
  peerStandby?: boolean
}> {
  const state = await loadFailoverState(env)
  state.active = true
  state.subrequestFails = 0
  state.pendingHandoff = false
  state.pendingReason = null
  state.lastHandoffAt = Date.now()
  state.lastReason = reason
  await writeOwner(env, roleOf(env))
  await saveFailoverState(env, state)

  // Only one owner — idle peer whenever we take the baton
  const peerStandby = await requestPeerStandby(env, `peer_idle_for:${reason}`)

  const base = env.PUBLIC_BASE_URL
  let webhooks: { meme: boolean; sniper: boolean } | undefined
  if (base) {
    webhooks = await setTelegramWebhooks(env, base)
  }
  return { ok: true, state, webhooks, peerStandby }
}

export async function standbyThisWorker(
  env: FailoverEnv,
  reason: string
): Promise<FailoverState> {
  const state = await loadFailoverState(env)
  state.active = false
  state.pendingHandoff = false
  state.pendingReason = null
  state.lastHandoffAt = Date.now()
  state.lastReason = reason
  // Always flip local OWNER away from us (separate KV per account)
  const peerRole: FailoverRole =
    roleOf(env) === 'primary' ? 'standby' : 'primary'
  await writeOwner(env, peerRole)
  await saveFailoverState(env, state)
  return state
}

export async function handoffToPeer(
  env: FailoverEnv,
  reason: string,
  payload?: {
    memeSubs?: FailoverSubscriberPayload[]
    sniperSubs?: FailoverSubscriberPayload[]
  }
): Promise<{ ok: boolean; state: FailoverState; peer?: unknown }> {
  const state = await loadFailoverState(env)
  if (!state.active) return { ok: false, state }
  const peer = env.FAILOVER_PEER_URL?.replace(/\/$/, '')
  const secret = env.FAILOVER_SECRET
  if (!peer || !secret) {
    return { ok: false, state }
  }

  // Activate peer FIRST — only go idle after peer confirms
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
        memeSubs: payload?.memeSubs ?? [],
        sniperSubs: payload?.sniperSubs ?? [],
      }),
      signal: peerAbortSignal(),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      const next = await loadFailoverState(env)
      next.lastReason = `peer_activate_failed:${r.status} ${reason}`.slice(
        0,
        220
      )
      next.pendingHandoff = true
      next.pendingReason = reason
      await saveFailoverState(env, next)
      return { ok: false, state: next, peer: body }
    }
    // Peer live — now idle ourselves
    const idle = await standbyThisWorker(env, `handoff→peer: ${reason}`)
    return { ok: true, state: idle, peer: body }
  } catch (err) {
    const next = await loadFailoverState(env)
    next.active = true
    next.pendingHandoff = true
    next.pendingReason = reason
    next.lastReason = `peer_unreachable_pending: ${reason}`.slice(0, 220)
    await saveFailoverState(env, next)
    return {
      ok: false,
      state: next,
      peer: { error: String(err) },
    }
  }
}

export function authorizeFailover(
  request: Request,
  env: FailoverEnv
): boolean {
  const url = new URL(request.url)
  const hdr = request.headers.get('X-Failover-Secret')
  const alertHdr = request.headers.get('X-Alert-Secret')
  const q = url.searchParams.get('secret')
  const offered = hdr || alertHdr || q
  if (!offered) return false
  if (env.FAILOVER_SECRET && offered === env.FAILOVER_SECRET) return true
  // Emergency recovery when FAILOVER_SECRET is unknown locally
  if (env.ALERT_SECRET && offered === env.ALERT_SECRET) return true
  return false
}
