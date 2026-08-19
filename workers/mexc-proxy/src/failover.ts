/**
 * Cloudflare account ring failover (N free-plan accounts).
 *
 * Each account has its own 1000 KV writes/day. The active node runs until
 * that quota (or daily invocations) is gone, then activates the next URL
 * in FAILOVER_RING. Lowest index with remaining quota is preferred.
 * If every peer is exhausted or dead, the current node stays up on Cache
 * so the bot does not go mute.
 *
 * Vars (all workers, same RING, same FAILOVER_SECRET):
 *   FAILOVER_RING=https://a,https://b,https://c
 *   PUBLIC_BASE_URL=https://this-worker
 *   FAILOVER_ROLE=primary|standby   (index 0 = primary)
 *   FAILOVER_PEER_URL=https://next  (legacy 2-node fallback)
 *   FAILOVER_DAILY_BUDGET=80000
 */

import {
  isKvQuotaHandoffDone,
  isKvWriteQuotaExhausted,
  kvPutThrottled,
  markKvQuotaHandoffDone,
  markKvWriteQuotaExhausted,
  refreshKvWriteQuotaFromCache,
} from './kvWrite'

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
  /** Comma-separated worker URLs in priority order (A,B,C,…) */
  FAILOVER_RING?: string
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

/** Copied onto the peer so its separate KV can keep trading. */
export type FailoverHandoffPayload = {
  memeSubs?: FailoverSubscriberPayload[]
  sniperSubs?: FailoverSubscriberPayload[]
  journal?: string | null
  paper?: string | null
  gates?: string | null
  watchlist?: string | null
}

export const HANDOFF_KV_KEYS = {
  journal: 'telegram:bot_journal_v292',
  paper: 'telegram:paper_trades_v292',
  gates: 'telegram:bot_gates_v292',
  watchlist: 'scanner:hot_meme_watchlist_v7_premove',
} as const

function isQuotaHandoffReason(reason: string | null | undefined): boolean {
  return /kv_quota|daily_budget/i.test(reason ?? '')
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

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, '')
}

export function ringUrls(env: FailoverEnv): string[] {
  const listed = (env.FAILOVER_RING ?? '')
    .split(/[\s,]+/)
    .map(normalizeUrl)
    .filter(Boolean)
  const self = env.PUBLIC_BASE_URL ? normalizeUrl(env.PUBLIC_BASE_URL) : ''
  const peer = env.FAILOVER_PEER_URL ? normalizeUrl(env.FAILOVER_PEER_URL) : ''
  const out: string[] = []
  const add = (u: string) => {
    if (u && !out.includes(u)) out.push(u)
  }
  if (listed.length) listed.forEach(add)
  else {
    if (self) add(self)
    if (peer) add(peer)
  }
  return out
}

export function selfUrl(env: FailoverEnv): string {
  return env.PUBLIC_BASE_URL ? normalizeUrl(env.PUBLIC_BASE_URL) : ''
}

export function ringIndex(env: FailoverEnv): number {
  const ring = ringUrls(env)
  const i = ring.indexOf(selfUrl(env))
  if (i >= 0) return i
  return roleOf(env) === 'primary' ? 0 : Math.max(1, ring.length - 1)
}

function otherUrls(env: FailoverEnv): string[] {
  const self = selfUrl(env)
  return ringUrls(env).filter((u) => u !== self)
}

/** Next hops after self, wrapping around (B→C→A). */
function hopsAfterSelf(env: FailoverEnv): string[] {
  const ring = ringUrls(env)
  const self = selfUrl(env)
  const start = ring.indexOf(self)
  if (start < 0) return otherUrls(env)
  const hops: string[] = []
  for (let k = 1; k < ring.length; k++) {
    const u = ring[(start + k) % ring.length]
    if (u && u !== self) hops.push(u)
  }
  return hops
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
    await markKvWriteQuotaExhausted()
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
    peerUrl: hopsAfterSelf(env)[0] ?? env.FAILOVER_PEER_URL ?? null,
    updatedAt: Date.now(),
  }
}

export async function loadFailoverState(
  env: FailoverEnv
): Promise<FailoverState> {
  const base = defaultState(env)
  await refreshKvWriteQuotaFromCache()
  try {
    const [raw, countRaw, owner] = await Promise.all([
      env.SUBSCRIBERS?.get(STATE_KEY) ?? Promise.resolve(null),
      env.SUBSCRIBERS?.get(REQ_COUNT_KEY) ?? Promise.resolve(null),
      readOwner(env),
    ])
    if (!raw) {
      if (owner) base.active = owner === base.role
      return applyQuotaOwnerOverlay(base)
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
    const loaded: FailoverState = {
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
      peerUrl: hopsAfterSelf(env)[0] ?? env.FAILOVER_PEER_URL ?? parsed.peerUrl ?? null,
      updatedAt: Date.now(),
    }
    return applyQuotaOwnerOverlay(loaded)
  } catch {
    return applyQuotaOwnerOverlay(base)
  }
}

/** After a successful KV/daily handoff, stay idle even if OWNER put failed. */
function applyQuotaOwnerOverlay(state: FailoverState): FailoverState {
  if (isKvWriteQuotaExhausted() && isKvQuotaHandoffDone()) {
    state.active = false
  }
  return state
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
    await markKvWriteQuotaExhausted()
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
    await kvPutThrottled(
      env.SUBSCRIBERS,
      REQ_COUNT_KEY,
      JSON.stringify({ dayKey: state.dayKey, n: next }),
      15 * 60_000
    )
  } catch {
    /* ignore */
  }
  return state
}

export function failoverConfigured(env: FailoverEnv): boolean {
  return Boolean(
    env.FAILOVER_SECRET &&
      (ringUrls(env).length >= 2 || env.FAILOVER_PEER_URL)
  )
}

const PEER_FETCH_MS = 2500
/** Per-URL cooldown — one dead hop must not hide the rest of the ring */
const PEER_DEAD_COOLDOWN_MS = 2 * 60_000
const peerDeadUntil = new Map<string, number>()

function peerIsDead(url: string): boolean {
  return Date.now() < (peerDeadUntil.get(url) ?? 0)
}

function markPeerDead(url: string): void {
  peerDeadUntil.set(url, Date.now() + PEER_DEAD_COOLDOWN_MS)
}

function clearPeerDead(): void {
  peerDeadUntil.clear()
}

function peerAbortSignal(ms = PEER_FETCH_MS): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      return AbortSignal.timeout(ms)
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** Ask one peer to go idle. */
async function requestUrlStandby(
  env: FailoverEnv,
  peer: string,
  reason: string
): Promise<boolean> {
  const secret = env.FAILOVER_SECRET || env.ALERT_SECRET
  if (!peer || !secret || peerIsDead(peer)) return false
  try {
    const r = await fetch(`${peer}/telegram/failover/standby`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Failover-Secret': secret,
        'X-Alert-Secret': secret,
      },
      body: JSON.stringify({
        reason,
        from: roleOf(env),
        fromUrl: selfUrl(env),
        at: Date.now(),
      }),
      signal: peerAbortSignal(),
    })
    if (!r.ok) markPeerDead(peer)
    return r.ok
  } catch {
    markPeerDead(peer)
    return false
  }
}

/** Idle every other ring member so only one owner holds webhooks. */
async function requestAllOthersStandby(
  env: FailoverEnv,
  reason: string
): Promise<boolean> {
  const results = await Promise.all(
    otherUrls(env).map((u) => requestUrlStandby(env, u, reason))
  )
  return results.some(Boolean)
}

export type PeerFailoverSnapshot = {
  active?: boolean
  role?: string
  ringIndex?: number
  publicBaseUrl?: string | null
  kvQuotaExhausted?: boolean
  kvQuotaHandoff?: boolean
}

async function snapshotUrl(
  url: string
): Promise<(PeerFailoverSnapshot & { url: string }) | null> {
  if (!url || peerIsDead(url)) return null
  try {
    const r = await fetch(`${url}/telegram/failover/status`, {
      method: 'GET',
      signal: peerAbortSignal(),
    })
    if (!r.ok) {
      markPeerDead(url)
      return null
    }
    const body = (await r.json()) as PeerFailoverSnapshot
    return { ...body, url }
  } catch {
    markPeerDead(url)
    return null
  }
}

async function ringSnapshots(
  env: FailoverEnv
): Promise<Array<PeerFailoverSnapshot & { url: string }>> {
  const snaps = await Promise.all(otherUrls(env).map(snapshotUrl))
  return snaps.filter((s): s is PeerFailoverSnapshot & { url: string } =>
    Boolean(s)
  )
}

function peerIndex(p: PeerFailoverSnapshot, env: FailoverEnv): number {
  if (typeof p.ringIndex === 'number') return p.ringIndex
  if (p.role === 'primary') return 0
  const ring = ringUrls(env)
  const url = p.publicBaseUrl ? normalizeUrl(p.publicBaseUrl) : ''
  const i = ring.indexOf(url)
  return i >= 0 ? i : 99
}

function isHealthyOwner(p: PeerFailoverSnapshot): boolean {
  return (
    p.active === true &&
    p.kvQuotaExhausted !== true &&
    p.kvQuotaHandoff !== true
  )
}

/** Reachability probe for /telegram/failover/status */
export async function pingRing(env: FailoverEnv): Promise<
  {
    url: string
    reachable: boolean
    active: boolean | null
    kvQuotaExhausted: boolean | null
    kvQuotaHandoff: boolean | null
    ringIndex: number | null
  }[]
> {
  const snaps = await ringSnapshots(env)
  return otherUrls(env).map((url) => {
    const s = snaps.find((x) => x.url === url)
    return {
      url,
      reachable: Boolean(s),
      active: s?.active ?? null,
      kvQuotaExhausted: s?.kvQuotaExhausted ?? null,
      kvQuotaHandoff: s?.kvQuotaHandoff ?? null,
      ringIndex: s ? peerIndex(s, env) : null,
    }
  })
}

export async function shouldRunCronWork(
  env: FailoverEnv
): Promise<{ run: boolean; state: FailoverState; reason?: string }> {
  let state = await bumpFailoverRequest(env, 1)
  await refreshKvWriteQuotaFromCache()
  if (!failoverConfigured(env)) {
    return { run: true, state, reason: 'failover_disabled' }
  }

  const kvQuotaEarly = isKvWriteQuotaExhausted()
  const quotaHandoffEarly = isKvQuotaHandoffDone()
  // Healthy owner: skip 4 peer fetches (those burned the 50-subrequest budget
  // so Telegram never sent). Re-check the ring when idle or quota-dead.
  const skipRingPing =
    state.active &&
    !kvQuotaEarly &&
    !quotaHandoffEarly &&
    !state.pendingHandoff
  if (skipRingPing) {
    await kvPutThrottled(
      env.SUBSCRIBERS,
      'telegram:kv_quota_probe',
      dayKeyUtc(),
      2 * 60 * 60_000
    )
    await refreshKvWriteQuotaFromCache()
    if (isKvWriteQuotaExhausted()) {
      // fall through to full ring logic this tick
    } else {
      const budget = dailyBudget(env)
      if (state.requestCount >= budget) {
        return { run: false, state, reason: 'daily_budget' }
      }
      return { run: true, state, reason: 'healthy_skip_ring' }
    }
  }

  await kvPutThrottled(
    env.SUBSCRIBERS,
    'telegram:kv_quota_probe',
    dayKeyUtc(),
    2 * 60 * 60_000
  )
  await refreshKvWriteQuotaFromCache()

  const idx = ringIndex(env)
  const budget = dailyBudget(env)
  const kvQuota = isKvWriteQuotaExhausted()
  const quotaHandoffDone = isKvQuotaHandoffDone()
  const others = await ringSnapshots(env)

  const healthier = others.find(
    (p) => isHealthyOwner(p) && peerIndex(p, env) < idx
  )
  if (healthier) {
    if (state.active) {
      state = await standbyThisWorker(env, 'yield_to_higher_priority')
    }
    return { run: false, state, reason: 'yield_to_priority' }
  }

  const peerWithQuota = others.some((p) => p.kvQuotaExhausted !== true)
  const healthyActive = others.some(isHealthyOwner)

  if (kvQuota || quotaHandoffDone) {
    // Only sit idle if another node is actually scanning with remaining quota.
    if (quotaHandoffDone && healthyActive) {
      return { run: false, state, reason: 'kv_quota_peer_owns' }
    }
    if (peerWithQuota && !quotaHandoffDone) {
      return { run: false, state, reason: 'kv_quota' }
    }
    // Handoff marked done but peer never ran, or every peer is exhausted —
    // keep scanning on Cache so the bot does not go mute.
    return { run: true, state, reason: 'kv_quota_last_alive' }
  }

  if (!state.active) {
    const age = Date.now() - (state.lastHandoffAt ?? 0)
    const budgetHandoff =
      isQuotaHandoffReason(state.lastReason) &&
      age < PRIMARY_IDLE_RECLAIM_MS * 3
    if (budgetHandoff && healthyActive) {
      return { run: false, state, reason: 'budget_peer_owns' }
    }
    // Do not wait for a quota-dead "active" owner to POST handoff.
    if (healthyActive) {
      return { run: false, state, reason: 'standby_idle' }
    }
    const healed = await activateThisWorker(env, 'self_heal_ring_must_run')
    state = healed.state
  } else if (
    /handoff→peer|yield_to_active_standby|subrequest_fails|primary_clear_stuck_handoff/i.test(
      state.lastReason ?? ''
    ) &&
    !isQuotaHandoffReason(state.lastReason)
  ) {
    const healed = await activateThisWorker(
      env,
      'self_heal_restore_after_handoff'
    )
    state = healed.state
  }

  if (
    !isQuotaHandoffReason(state.pendingReason) &&
    (state.pendingHandoff || state.subrequestFails >= SUBREQUEST_FAIL_HANDOFF)
  ) {
    state.pendingHandoff = false
    state.pendingReason = null
    state.subrequestFails = 0
    state.lastReason = 'primary_clear_stuck_handoff'
    await saveFailoverState(env, state)
  }

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
 * Subrequest-limit hits used to queue a handoff — standby then sat active:true
 * on old code and primary never reclaimed. Stay on primary; next cron is fresh.
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
  return { handedOff: false, pending: false, state }
}

export async function maybeHandoffOnBudget(
  env: FailoverEnv,
  payload?: FailoverHandoffPayload
): Promise<{ handedOff: boolean; state: FailoverState }> {
  return maybeHandoffOnLimit(env, payload)
}

/**
 * Any ring node that burned today's KV/daily cap activates the next hop
 * with remaining quota. Primary is no longer the only one allowed to hand off.
 */
export async function maybeHandoffOnLimit(
  env: FailoverEnv,
  payload?: FailoverHandoffPayload
): Promise<{ handedOff: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  await refreshKvWriteQuotaFromCache()
  if (!failoverConfigured(env)) {
    return { handedOff: false, state }
  }
  const quota = isKvWriteQuotaExhausted()
  const budget = state.requestCount >= dailyBudget(env)
  if (!quota && !budget) {
    return { handedOff: false, state }
  }
  const others = await ringSnapshots(env)
  const healthy = others.some(isHealthyOwner)
  // Retry hop if we already "handed off" but nobody healthy is running.
  if (isKvQuotaHandoffDone() && healthy) {
    return { handedOff: false, state }
  }
  clearPeerDead()
  const reason = quota ? 'kv_quota' : `daily_budget ${state.requestCount}`
  const handed = await handoffToPeer(env, reason, payload)
  if (!handed.ok) {
    const pending = await markPendingHandoff(env, reason)
    return { handedOff: false, state: pending }
  }
  await markKvQuotaHandoffDone()
  return { handedOff: true, state: handed.state }
}

/** Run at cron start with fresh subrequest budget. */
export async function processPendingHandoff(
  env: FailoverEnv,
  payload?: FailoverHandoffPayload
): Promise<{ handedOff: boolean; state: FailoverState }> {
  const state = await loadFailoverState(env)
  if (!failoverConfigured(env) || !state.pendingHandoff) {
    return { handedOff: false, state }
  }
  const quotaPending = isQuotaHandoffReason(state.pendingReason)
  // Cancel queued subrequest handoffs — next cron is a fresh 50-subrequest budget.
  // KV/daily-budget pending must actually hop to the next ring node.
  if (!quotaPending) {
    state.pendingHandoff = false
    state.pendingReason = null
    state.subrequestFails = 0
    state.active = true
    state.lastReason = 'cancel_pending_subrequest_handoff'
    await writeOwner(env, roleOf(env))
    await saveFailoverState(env, state)
    return { handedOff: false, state }
  }
  clearPeerDead()
  const reason = state.pendingReason ?? 'pending_handoff'
  const handed = await handoffToPeer(env, reason, payload)
  if (handed.ok) {
    if (quotaPending) await markKvQuotaHandoffDone()
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
  const peerStandby = await requestAllOthersStandby(
    env,
    `peer_idle_for:${reason}`
  )

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
  payload?: FailoverHandoffPayload
): Promise<{ ok: boolean; state: FailoverState; peer?: unknown }> {
  const state = await loadFailoverState(env)
  const quotaForce =
    isQuotaHandoffReason(reason) && isKvWriteQuotaExhausted()
  if (!state.active && !quotaForce) return { ok: false, state }
  const secret = env.FAILOVER_SECRET
  const hops = hopsAfterSelf(env)
  if (!secret || !hops.length) {
    return { ok: false, state }
  }

  const body = {
    reason,
    from: roleOf(env),
    fromUrl: selfUrl(env),
    at: Date.now(),
    publicBase: env.PUBLIC_BASE_URL ?? null,
    memeSubs: payload?.memeSubs ?? [],
    sniperSubs: payload?.sniperSubs ?? [],
    journal: payload?.journal ?? null,
    paper: payload?.paper ?? null,
    gates: payload?.gates ?? null,
    watchlist: payload?.watchlist ?? null,
  }

  let lastErr: unknown = null
  for (const peer of hops) {
    if (peerIsDead(peer)) continue
    const snap = await snapshotUrl(peer)
    if (snap?.kvQuotaExhausted) continue
    try {
      const r = await fetch(`${peer}/telegram/failover/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Failover-Secret': secret,
        },
        body: JSON.stringify(body),
        signal: peerAbortSignal(8_000),
      })
      const resBody = await r.json().catch(() => ({}))
      if (!r.ok) {
        markPeerDead(peer)
        lastErr = { status: r.status, peer, body: resBody }
        continue
      }
      const idle = await standbyThisWorker(env, `handoff→peer: ${reason}`)
      if (isQuotaHandoffReason(reason)) {
        await markKvQuotaHandoffDone()
      }
      return { ok: true, state: idle, peer: resBody }
    } catch (err) {
      markPeerDead(peer)
      lastErr = err
    }
  }

  const next = await loadFailoverState(env)
  next.active = true
  next.pendingHandoff = true
  next.pendingReason = reason
  next.lastReason = `ring_unreachable_pending: ${reason}`.slice(0, 220)
  await saveFailoverState(env, next)
  return { ok: false, state: next, peer: { error: String(lastErr) } }
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
