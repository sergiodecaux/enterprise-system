/**
 * Cloudflare Worker — CORS proxy (MEXC + news) + dual Telegram bots.
 *
 * Secrets:
 *   npx wrangler secret put TELEGRAM_BOT_TOKEN          # meme / Predator
 *   npx wrangler secret put TELEGRAM_SNIPER_BOT_TOKEN   # Elite Assistant (Enterpriseelite_bot)
 *   npx wrangler secret put ALERT_SECRET
 *   npx wrangler secret put MEXC_ACCESS_KEY             # optional: RU/account symbol filter
 *   npx wrangler secret put MEXC_SECRET_KEY
 *
 * KV:
 *   binding SUBSCRIBERS (see wrangler.toml)
 *
 * Webhooks (once after deploy):
 *   curl "https://api.telegram.org/bot<MEME_TOKEN>/setWebhook?url=https://<worker>/telegram/webhook"
 *   curl "https://api.telegram.org/bot<SNIPER_TOKEN>/setWebhook?url=https://<worker>/telegram/webhook/sniper"
 *
 * Crons: predator every 2m, paper on odd minutes, Elite hourly at :05, daily 00:05 UTC
 */

import type { ScanAlert, TradePlanPayload } from './scanner'
import { runVaneScan, loadVaneRisk, vaneTradingPaused } from './vane'
import { evaluateVaneSession } from './vane/sessionFilter'
import { BOT_ENGINE, SNIPER_ENGINE } from './botEngine'
import {
  buildEliteBriefing,
  buildEliteCoinBrief,
  isEliteAssistantOnly,
} from './elite'
import {
  channelForAlertType,
  subKey,
  tokenForChannel,
  type TgChannel,
} from './telegramChannels'
import {
  analyzeUserZone,
  parseZoneArg,
  resolveMexcSymbol,
} from './userZoneWatch'
import {
  createPaperTradeFromPlan,
  formatTradesStatus,
  listPaperTrades,
  monitorPaperTrades,
} from './paperTrades'
import {
  createWatch,
  createWatchesBatch,
  deleteWatch,
  listWatchesForChat,
  countActiveWatches,
  monitorWatchedSetups,
  type ConditionalSetupPayload,
  type WatchedSetupRecord,
} from './watchedSetups'
import {
  getBotJournalPayload,
  getAdaptiveGates,
  recordBotAlert,
  resolveBotJournal,
  formatCorridorWrReport,
  formatPeakShortStatsReport,
} from './botJournal'
import { formatOutcomeAnalysisLines } from './tradeOutcomeAnalysis'
import { runMemeOrderFlowScan } from './memeOrderFlow'
import { loadHotMemeWatchlist } from './hotMemeWatchlist'
import { kvPutThrottled } from './kvWrite'
import {
  enqueuePendingMeme,
  flushPendingMemeAlerts,
} from './pendingMemeTg'
import {
  activateThisWorker,
  authorizeFailover,
  failoverConfigured,
  handoffToPeer,
  loadFailoverState,
  maybeHandoffOnBudget,
  noteFailoverFailure,
  processPendingHandoff,
  shouldRunCronWork,
  standbyThisWorker,
  type FailoverSubscriberPayload,
} from './failover'

const MEXC_ORIGIN = 'https://contract.mexc.com'
const LAST_SCAN_KEY = 'telegram:last_scan_status'
const LAST_TG_KEY = 'telegram:last_delivery_status'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Alert-Secret',
  'Access-Control-Max-Age': '86400',
}

const RSS_ALLOWED = [
  'coindesk.com',
  'cointelegraph.com',
  'decrypt.co',
  'theblock.co',
]

const DEDUP_PREFIX = 'telegram:dedup:'

/** In-memory fallback when KV not bound (dev / first deploy) */
const memorySubs: Record<TgChannel, Map<number, Subscriber>> = {
  meme: new Map(),
  sniper: new Map(),
}
const memoryDedup = new Map<string, number>()
const memoryRuntime = new Map<string, string>()

function runtimeCacheRequest(key: string): Request {
  return new Request(
    `https://enterprise-system-runtime.invalid/${encodeURIComponent(key)}`
  )
}

async function runtimeGet(key: string): Promise<string | null> {
  try {
    const response = await caches.default.match(runtimeCacheRequest(key))
    if (response) return response.text()
  } catch {
    // Cache API may be unavailable in local development.
  }
  return memoryRuntime.get(key) ?? null
}

async function runtimePut(key: string, value: string): Promise<void> {
  memoryRuntime.set(key, value)
  try {
    await caches.default.put(
      runtimeCacheRequest(key),
      new Response(value, {
        headers: {
          'Content-Type': 'application/json',
          // 2h so short-lived dedup/heartbeat stamps survive isolate churn
          'Cache-Control': 'public, max-age=7200',
        },
      })
    )
  } catch {
    // In-memory fallback is enough for local development.
  }
}

/** Prefer the newer of Cache vs KV (they can diverge across colos). */
function pickNewerDurable(
  a: string | null | undefined,
  b: string | null | undefined
): string | null {
  const av = a != null && a !== '' ? a : null
  const bv = b != null && b !== '' ? b : null
  if (!av) return bv
  if (!bv) return av
  const score = (raw: string): number => {
    const asNum = Number(raw)
    if (Number.isFinite(asNum) && asNum > 1_000_000_000_000) return asNum
    try {
      const at = Number((JSON.parse(raw) as { at?: number }).at)
      if (Number.isFinite(at) && at > 0) return at
    } catch {
      /* not json */
    }
    return 0
  }
  return score(av) >= score(bv) ? av : bv
}

/** Cache + KV (durable) — never trust Cache alone for watermarks. */
async function durableGet(env: Env, key: string): Promise<string | null> {
  let kv: string | null = null
  try {
    kv = (await env.SUBSCRIBERS?.get(key)) ?? null
  } catch {
    kv = null
  }
  const cached = await runtimeGet(key)
  return pickNewerDurable(cached, kv)
}

async function durablePut(
  env: Env,
  key: string,
  value: string,
  expirationTtl = 60 * 60 * 24 * 7,
  minIntervalMs = 25 * 60_000
): Promise<void> {
  await runtimePut(key, value)
  await kvPutThrottled(env.SUBSCRIBERS, key, value, minIntervalMs, {
    expirationTtl,
  })
}

function latestBookTimestamp(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as Record<string, Array<{ at?: number }>>
    return Math.max(
      0,
      ...Object.values(parsed).flatMap((snapshots) =>
        (Array.isArray(snapshots) ? snapshots : []).map((snapshot) =>
          Number(snapshot.at ?? 0)
        )
      )
    )
  } catch {
    return 0
  }
}

function createOrderBookStateStore(env: Env) {
  return {
    async get(key: string): Promise<string | null> {
      const [cached, persisted] = await Promise.all([
        runtimeGet(`book:${key}`),
        env.SUBSCRIBERS?.get(key) ?? Promise.resolve(null),
      ])
      // Prefer the freshest sequence — cron isolates often have empty memory,
      // and a stale Cache entry must not beat a newer KV checkpoint.
      const cachedAt = latestBookTimestamp(cached)
      const persistedAt = latestBookTimestamp(persisted)
      if (cachedAt >= persistedAt) return cached ?? persisted
      return persisted ?? cached
    },
    async put(key: string, value: string): Promise<void> {
      await runtimePut(`book:${key}`, value)
      // Free KV: ≤1000 writes/day. Cache holds live sequence; KV every ~15m.
      await kvPutThrottled(env.SUBSCRIBERS, key, value, 15 * 60_000)
    },
  }
}

interface Env {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_SNIPER_BOT_TOKEN?: string
  ALERT_SECRET?: string
  /** Set to 0/false to restore VANE auto-alerts on Elite bot */
  ELITE_ASSISTANT_ONLY?: string
  SUBSCRIBERS?: KVNamespace
  /** primary | standby — dual CF account failover */
  FAILOVER_ROLE?: string
  FAILOVER_PEER_URL?: string
  FAILOVER_SECRET?: string
  /** This worker public URL, e.g. https://mexc-proxy-xxx.workers.dev */
  PUBLIC_BASE_URL?: string
  /** Soft daily invocation budget (Free ≈100k). Default 80000 */
  FAILOVER_DAILY_BUDGET?: string
  /** MEXC futures API — filter symbols available to this account/region */
  MEXC_ACCESS_KEY?: string
  MEXC_SECRET_KEY?: string
}

interface Subscriber {
  chatId: number
  username?: string
  subscribedAt: number
  sniper: boolean
  meme: boolean
}

interface AlertPayload {
  type: 'SNIPER' | 'MEME' | 'SYSTEM' | 'SETUP_WATCH'
  title: string
  text: string
  dedupeKey?: string
  chatId?: number
  /** Which Telegram bot delivers this message */
  channel?: TgChannel
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (path.startsWith('/telegram/')) {
      return handleTelegram(request, env, path, ctx)
    }

    if (path === '/market-context' || path === '/market-context/') {
      const { getMarketContext } = await import('./marketContext')
      const ctx = await getMarketContext()
      return json(ctx)
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: CORS_HEADERS,
      })
    }

    if (path.startsWith('/news/rss')) {
      const rssUrl = url.searchParams.get('url')
      if (!rssUrl) {
        return json({ error: 'Missing url param' }, 400)
      }
      try {
        const parsed = new URL(rssUrl)
        if (!RSS_ALLOWED.some((d) => parsed.hostname.includes(d))) {
          return json({ error: 'Domain not allowed' }, 403)
        }
      } catch {
        return json({ error: 'Invalid url' }, 400)
      }
      return proxyFetch(rssUrl, CORS_HEADERS)
    }

    let targetBase = ''
    let targetPath = path

    if (path.startsWith('/news/panic')) {
      targetBase = 'https://cryptopanic.com'
      targetPath = path.replace('/news/panic', '') || '/'
    } else if (path.startsWith('/news/fg')) {
      targetBase = 'https://api.alternative.me'
      targetPath = path.replace('/news/fg', '') || '/'
    } else if (path.startsWith('/mexc-spot')) {
      // Spot REST — must be BEFORE /mexc (prefix overlap)
      targetBase = 'https://api.mexc.com'
      targetPath = path.replace('/mexc-spot', '') || '/'
    } else if (path.startsWith('/mexc')) {
      targetBase = MEXC_ORIGIN
      targetPath = path.replace('/mexc', '') || '/'
    } else {
      return json({ error: 'Route not found' }, 404)
    }

    const target = `${targetBase}${targetPath}${url.search}`
    return proxyFetch(target, CORS_HEADERS)
  },

  // Split crons: predator */2, paper odd minutes, vane every minute (auto-search)
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const role = cronRoleFromExpression(event.cron)
    // Await (not fire-and-forget waitUntil) so CF keeps the isolate until TG I/O finishes
    await runCronScan(env, role)
  },
}

export type CronRole =
  | 'predator'
  | 'paper'
  | 'vane'
  | 'elite_hourly'
  | 'elite_daily'
  | 'all'

function cronRoleFromExpression(cron: string): CronRole {
  if (cron === '1-59/2 * * * *') return 'paper'
  if (cron === '* * * * *') return 'vane'
  if (cron === '*/2 * * * *') return 'predator'
  if (cron === '5 * * * *') return 'elite_hourly'
  if (cron === '5 0 * * *') return 'elite_daily'
  // legacy every-3m vane expression
  if (cron === '0-57/3 * * * *') return 'vane'
  return 'all'
}

async function handleTelegram(
  request: Request,
  env: Env,
  path: string,
  ctx?: ExecutionContext
): Promise<Response> {
  // Health works even without token
  if (path === '/telegram/health') {
    const [memeSubs, sniperSubs] = await Promise.all([
      listSubscribers(env, 'meme'),
      listSubscribers(env, 'sniper'),
    ])
    const watches = await countActiveWatches(env)
    const kv = env.SUBSCRIBERS
      ? {
          get: (key: string) => env.SUBSCRIBERS!.get(key),
          put: (key: string, value: string) => env.SUBSCRIBERS!.put(key, value),
        }
      : undefined
    const [
      lastScanCache,
      lastScanKv,
      lastScanPredKv,
      lastDeliveryCache,
      lastDeliveryKv,
      hotList,
    ] = await Promise.all([
      runtimeGet(LAST_SCAN_KEY),
      env.SUBSCRIBERS?.get(LAST_SCAN_KEY) ?? Promise.resolve(null),
      env.SUBSCRIBERS?.get(`${LAST_SCAN_KEY}:predator`) ?? Promise.resolve(null),
      runtimeGet(LAST_TG_KEY),
      env.SUBSCRIBERS?.get(LAST_TG_KEY) ?? Promise.resolve(null),
      loadHotMemeWatchlist(kv),
    ])
    let lastScan: unknown = null
    let lastDelivery: unknown = null
    try {
      // Prefer freshest snapshot — Cache can retain days-old paper ticks
      const scanCandidates = [lastScanCache, lastScanKv, lastScanPredKv]
        .filter((x): x is string => Boolean(x))
        .map((raw) => {
          try {
            return JSON.parse(raw) as { completedAt?: number; at?: number }
          } catch {
            return null
          }
        })
        .filter((x): x is { completedAt?: number; at?: number } => x != null)
      scanCandidates.sort(
        (a, b) =>
          (b.completedAt ?? b.at ?? 0) - (a.completedAt ?? a.at ?? 0)
      )
      lastScan = scanCandidates[0] ?? null
      const delRaw = lastDeliveryCache ?? lastDeliveryKv
      lastDelivery = delRaw ? JSON.parse(delRaw) : null
    } catch {
      lastScan = null
      lastDelivery = null
    }
    return json({
      ok: true,
      bots: {
        meme: {
          name: 'Enterprisesystem_bot',
          engine: BOT_ENGINE.id,
          engineLabel: BOT_ENGINE.label,
          subscribers: memeSubs.length,
          chatIds: memeSubs.map((s) => s.chatId),
          hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
          note: BOT_ENGINE.deployedNote,
        },
        sniper: {
          name: 'Enterpriseelite_bot',
          engine: SNIPER_ENGINE.id,
          engineLabel: SNIPER_ENGINE.label,
          subscribers: sniperSubs.length,
          chatIds: sniperSubs.map((s) => s.chatId),
          hasToken: Boolean(env.TELEGRAM_SNIPER_BOT_TOKEN),
          note: SNIPER_ENGINE.deployedNote,
        },
      },
      activeWatches: watches,
      hasSecret: Boolean(env.ALERT_SECRET),
      cron: {
        predator: '*/2 * * * *',
        paper: '1-59/2 * * * *',
        eliteHourly: '5 * * * *',
        eliteDaily: '5 0 * * *',
      },
      mode: isEliteAssistantOnly(env)
        ? 'Elite Assistant: hourly :05 · daily 00:05 UTC · Predator */2'
        : 'auto-search: vane · meme order-flow every 2m',
      eliteAssistant: isEliteAssistantOnly(env),
      eliteCrons: { hourly: '5 * * * *', daily: '5 0 * * *' },
      memeHotlist: hotList
        ? {
            updatedAt: hotList.updatedAt,
            dayKey: hotList.dayKey,
            reason: hotList.reason,
            symbols: hotList.entries.map((e) => ({
              symbol: e.symbol,
              dayBias: e.dayBias,
              chg24hPct: e.chg24hPct,
              quoteVolUsd: e.quoteVolUsd,
              score: e.score,
            })),
          }
        : null,
      failover: {
        configured: failoverConfigured(env),
        ...(await loadFailoverState(env)),
        dailyBudget: Number(env.FAILOVER_DAILY_BUDGET ?? 80_000),
        publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
      },
      lastScan,
      lastDelivery,
    })
  }

  // Worker → Telegram self-test (rate-limited). Proves CF isolate can reach api.telegram.org
  if (
    (path === '/telegram/delivery-test' || path === '/telegram/delivery-test/') &&
    (request.method === 'GET' || request.method === 'POST')
  ) {
    const url = new URL(request.url)
    const channel: TgChannel =
      url.searchParams.get('channel') === 'meme' ? 'meme' : 'sniper'
    const force =
      url.searchParams.get('force') === '1' ||
      url.searchParams.get('force') === 'true'
    const gate = await assertDeliveryTestGate(env, force)
    if (!gate.ok) return json({ error: gate.error }, gate.status)

    const subs = await listSubscribers(env, channel)
    if (!subs.length) {
      return json({
        ok: false,
        channel,
        error: 'no subscribers',
        hint: 'Open the bot and press /start',
      }, 404)
    }
    const token = tokenForChannel(env, channel)
    if (!token) {
      return json({ ok: false, channel, error: 'token missing' }, 503)
    }

    const results: Array<{ chatId: number; ok: boolean; status: number; error?: string }> =
      []
    for (const sub of subs) {
      const r = await tgSendDetailed(
        env,
        sub.chatId,
        [
          `🏓 <b>Delivery test</b> · ${channel}`,
          `Worker → Telegram OK`,
          `chatId <code>${sub.chatId}</code>`,
          `engine <code>${channel === 'sniper' ? SNIPER_ENGINE.id : BOT_ENGINE.id}</code>`,
          new Date().toISOString(),
        ].join('\n'),
        channel
      )
      results.push({
        chatId: sub.chatId,
        ok: r.ok,
        status: r.status,
        error: r.error,
      })
    }
    const sent = results.filter((x) => x.ok).length
    return json({
      ok: sent > 0,
      channel,
      sent,
      failed: results.length - sent,
      results,
    })
  }

  // Manual Elite brief (JSON for Mini App / debug)
  if (
    (path === '/elite/brief' || path === '/elite/brief/') &&
    (request.method === 'GET' || request.method === 'POST')
  ) {
    const kindParam = new URL(request.url).searchParams.get('kind')
    const kind = kindParam === 'daily' ? 'daily' : 'hourly'
    const kv = env.SUBSCRIBERS
      ? {
          get: (key: string) => env.SUBSCRIBERS!.get(key),
          put: (key: string, value: string) => env.SUBSCRIBERS!.put(key, value),
        }
      : undefined
    try {
      const briefing = await buildEliteBriefing({ kind, kv })
      return json({
        ok: true,
        kind: briefing.kind,
        generatedAt: briefing.generatedAt,
        sessionLine: briefing.sessionLine,
        fearGreedLine: briefing.fearGreedLine,
        newsLines: briefing.newsLines,
        rankedIdeas: briefing.rankedIdeas,
        coins: briefing.coins,
        htmlParts: briefing.htmlParts,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return json({ ok: false, error: msg }, 500)
    }
  }

  // Dual-account failover
  if (path === '/telegram/failover/status' && request.method === 'GET') {
    const state = await loadFailoverState(env)
    return json({
      ok: true,
      configured: failoverConfigured(env),
      role: state.role,
      active: state.active,
      dayKey: state.dayKey,
      requestCount: state.requestCount,
      dailyBudget: Number(env.FAILOVER_DAILY_BUDGET ?? 80_000),
      subrequestFails: state.subrequestFails,
      pendingHandoff: state.pendingHandoff,
      pendingReason: state.pendingReason,
      lastHandoffAt: state.lastHandoffAt,
      lastReason: state.lastReason,
      peerUrl: state.peerUrl,
      publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
    })
  }

  if (
    path === '/telegram/failover/activate' &&
    (request.method === 'POST' || request.method === 'GET')
  ) {
    if (!authorizeFailover(request, env)) {
      return json({ error: 'Unauthorized' }, 401)
    }
    let reason = 'manual_or_peer_activate'
    let memeSubs: FailoverSubscriberPayload[] = []
    let sniperSubs: FailoverSubscriberPayload[] = []
    if (request.method === 'GET') {
      const u = new URL(request.url)
      if (u.searchParams.get('reason')) {
        reason = String(u.searchParams.get('reason')).slice(0, 200)
      }
    } else {
      try {
        const body = (await request.json()) as {
          reason?: string
          memeSubs?: FailoverSubscriberPayload[]
          sniperSubs?: FailoverSubscriberPayload[]
        }
        if (body?.reason) reason = String(body.reason).slice(0, 200)
        if (Array.isArray(body?.memeSubs)) memeSubs = body.memeSubs
        if (Array.isArray(body?.sniperSubs)) sniperSubs = body.sniperSubs
      } catch {
        // empty body ok
      }
    }
    // Import subscribers from peer so standby isn't mute (separate KV)
    if (memeSubs.length) {
      const cur = await listSubscribers(env, 'meme')
      const byId = new Map(cur.map((s) => [s.chatId, s]))
      for (const s of memeSubs) {
        if (!(s.chatId > 0)) continue
        const prev = byId.get(s.chatId)
        byId.set(s.chatId, {
          chatId: s.chatId,
          username: s.username ?? prev?.username,
          subscribedAt: s.joinedAt ?? prev?.subscribedAt ?? Date.now(),
          sniper: s.sniperAlerts ?? prev?.sniper ?? false,
          meme: s.memeAlerts ?? prev?.meme ?? true,
        })
      }
      await saveSubscribers(env, [...byId.values()], 'meme')
    }
    if (sniperSubs.length) {
      const cur = await listSubscribers(env, 'sniper')
      const byId = new Map(cur.map((s) => [s.chatId, s]))
      for (const s of sniperSubs) {
        if (!(s.chatId > 0)) continue
        const prev = byId.get(s.chatId)
        byId.set(s.chatId, {
          chatId: s.chatId,
          username: s.username ?? prev?.username,
          subscribedAt: s.joinedAt ?? prev?.subscribedAt ?? Date.now(),
          sniper: s.sniperAlerts ?? prev?.sniper ?? true,
          meme: s.memeAlerts ?? prev?.meme ?? false,
        })
      }
      await saveSubscribers(env, [...byId.values()], 'sniper')
    }
    // Never 500 on activate — peer handoff treats non-2xx as failure and dual-active sticks
    try {
      const r = await activateThisWorker(env, reason)
      try {
        await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: 'meme',
          title: '🔀 Failover ACTIVE',
          text: [
            `Этот Worker взял ботов (${env.FAILOVER_ROLE ?? 'primary'}).`,
            `Причина: ${reason}`,
            `Подписчики: meme+${memeSubs.length} sniper+${sniperSubs.length}`,
            r.webhooks
              ? `Webhook meme=${r.webhooks.meme} sniper=${r.webhooks.sniper}`
              : 'PUBLIC_BASE_URL не задан — webhook не переключал',
            `peerStandby=${r.peerStandby ?? false}`,
          ].join('\n'),
          dedupeKey: `failover:active:${Math.floor(Date.now() / 60_000)}`,
        })
      } catch {
        // TG notify is best-effort
      }
      return json({ ok: true, ...r })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[failover] activate failed', msg)
      return json({ ok: false, error: msg.slice(0, 200) }, 200)
    }
  }

  if (path === '/telegram/failover/standby' && request.method === 'POST') {
    if (!authorizeFailover(request, env)) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const state = await standbyThisWorker(env, 'manual_standby')
    return json({ ok: true, state })
  }

  if (path === '/telegram/failover/handoff' && request.method === 'POST') {
    if (!authorizeFailover(request, env)) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const [memeSubs, sniperSubs] = await Promise.all([
      listSubscribers(env, 'meme'),
      listSubscribers(env, 'sniper'),
    ])
    const r = await handoffToPeer(env, 'manual_handoff', {
      memeSubs: memeSubs.map((s) => ({
        chatId: s.chatId,
        username: s.username,
        joinedAt: s.subscribedAt,
        memeAlerts: s.meme,
        sniperAlerts: s.sniper,
      })),
      sniperSubs: sniperSubs.map((s) => ({
        chatId: s.chatId,
        username: s.username,
        joinedAt: s.subscribedAt,
        memeAlerts: s.meme,
        sniperAlerts: s.sniper,
      })),
    })
    return json(r)
  }

  // Manual scan trigger (cron test)
  if (
    (path === '/telegram/scan' || path === '/telegram/scan/') &&
    (request.method === 'POST' || request.method === 'GET')
  ) {
    if (env.ALERT_SECRET) {
      const secret =
        request.headers.get('X-Alert-Secret') ||
        new URL(request.url).searchParams.get('secret')
      if (secret !== env.ALERT_SECRET) {
        return json({ error: 'Unauthorized' }, 401)
      }
    }
    if (!env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_SNIPER_BOT_TOKEN) {
      return json({ error: 'No Telegram bot token configured' }, 503)
    }
    const roleParam = new URL(request.url).searchParams.get('role')
    const role: CronRole =
      roleParam === 'predator' ||
      roleParam === 'paper' ||
      roleParam === 'vane' ||
      roleParam === 'elite_hourly' ||
      roleParam === 'elite_daily' ||
      roleParam === 'all'
        ? roleParam
        : 'all'
    const result = await runCronScan(env, role)
    return json({ ok: true, ...result })
  }

  if (path === '/telegram/webhook' && request.method === 'POST') {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 503)
    }
    try {
      const update = (await request.json()) as TelegramUpdate
      await processWebhook(env, update, 'meme')
      return json({ ok: true })
    } catch (err) {
      console.error('[webhook/meme] failed', err)
      return json({ ok: false, error: String(err) }, 200)
    }
  }

  if (path === '/telegram/webhook/sniper' && request.method === 'POST') {
    if (!env.TELEGRAM_SNIPER_BOT_TOKEN) {
      return json(
        {
          error: 'TELEGRAM_SNIPER_BOT_TOKEN not configured',
          hint: 'npx wrangler secret put TELEGRAM_SNIPER_BOT_TOKEN',
        },
        503
      )
    }
    try {
      const update = (await request.json()) as TelegramUpdate
      await processWebhook(env, update, 'sniper')
      return json({ ok: true })
    } catch (err) {
      console.error('[webhook/sniper] failed', err)
      return json({ ok: false, error: String(err) }, 200)
    }
  }

  if (!env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_SNIPER_BOT_TOKEN) {
    return json(
      {
        error: 'No Telegram bot token configured',
        hint: 'npx wrangler secret put TELEGRAM_BOT_TOKEN (and optionally TELEGRAM_SNIPER_BOT_TOKEN)',
      },
      503
    )
  }

  if (path === '/telegram/subscribe' && request.method === 'POST') {
    const body = (await request.json()) as {
      chatId: number
      username?: string
      sniper?: boolean
      meme?: boolean
    }
    if (!body.chatId || typeof body.chatId !== 'number') {
      return json({ error: 'chatId required' }, 400)
    }
    await upsertSubscriber(
      env,
      {
        chatId: body.chatId,
        username: body.username,
        subscribedAt: Date.now(),
        sniper: body.sniper !== false,
        meme: body.meme !== false,
      },
      'meme'
    )
    await tgSend(
      env,
      body.chatId,
      '✅ Подписка активна на @Enterprisesystem_bot\n\nСигналы 24/7 (сканер каждые 2 мин) + из Mini App.\n\n/stop — отписаться\n/status — статус\n/scan — ручной прогон сканера',
      'meme'
    )
    return json({ ok: true, chatId: body.chatId })
  }

  if (path === '/telegram/unsubscribe' && request.method === 'POST') {
    const body = (await request.json()) as { chatId: number; channel?: TgChannel }
    if (!body.chatId) return json({ error: 'chatId required' }, 400)
    const ch = body.channel === 'sniper' ? 'sniper' : 'meme'
    await removeSubscriber(env, body.chatId, ch)
    return json({ ok: true })
  }

  if (path === '/telegram/alert' && request.method === 'POST') {
    const payload = (await request.json()) as AlertPayload
    if (!payload?.text) return json({ error: 'text required' }, 400)

    const auth = await assertAlertAuth(env, request, payload.chatId)
    if (!auth.ok) return json({ error: auth.error }, 401)

    const broadcast = await broadcastAlert(env, payload)
    return json(broadcast)
  }

  if (path === '/telegram/watch' && request.method === 'POST') {
    const body = (await request.json()) as {
      chatId: number
      symbol: string
      internalSymbol: string
      setup: ConditionalSetupPayload
      ttlHours?: number
    }
    if (!body?.chatId || !body?.setup || !body?.symbol) {
      return json({ error: 'chatId, symbol, setup required' }, 400)
    }
    // Mini App watches → sniper bot (BTC/alts zones)
    await upsertSubscriber(
      env,
      {
        chatId: body.chatId,
        subscribedAt: Date.now(),
        sniper: true,
        meme: true,
      },
      'sniper'
    )
    const auth = await assertAlertAuth(env, request, body.chatId)
    if (!auth.ok) return json({ error: auth.error }, 401)
    const watch = await createWatch(env, body)
    // Immediately mirror Mini App «Сигналы» into Elite bot
    if (tokenForChannel(env, 'sniper')) {
      const msg = formatWatchArmedMessage(watch)
      await broadcastAlert(env, {
        type: 'SETUP_WATCH',
        channel: 'sniper',
        chatId: body.chatId,
        title: msg.title,
        text: msg.text,
        dedupeKey: `watch:armed:${watch.watchId}`,
      })
    }
    return json({ ok: true, watch })
  }

  if (path === '/telegram/watch/batch' && request.method === 'POST') {
    const body = (await request.json()) as {
      chatId: number
      symbol: string
      internalSymbol: string
      setups: ConditionalSetupPayload[]
      ttlHours?: number
    }
    if (!body?.chatId || !body?.symbol || !Array.isArray(body.setups)) {
      return json({ error: 'chatId, symbol, setups required' }, 400)
    }
    await upsertSubscriber(
      env,
      {
        chatId: body.chatId,
        subscribedAt: Date.now(),
        sniper: true,
        meme: true,
      },
      'sniper'
    )
    const auth = await assertAlertAuth(env, request, body.chatId)
    if (!auth.ok) return json({ error: auth.error }, 401)
    const watches = await createWatchesBatch(env, {
      chatId: body.chatId,
      symbol: body.symbol,
      internalSymbol: body.internalSymbol || body.symbol,
      setups: body.setups,
      ttlHours: body.ttlHours,
    })
    if (tokenForChannel(env, 'sniper') && watches.length > 0) {
      const heads = watches.slice(0, 3).map((w) => {
        const m = formatWatchArmedMessage(w)
        return `${m.title}\n${m.text}`
      })
      await tgSend(
        env,
        body.chatId,
        [
          `<b>📡 Мониторинг включён · Elite</b>`,
          `Сетапов: <b>${watches.length}</b> · ${body.symbol}`,
          `Источник: Mini App → Сигналы`,
          `Мониторинг тихий: в TG только 🎯 READY (вход) и ⛔ INVALIDATED`,
          `Журнал Lab WR — при READY.`,
          '',
          ...heads,
        ].join('\n\n'),
        'sniper'
      )
    }
    return json({ ok: true, watches, count: watches.length })
  }

  if (path === '/telegram/watch/delete' && request.method === 'POST') {
    const body = (await request.json()) as {
      chatId: number
      watchId: string
    }
    if (!body?.chatId || !body?.watchId) {
      return json({ error: 'chatId, watchId required' }, 400)
    }
    const auth = await assertAlertAuth(env, request, body.chatId)
    if (!auth.ok) return json({ error: auth.error }, 401)
    const ok = await deleteWatch(env, body.chatId, body.watchId)
    return json({ ok })
  }

  if (path === '/telegram/watches' && request.method === 'GET') {
    const url = new URL(request.url)
    const chatId = Number(url.searchParams.get('chatId'))
    if (!chatId) return json({ error: 'chatId required' }, 400)
    const watches = await listWatchesForChat(env, chatId)
    return json({ ok: true, watches })
  }

  if (path === '/telegram/journal/reset-peak' && request.method === 'POST') {
    const secret =
      request.headers.get('X-Alert-Secret') ||
      new URL(request.url).searchParams.get('secret')
    if (!env.ALERT_SECRET || secret !== env.ALERT_SECRET) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const { resetAllLabStats } = await import('./botJournal')
    const { clearPeakDecisions } = await import('./peakDecisionLog')
    const { closeAllLabPapers } = await import('./paperTrades')
    const result = await resetAllLabStats(env)
    const clearedDecisions = await clearPeakDecisions(env.SUBSCRIBERS)
    const closedPapers = await closeAllLabPapers(env)
    await env.SUBSCRIBERS?.delete('telegram:peak_only_purged_v283')
    await env.SUBSCRIBERS?.delete('telegram:last_peak_alert_at')
    await env.SUBSCRIBERS?.delete('telegram:last_elite_dump_alert_at')
    try {
      await env.SUBSCRIBERS?.delete('telegram:pending_meme_alerts')
    } catch {
      /* optional key */
    }
    return json({
      ok: true,
      ...result,
      clearedDecisions,
      closedPapers,
      engines: { meme: BOT_ENGINE.id, elite: SNIPER_ENGINE.id },
      note: 'Full lab wipe v291 — clean slate all stats',
    })
  }

  if (path === '/telegram/journal' && request.method === 'GET') {
    const url = new URL(request.url)
    const peak = url.searchParams.get('peak') === '1'
    const archive = url.searchParams.get('archive') === '1'
    const detail = url.searchParams.get('detail') === '1'
    const setup = url.searchParams.get('setup') || undefined
    const format = url.searchParams.get('format')
    const limit = Number(url.searchParams.get('limit') || 400)

    if (detail || archive || setup || format === 'csv') {
      const {
        getJournalAnalysisDump,
        journalToCsv,
      } = await import('./botJournal')
      const dump = await getJournalAnalysisDump(env, {
        setup,
        limit: Number.isFinite(limit) ? limit : 400,
        includeArchive: true,
      })
      if (peak) {
        const {
          listPeakDecisions,
          summarizePeakDecisions,
        } = await import('./peakDecisionLog')
        const decisions = await listPeakDecisions(env.SUBSCRIBERS, 200)
        dump.peakDecisions = decisions
        dump.peakSummary = summarizePeakDecisions(decisions)
      }
      if (format === 'csv') {
        const csv = journalToCsv(dump.merged)
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition':
              'attachment; filename="bot-journal-export.csv"',
          },
        })
      }
      return json({
        ok: true,
        ...dump,
        archiveCount: dump.archive.length,
      })
    }

    const payload = await getBotJournalPayload(env)
    if (!peak) return json({ ok: true, ...payload })
    const {
      listPeakDecisions,
      summarizePeakDecisions,
    } = await import('./peakDecisionLog')
    const decisions = await listPeakDecisions(env.SUBSCRIBERS, 120)
    return json({
      ok: true,
      ...payload,
      peakDecisions: decisions,
      peakSummary: summarizePeakDecisions(decisions),
    })
  }

  void ctx
  return json({ error: 'Unknown telegram route' }, 404)
}

/**
 * Auth for alert/watch:
 * 1) X-Alert-Secret matches ALERT_SECRET, or
 * 2) directed request (chatId) for an existing subscriber
 *    (Pages build may lack VITE_ALERT_SECRET; Mini App always subscribe()'s first)
 */
async function assertAlertAuth(
  env: Env,
  request: Request,
  chatId?: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!env.ALERT_SECRET) return { ok: true }

  const secret = request.headers.get('X-Alert-Secret')
  if (secret === env.ALERT_SECRET) return { ok: true }

  if (chatId != null && Number.isFinite(chatId)) {
    const [memeSubs, sniperSubs] = await Promise.all([
      listSubscribers(env, 'meme'),
      listSubscribers(env, 'sniper'),
    ])
    if (
      memeSubs.some((s) => s.chatId === chatId) ||
      sniperSubs.some((s) => s.chatId === chatId)
    ) {
      return { ok: true }
    }
    return {
      ok: false,
      error: 'Unauthorized: need ALERT_SECRET or /start + subscribe for this chatId',
    }
  }

  return { ok: false, error: 'Unauthorized: invalid ALERT_SECRET' }
}

/** Dedup + send to subscribers of the matching Telegram bot */
function dedupeTtlMs(type: AlertPayload['type']): number {
  if (type === 'MEME') return 480_000 // 8m — peak fades re-fire faster
  if (type === 'SETUP_WATCH') return 6 * 3600_000
  return 3600_000
}

/** True if dedup stamp is still within TTL (Cache used to treat any hit as forever). */
function isDedupFresh(raw: string | null | undefined, ttlMs: number): boolean {
  if (raw == null || raw === '') return false
  const ts = Number(raw)
  if (Number.isFinite(ts) && ts > 1_000_000_000_000) {
    return Date.now() - ts < ttlMs
  }
  // Legacy "1" stamps: treat as fresh for remaining Cache lifetime only via presence;
  // force expiry by not honoring bare "1" longer than ttl from... we can't know.
  // Fail open after deploy: ignore legacy "1" so heartbeats/alerts can send again.
  return false
}

/**
 * Mini App «Сигналы» setup → TradePlan for journal Lab + paper.
 */
function setupToTradePlan(
  symbol: string,
  setup: ConditionalSetupPayload
): TradePlanPayload {
  const zoneLow = Math.min(setup.entryZone.bottom, setup.entryZone.top)
  const zoneHigh = Math.max(setup.entryZone.bottom, setup.entryZone.top)
  const flat = symbol.includes('_')
    ? symbol
    : `${symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_USDT`
  return {
    side: setup.side,
    symbol: flat,
    setup: setup.title || setup.kind,
    signalPrice: setup.limitEntry,
    entryIdeal: setup.limitEntry,
    zoneLow,
    zoneHigh,
    invalidate:
      setup.side === 'LONG' ? zoneHigh * 1.004 : zoneLow * 0.996,
    sl: setup.invalidation,
    tp: setup.targetsLadder?.r2 ?? setup.target,
    target1: setup.targetsLadder?.r1,
    target3: setup.targetsLadder?.r3 ?? setup.magnet?.price,
    zoneSource:
      setup.kind.includes('SSL')
        ? 'SSL'
        : setup.kind.includes('BSL')
          ? 'BSL'
          : 'SWING',
    zonePhase: 'TOUCH',
    targetLabel: setup.magnet?.label,
  }
}

function formatWatchArmedMessage(watch: WatchedSetupRecord): {
  title: string
  text: string
} {
  const s = watch.setup
  const icon = s.side === 'LONG' ? '🟢' : '🔴'
  const style = s.tradeStyle ?? ''
  return {
    title: `👁 Сигнал · ${watch.symbol} · слежу`,
    text: [
      `${icon} ${s.side} ${watch.symbol}${style ? ` · ${style}` : ''}`,
      s.title,
      '',
      `Зона: ${s.entryZone.bottom} – ${s.entryZone.top}`,
      `Лимит: ${s.limitEntry} · SL ${s.invalidation} · TP ${s.targetsLadder?.r2 ?? s.target}`,
      `Win% ~${Math.round(s.probability)}%`,
      '',
      'Источник: Mini App → вкладка Сигналы',
      'В TG придёт только READY (вход) или INVALIDATED — без спама фаз.',
      'Не входи до READY.',
    ].join('\n'),
  }
}

/**
 * Broadcast TG alert to meme (Predator) or sniper (Elite) channel.
 */
async function broadcastAlert(
  env: Env,
  payload: AlertPayload
): Promise<{ ok: boolean; sent: number; failed: number; skipped?: string }> {
  const channel = channelForAlertType(payload.type, payload.channel)
  const ttlMs = dedupeTtlMs(payload.type)
  if (payload.dedupeKey) {
    const dedupKey = `${DEDUP_PREFIX}${channel}:${payload.dedupeKey}`
    const memKey = `${channel}:${payload.dedupeKey}`
    const [cached, prev] = await Promise.all([
      runtimeGet(dedupKey),
      Promise.resolve(memoryDedup.get(memKey)),
    ])
    if (
      isDedupFresh(cached, ttlMs) ||
      (prev != null && Date.now() - prev < ttlMs)
    ) {
      return { ok: true, sent: 0, failed: 0, skipped: 'dedup' }
    }
  }

  const message = formatAlertMessage(payload)
  let sent = 0
  let failed = 0

  if (payload.chatId) {
    const ok = await tgSend(env, payload.chatId, message, channel)
    if (ok && payload.dedupeKey) {
      const at = Date.now()
      memoryDedup.set(`${channel}:${payload.dedupeKey}`, at)
      await runtimePut(
        `${DEDUP_PREFIX}${channel}:${payload.dedupeKey}`,
        String(at)
      )
    }
    return { ok, sent: ok ? 1 : 0, failed: ok ? 0 : 1 }
  }

  const subs = await listSubscribers(env, channel)
  if (!subs.length) {
    await recordDelivery(env, {
      ok: false,
      channel,
      chatId: null,
      status: 0,
      length: message.length,
      error: 'no subscribers for channel',
      type: payload.type,
      title: payload.title,
    })
    return { ok: false, sent: 0, failed: 0, skipped: 'no_subscribers' }
  }
  for (const sub of subs) {
    if (channel === 'sniper' && sub.sniper === false) continue
    if (channel === 'meme' && sub.meme === false) continue
    if (payload.type === 'SNIPER' && sub.sniper === false) continue
    if (payload.type === 'MEME' && sub.meme === false) continue
    const ok = await tgSend(env, sub.chatId, message, channel)
    if (ok) sent++
    else failed++
  }

  if (sent === 0 && failed === 0) {
    await recordDelivery(env, {
      ok: false,
      channel,
      chatId: null,
      status: 0,
      length: message.length,
      error: 'subscribers filtered out (sniper/meme flags)',
      type: payload.type,
    })
  }

  if (sent > 0 && payload.dedupeKey) {
    const at = Date.now()
    memoryDedup.set(`${channel}:${payload.dedupeKey}`, at)
    await runtimePut(
      `${DEDUP_PREFIX}${channel}:${payload.dedupeKey}`,
      String(at)
    )
  }

  return { ok: sent > 0, sent, failed }
}

async function maybeHeartbeat(env: Env): Promise<number> {
  const last = Number((await durableGet(env, HEARTBEAT_KEY)) || 0)
  if (last && Date.now() - last < HEARTBEAT_MS) return 0

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  // Unique per tick — never share a bucket key that can get stuck in Cache
  const tick = Date.now()
  let sent = 0
  let attempted = 0
  for (const channel of ['meme', 'sniper'] as TgChannel[]) {
    const subs = await listSubscribers(env, channel)
    if (!subs.length) {
      await recordDelivery(env, {
        ok: false,
        channel,
        chatId: null,
        status: 0,
        length: 0,
        error: 'heartbeat: no subscribers',
      })
      continue
    }
    if (!tokenForChannel(env, channel)) {
      await recordDelivery(env, {
        ok: false,
        channel,
        chatId: null,
        status: 0,
        length: 0,
        error: 'heartbeat: token missing',
      })
      continue
    }
    const engine = channel === 'sniper' ? SNIPER_ENGINE : BOT_ENGINE
    attempted++
    const elite = channel === 'sniper' && isEliteAssistantOnly(env)
    const r = await broadcastAlert(env, {
      type: 'SYSTEM',
      channel,
      title: elite ? 'Elite online' : 'Scanner online',
      text: elite
        ? `🏛 Elite Assistant · ${engine.id}\n${now}\nПодписчиков: ${subs.length}\nСледующий доклад ~:05 UTC · /brief`
        : `🟢 24/7 heartbeat · ${engine.id}\n${now}\nПодписчиков: ${subs.length}\nСледующий скан ≤ 2 мин`,
      dedupeKey: `heartbeat:${channel}:${tick}`,
    })
    sent += r.sent
    if (r.skipped) {
      await recordDelivery(env, {
        ok: false,
        channel,
        chatId: null,
        status: 0,
        length: 0,
        error: `heartbeat skipped: ${r.skipped}`,
      })
    }
  }

  // Only advance watermark after we actually tried (or recorded why not)
  if (attempted > 0 || sent > 0) {
    await durablePut(env, HEARTBEAT_KEY, String(Date.now()), 60 * 60 * 24)
  }
  return sent
}

/** If Telegram has been silent too long, poke both bots (proves Worker→TG). */
async function maybeDeliveryProbe(env: Env): Promise<number> {
  // Must use durableGet: recordDelivery writes Cache (+ throttled KV).
  // KV-only gate saw lastAt=0 forever → probe on every paper cron → spam.
  let lastAt = 0
  try {
    const raw = await durableGet(env, LAST_TG_KEY)
    if (raw) lastAt = Number((JSON.parse(raw) as { at?: number }).at || 0)
  } catch {
    lastAt = 0
  }
  if (lastAt > 0 && Date.now() - lastAt < DELIVERY_PROBE_MS) return 0

  let sent = 0
  const ts = new Date().toISOString()
  for (const channel of ['sniper', 'meme'] as TgChannel[]) {
    const subs = await listSubscribers(env, channel)
    const token = tokenForChannel(env, channel)
    if (!subs.length || !token) {
      await recordDelivery(env, {
        ok: false,
        channel,
        chatId: null,
        status: 0,
        length: 0,
        error: !token
          ? 'probe: token missing'
          : 'probe: no subscribers',
      })
      continue
    }
    for (const sub of subs) {
      const r = await tgSendDetailed(
        env,
        sub.chatId,
        [
          `🏓 <b>Delivery probe</b> · ${channel}`,
          `Worker → Telegram self-check`,
          `chatId <code>${sub.chatId}</code>`,
          ts,
        ].join('\n'),
        channel
      )
      if (r.ok) sent++
    }
  }
  return sent
}

// ── Pullback auto-watch from scanner alerts ──────────────────────────────────

function planToPullbackWatch(
  plan: TradePlanPayload,
  winPct: number,
  alertType: 'SNIPER' | 'MEME'
): ConditionalSetupPayload {
  const top = Math.max(plan.zoneLow, plan.zoneHigh)
  const bottom = Math.min(plan.zoneLow, plan.zoneHigh)
  const id = `pb_${alertType}_${plan.symbol}_${plan.setup}`
  const src = plan.zoneSource ?? 'ATR'
  const phase = plan.zonePhase ?? 'FAR'
  return {
    id,
    kind: plan.side === 'LONG' ? 'BOUNCE_SSL' : 'BOUNCE_BSL',
    side: plan.side,
    title:
      alertType === 'MEME'
        ? `MEME follow · ${plan.setup}`
        : `${src} · ${phase} · ${plan.setup}`,
    probability: winPct,
    preconditions: [
      {
        id: 'touch',
        label:
          alertType === 'MEME'
            ? `Контроль входа ${bottom}–${top}`
            : `Ждём касание зоны ${bottom}–${top}`,
        status: phase === 'TOUCH' || alertType === 'MEME' ? 'MET' : 'PENDING',
      },
      {
        id: 'book',
        label: 'Стакан / топливо за сторону',
        status: 'PENDING',
      },
      {
        id: 'confirm',
        label:
          alertType === 'MEME'
            ? 'Удержание / не слом структуры'
            : 'Реакция / reclaim в зоне',
        status: 'PENDING',
      },
    ],
    entryZone: { top, bottom },
    limitEntry: plan.entryIdeal,
    target: plan.tp,
    // plan.invalidate is the maximum chase price, not the setup stop.
    invalidation: plan.sl,
    triggerSummary:
      plan.targetLabel ??
      `${alertType}: ${src} → цель ${plan.tp} · фаза ${phase}`,
    reasoning: [
      src === 'ATR'
        ? 'SSL/BSL не найдена — ATR pullback + watch'
        : `Зона ${src} ×${plan.zoneTouches ?? '?'} (сила ${plan.zoneStrength ?? '?'}) — как в приложении`,
      `Фаза ${phase}: подход → касание → реакция → топливо → полёт к ликвидности`,
      `Лимитка ${plan.entryIdeal} · стоп ${plan.sl} · цель ${plan.tp}`,
      plan.targetLabel ? `Ближ. ликвидность: ${plan.targetLabel}` : `Инвалидация: ${plan.invalidate}`,
    ],
    status: phase === 'TOUCH' ? 'ARMED' : 'HYPOTHESIS',
    symbol: plan.symbol,
    internalSymbol: plan.symbol,
    createdAt: Date.now(),
  }
}

// ── Engine one-shot announce ─────────────────────────────────────────────────

const ENGINE_ANNOUNCE_KEY = 'telegram:engine_announced'

async function announceEngineToChannel(
  env: Env,
  channel: TgChannel,
  engine: { id: string; label: string; deployedNote: string },
  extraLines: string[]
): Promise<void> {
  if (!tokenForChannel(env, channel) || !env.SUBSCRIBERS) return
  const key = `${ENGINE_ANNOUNCE_KEY}:${channel}:${engine.id}`
  const [runtimeDone, done] = await Promise.all([
    runtimeGet(key),
    env.SUBSCRIBERS.get(key),
  ])
  if (runtimeDone || done) return

  const subs = await listSubscribers(env, channel)
  const text = [
    `<b>⚙ Обновление бота: ${engine.id}</b>`,
    engine.label,
    '',
    engine.deployedNote,
    '',
    ...extraLines,
    '',
    'Проверка: /status · ручной скан: /scan',
  ].join('\n')
  let sent = 0
  for (const sub of subs) {
    const ok = await tgSend(env, sub.chatId, text, channel)
    if (ok) sent++
  }
  if (sent > 0 || subs.length === 0) {
    const at = String(Date.now())
    await runtimePut(key, at)
    await kvPutThrottled(env.SUBSCRIBERS, key, at, 6 * 60 * 60_000, {
      expirationTtl: 60 * 60 * 24 * 90,
    })
  }
}

async function maybeAnnounceEngine(env: Env): Promise<void> {
  await announceEngineToChannel(env, 'meme', BOT_ENGINE, [
    'Predator memes: liquidation echo, paper companion.',
  ])
  await announceEngineToChannel(env, 'sniper', SNIPER_ENGINE, [
    'Hourly /brief · daily close · зоны · F&G · новости',
    'Mini App → Сигналы (альты): слежение + READY → журнал Lab WR',
  ])
}

async function runCronScan(
  env: Env,
  role: CronRole = 'all'
): Promise<{
  role: CronRole
  alerts: number
  sent: number
  skipped: number
  heartbeat: number
  paperComments: number
  watchAlerts?: number
  idlePulses?: number
  journalLogged?: number
  journalResolved?: number
  resultAlerts?: number
  predatorSkip?: string
  predatorHotlist?: string[]
}> {
  if (!env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_SNIPER_BOT_TOKEN) {
    return {
      role,
      alerts: 0,
      sent: 0,
      skipped: 0,
      heartbeat: 0,
      paperComments: 0,
    }
  }

  // Dual CF: pending handoff first (fresh subrequest budget), then gate
  if (failoverConfigured(env)) {
    const st = await loadFailoverState(env)
    if (st.active && st.pendingHandoff) {
      const [memeSubs, sniperSubs] = await Promise.all([
        listSubscribers(env, 'meme'),
        listSubscribers(env, 'sniper'),
      ])
      const pending = await processPendingHandoff(env, {
        memeSubs: memeSubs.map((s) => ({
          chatId: s.chatId,
          username: s.username,
          joinedAt: s.subscribedAt,
          memeAlerts: s.meme,
          sniperAlerts: s.sniper,
        })),
        sniperSubs: sniperSubs.map((s) => ({
          chatId: s.chatId,
          username: s.username,
          joinedAt: s.subscribedAt,
          memeAlerts: s.meme,
          sniperAlerts: s.sniper,
        })),
      })
      if (pending.handedOff) {
        const idle = JSON.stringify({
          status: 'HANDED_OFF',
          role,
          failover: pending.state,
          reason: 'pending_handoff',
          at: Date.now(),
        })
        await runtimePut(LAST_SCAN_KEY, idle)
        return {
          role,
          alerts: 0,
          sent: 0,
          skipped: 0,
          heartbeat: 0,
          paperComments: 0,
          predatorSkip: 'handed_off_pending',
        }
      }
    }
  }

  const gate = await shouldRunCronWork(env)
  if (!gate.run) {
    if (gate.reason === 'daily_budget') {
      const [memeSubs, sniperSubs] = await Promise.all([
        listSubscribers(env, 'meme'),
        listSubscribers(env, 'sniper'),
      ])
      await maybeHandoffOnBudget(env, {
        memeSubs: memeSubs.map((s) => ({
          chatId: s.chatId,
          username: s.username,
          joinedAt: s.subscribedAt,
          memeAlerts: s.meme,
          sniperAlerts: s.sniper,
        })),
        sniperSubs: sniperSubs.map((s) => ({
          chatId: s.chatId,
          username: s.username,
          joinedAt: s.subscribedAt,
          memeAlerts: s.meme,
          sniperAlerts: s.sniper,
        })),
      })
    }
    const idle = JSON.stringify({
      status: 'STANDBY_IDLE',
      role,
      failover: gate.state,
      reason: gate.reason,
      at: Date.now(),
    })
    await runtimePut(LAST_SCAN_KEY, idle)
    return {
      role,
      alerts: 0,
      sent: 0,
      skipped: 0,
      heartbeat: 0,
      paperComments: 0,
      predatorSkip: gate.reason ?? 'failover_idle',
    }
  }
  {
    const [memeSubs, sniperSubs] = await Promise.all([
      listSubscribers(env, 'meme'),
      listSubscribers(env, 'sniper'),
    ])
    await maybeHandoffOnBudget(env, {
      memeSubs: memeSubs.map((s) => ({
        chatId: s.chatId,
        username: s.username,
        joinedAt: s.subscribedAt,
        memeAlerts: s.meme,
        sniperAlerts: s.sniper,
      })),
      sniperSubs: sniperSubs.map((s) => ({
        chatId: s.chatId,
        username: s.username,
        joinedAt: s.subscribedAt,
        memeAlerts: s.meme,
        sniperAlerts: s.sniper,
      })),
    })
  }

  const scanStartedAt = Date.now()
  const scanRunning = JSON.stringify({
    status: 'RUNNING',
    role,
    startedAt: scanStartedAt,
  })
  await runtimePut(LAST_SCAN_KEY, scanRunning)
  // Cache only — last_scan was ~2 KV writes per cron (~1400+/day)

  let watchAlerts = 0
  let sent = 0
  let failed = 0
  let skipped = 0
  let paperComments = 0
  let journalLogged = 0
  let journalResolved = 0
  let resultAlerts = 0
  let heartbeat = 0
  let predatorSkip = ''
  let predatorHotlist: string[] = []
  let memeScanned = 0
  const seenDedup = new Set<string>()
  const allAlerts: ScanAlert[] = []

  const bookStore = env.SUBSCRIBERS ? createOrderBookStateStore(env) : undefined
  const kv = env.SUBSCRIBERS
    ? {
        get: async (key: string) => {
          if (
            key.includes('book') ||
            key.includes('order_flow') ||
            key.includes('order_book')
          ) {
            return bookStore!.get(key)
          }
          return (
            (await runtimeGet(`kvblob:${key}`)) ??
            (await env.SUBSCRIBERS!.get(key))
          )
        },
        put: async (key: string, value: string) => {
          if (
            key.includes('book') ||
            key.includes('order_flow') ||
            key.includes('order_book')
          ) {
            await bookStore!.put(key, value)
            return
          }
          await runtimePut(`kvblob:${key}`, value)
          // Critical scan/journal keys must not wait 20m — silence was invisible
          const critical =
            key.includes('peak_decision') ||
            key.includes('hot_meme_watchlist') ||
            key.includes('bot_journal') ||
            key.includes('last_scan_status') ||
            key.includes('pending_meme')
          if (critical) {
            try {
              await env.SUBSCRIBERS!.put(key, value)
            } catch {
              await kvPutThrottled(env.SUBSCRIBERS, key, value, 60_000, {
                force: true,
              })
            }
            return
          }
          await kvPutThrottled(env.SUBSCRIBERS, key, value, 20 * 60_000)
        },
      }
    : undefined

  const deliver = async (a: ScanAlert) => {
    if (seenDedup.has(a.dedupeKey)) return
    // Hard gate: meme = PEAK_FUEL_FAIL SHORT A-tier only (restored v28)
    if (a.type === 'MEME') {
      const plan = a.tradePlan
      if (
        !plan ||
        plan.setup !== 'PEAK_FUEL_FAIL' ||
        plan.side !== 'SHORT' ||
        plan.qualityTier !== 'A'
      ) {
        skipped++
        console.log(
          '[cron] meme blocked non-peak',
          plan?.setup ?? 'no_plan',
          plan?.side,
          plan?.qualityTier
        )
        return
      }
    }
    seenDedup.add(a.dedupeKey)
    allAlerts.push(a)

    if (a.type === 'MEME') {
      if (!a.tradePlan) {
        skipped++
        return
      }
      // Global pace: max 1 new PEAK every 12m (stops alert spam)
      try {
        const paceRaw = await env.SUBSCRIBERS?.get('telegram:last_peak_alert_at')
        const lastAt = paceRaw ? Number(paceRaw) : 0
        if (lastAt > 0 && Date.now() - lastAt < 12 * 60_000) {
          skipped++
          console.log('[cron] meme paced — too soon after last PEAK')
          return
        }
      } catch {
        /* ignore */
      }

      // PAPER FIRST — never TG a signal we won't manage
      let paperId: string | undefined
      let paperComment: Awaited<
        ReturnType<typeof createPaperTradeFromPlan>
      >['comment'] = null
      try {
        const paper = await createPaperTradeFromPlan(env, {
          ...a.tradePlan,
          alertType: 'MEME',
          target1: a.tradePlan.target1,
          target3: a.tradePlan.target3,
          markPrice:
            a.tradePlan.signalPrice || a.tradePlan.entryIdeal || undefined,
        })
        if (!paper.created) {
          skipped++
          console.log(
            '[cron] meme blocked — no paper slot',
            paper.skipReason ?? 'unknown',
            a.dedupeKey
          )
          return
        }
        paperComment = paper.comment
        paperId =
          paper.comment?.dedupeKey?.replace(/^paper:fill:/, '') || undefined
      } catch (err) {
        skipped++
        console.error('[cron] meme paper failed', err)
        return
      }

      let title = a.title
      let text = a.text
      let dedupeKey = a.dedupeKey
      const cr = await broadcastAlert(env, {
        type: 'SYSTEM',
        channel: 'meme',
        title,
        text,
        dedupeKey,
      })
      paperComments += cr.sent
      sent += cr.sent
      failed += cr.failed

      let queued = false
      if (cr.sent === 0 && !cr.skipped) {
        try {
          await enqueuePendingMeme(env, { title, text, dedupeKey })
          queued = true
          console.log('[cron] meme entry queued for paper flush', dedupeKey)
        } catch (err) {
          console.error('[cron] pending meme enqueue failed', err)
        }
      }

      if (cr.sent > 0 || queued) {
        try {
          await env.SUBSCRIBERS?.put(
            'telegram:last_peak_alert_at',
            String(Date.now())
          )
        } catch {
          /* ignore */
        }
      }

      // Optional fill companion (levels) — only if entry TG already went
      if (paperComment && (cr.sent > 0 || queued)) {
        const pr = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: 'meme',
          title: paperComment.title,
          text: paperComment.text,
          dedupeKey: paperComment.dedupeKey,
        })
        paperComments += pr.sent
      }

      const logged = await recordBotAlert(env, {
        alertType: 'MEME',
        score: a.score,
        dedupeKey: a.dedupeKey,
        plan: {
          ...a.tradePlan,
          engineId: BOT_ENGINE.id,
          paperId,
          tgEntrySent: cr.sent > 0 || queued,
        },
      })
      if (logged) journalLogged++
      return
    }

    // Elite meme LONG: PUMP_CONTINUE / DUMP_FUEL_FAIL A — paper-first
    if (
      a.type === 'SNIPER' &&
      a.tradePlan &&
      (a.tradePlan.setup === 'DUMP_FUEL_FAIL' ||
        a.tradePlan.setup === 'PUMP_CONTINUE') &&
      a.tradePlan.side === 'LONG'
    ) {
      if (a.tradePlan.qualityTier !== 'A') {
        skipped++
        return
      }
      try {
        const paceRaw = await env.SUBSCRIBERS?.get(
          'telegram:last_elite_long_alert_at'
        )
        const lastAt = paceRaw ? Number(paceRaw) : 0
        if (lastAt > 0 && Date.now() - lastAt < 12 * 60_000) {
          skipped++
          console.log('[cron] elite long paced — too soon')
          return
        }
      } catch {
        /* ignore */
      }

      let paperId: string | undefined
      let paperComment: Awaited<
        ReturnType<typeof createPaperTradeFromPlan>
      >['comment'] = null
      try {
        const paper = await createPaperTradeFromPlan(env, {
          ...a.tradePlan,
          alertType: 'SNIPER',
          target1: a.tradePlan.target1,
          target3: a.tradePlan.target3,
          markPrice:
            a.tradePlan.signalPrice || a.tradePlan.entryIdeal || undefined,
        })
        if (!paper.created) {
          skipped++
          console.log(
            '[cron] elite long blocked — no paper',
            paper.skipReason ?? 'unknown',
            a.dedupeKey
          )
          return
        }
        paperComment = paper.comment
        paperId =
          paper.comment?.dedupeKey?.replace(/^paper:fill:/, '') || undefined
      } catch (err) {
        skipped++
        console.error('[cron] elite long paper failed', err)
        return
      }

      const cr = await broadcastAlert(env, {
        type: 'SNIPER',
        channel: 'sniper',
        title: a.title,
        text: a.text,
        dedupeKey: a.dedupeKey,
      })
      sent += cr.sent
      failed += cr.failed

      if (cr.sent > 0) {
        try {
          await env.SUBSCRIBERS?.put(
            'telegram:last_elite_long_alert_at',
            String(Date.now())
          )
        } catch {
          /* ignore */
        }
      }

      if (paperComment && cr.sent > 0) {
        const pr = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: 'sniper',
          title: paperComment.title,
          text: paperComment.text,
          dedupeKey: paperComment.dedupeKey,
        })
        paperComments += pr.sent
      }

      const logged = await recordBotAlert(env, {
        alertType: 'SNIPER',
        score: a.score,
        dedupeKey: a.dedupeKey,
        plan: {
          ...a.tradePlan,
          engineId: SNIPER_ENGINE.id,
          paperId,
          tgEntrySent: cr.sent > 0,
        },
      })
      if (logged) journalLogged++
      return
    }

    const alertChannel = channelForAlertType(a.type)
    let shouldCreateWatch = a.watchOnly
    if (!a.watchOnly) {
      const r = await broadcastAlert(env, {
        type: a.type,
        channel: alertChannel,
        title: a.title,
        text: a.text,
        dedupeKey: a.dedupeKey,
      })
      if (r.skipped) {
        skipped++
      } else {
        sent += r.sent
        failed += r.failed
      }
      shouldCreateWatch = r.sent > 0

      if (r.sent > 0 && a.tradePlan) {
        const logged = await recordBotAlert(env, {
          alertType: a.type,
          score: a.score,
          dedupeKey: a.dedupeKey,
          plan: a.tradePlan,
        })
        if (logged) journalLogged++

        const paper = await createPaperTradeFromPlan(env, {
          ...a.tradePlan,
          alertType: a.type,
          vanePath: a.tradePlan.vanePath,
          vaneTier: a.tradePlan.vaneTier,
          vaneScore: a.tradePlan.vaneScore,
        })
        if (paper.comment) {
          const cr = await broadcastAlert(env, {
            type: 'SYSTEM',
            channel: paper.comment.route ?? alertChannel,
            title: paper.comment.title,
            text: paper.comment.text,
            dedupeKey: paper.comment.dedupeKey,
          })
          paperComments += cr.sent
        }
      }
    }

    if (shouldCreateWatch && a.tradePlan && a.needsPullbackWatch) {
      try {
        const setup = planToPullbackWatch(a.tradePlan, a.winPct, a.type)
        const subs = await listSubscribers(env, 'sniper')
        for (const sub of subs) {
          if (sub.sniper === false) continue
          await createWatchesBatch(env, {
            chatId: sub.chatId,
            symbol: a.tradePlan.symbol,
            internalSymbol: a.tradePlan.symbol,
            setups: [setup],
            ttlHours: 12,
          })
        }
      } catch (err) {
        console.error('[cron] pullback watch failed', err)
      }
    }
  }

  const runPaper = async () => {
    // Fresh subrequest budget — deliver PEAK entries that predator couldn't send
    try {
      const flushed = await flushPendingMemeAlerts(
        env,
        async (item) => {
          const r = await broadcastAlert(env, {
            type: 'SYSTEM',
            channel: 'meme',
            title: item.title,
            text: item.text,
            dedupeKey: item.dedupeKey,
          })
          sent += r.sent
          failed += r.failed
          paperComments += r.sent
          return r
        },
        5
      )
      if (flushed.flushed > 0 || flushed.left > 0) {
        console.log(
          '[cron] pending meme flush',
          flushed.flushed,
          'left',
          flushed.left
        )
      }
    } catch (err) {
      console.error('[cron] pending meme flush failed', err)
    }

    try {
      const comments = await monitorPaperTrades(env)
      let tgBudget = 6
      for (const c of comments) {
        if (tgBudget <= 0) break
        // Meme companion TG: PEAK SHORT only — orphan/old dual paper → mute
        if (
          (c.route ?? 'meme') === 'meme' &&
          c.setup !== 'PEAK_FUEL_FAIL'
        ) {
          continue
        }
        // Keep BE/TP1/trail/SL/TP companions — user must see management.
        // Journal still sends final «Результат» for WR book.
        const cr = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: c.route ?? 'meme',
          title: c.title,
          text: c.text,
          dedupeKey: c.dedupeKey,
        })
        paperComments += cr.sent
        if (cr.sent > 0) tgBudget--
      }
    } catch (err) {
      console.error('[cron] paper trade monitor failed', err)
    }
  }

  const runJournal = async () => {
    try {
      // v291 keys are fresh empty — no wipe PUT needed (KV write quota)
      const resolution = await resolveBotJournal(env)
      journalResolved = resolution.changed
      let tgBudget = 5
      for (const outcome of resolution.outcomes) {
        if (outcome.status === 'INVALIDATED') continue
        // Elite: skip quiet TIMEOUT/BE noise — only WIN/LOSS results
        if (
          outcome.alertType === 'SNIPER' &&
          outcome.status !== 'WIN' &&
          outcome.status !== 'LOSS'
        ) {
          continue
        }
        // Meme TG: only PEAK SHORT WIN/LOSS — no orphan TIMEOUT/BE, no dual LONGs
        if (outcome.alertType === 'MEME') {
          if (outcome.setup !== 'PEAK_FUEL_FAIL') continue
          if (outcome.status !== 'WIN' && outcome.status !== 'LOSS') continue
          if (outcome.tgEntrySent === false) continue
        }
        if (tgBudget <= 0) break
        const icon =
          outcome.status === 'WIN'
            ? '🎯'
            : outcome.status === 'LOSS'
              ? '🛑'
              : outcome.status === 'BE'
                ? '🛡'
                : '⏱'
        const autopsy =
          outcome.outcomeHeadline && outcome.outcomeDetail
            ? formatOutcomeAnalysisLines({
                closeReason: outcome.closeReason ?? null,
                primaryTag: outcome.outcomePrimaryTag ?? 'RESOLVED',
                tags: outcome.outcomeTags ?? [],
                headline: outcome.outcomeHeadline,
                detail: outcome.outcomeDetail,
                lesson: outcome.outcomeLesson ?? '',
                tone:
                  outcome.status === 'WIN'
                    ? 'win'
                    : outcome.status === 'LOSS'
                      ? 'loss'
                      : outcome.status === 'INVALIDATED'
                        ? 'skip'
                        : 'neutral',
              })
            : []
        const resultTitle = `${icon} Результат ${outcome.displayName} · ${outcome.status}`
        const resultText = [
          `${outcome.side} · ${outcome.setup}${
            outcome.qualityTier ? ` · Q${outcome.qualityTier}` : ''
          }`,
          `Вход ${outcome.entryPrice} → выход ${outcome.exitPrice ?? '—'}`,
          `Результат: ${outcome.status}${
            outcome.pnlPercent != null
              ? ` · ${outcome.pnlPercent >= 0 ? '+' : ''}${outcome.pnlPercent.toFixed(2)}%`
              : ''
          }`,
          outcome.entryReasons?.length
            ? `Причины входа: ${outcome.entryReasons.slice(0, 8).join(' · ')}`
            : null,
          `MFE +${outcome.mfePercent.toFixed(2)}% · MAE −${outcome.maePercent.toFixed(2)}%`,
          ...autopsy,
        ]
          .filter(Boolean)
          .join('\n')
        const r = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: outcome.alertType === 'SNIPER' ? 'sniper' : 'meme',
          title: resultTitle,
          text: resultText,
          dedupeKey: `journal:result:${outcome.id}:${outcome.status}`,
        })
        resultAlerts += r.sent
        failed += r.failed
        if (r.sent > 0) tgBudget--
      }
    } catch (err) {
      console.error('[cron] journal result failed', err)
    }
  }

  const runPredator = async () => {
    try {
      const papers = await listPaperTrades(env)
      const pinSymbols = papers
        .filter(
          (t) =>
            (t.status === 'OPEN' || t.status === 'WAITING') &&
            (t.alertType === 'MEME' ||
              (t.alertType === 'SNIPER' &&
                (t.setup === 'DUMP_FUEL_FAIL' ||
                  t.setup === 'PUMP_CONTINUE')))
        )
        .map((t) => t.symbol)
      // PEAK SHORT → Predator; PUMP/DUMP LONG A → Elite
      const gates = await getAdaptiveGates(env)
      const flow = await runMemeOrderFlowScan({
        kv,
        pinSymbols,
        gates,
      })
      predatorHotlist = flow.watchlist.entries.map((e) => e.symbol)
      memeScanned = flow.scanned
      for (const a of flow.alerts) {
        try {
          await deliver(a)
        } catch (err) {
          failed++
          console.error('[cron] meme deliver failed', a.dedupeKey, err)
        }
      }
      for (const a of flow.eliteAlerts) {
        try {
          await deliver(a)
        } catch (err) {
          failed++
          console.error('[cron] elite dump deliver failed', a.dedupeKey, err)
        }
      }
      if (!flow.alerts.length && !flow.eliteAlerts.length) {
        predatorSkip = flow.skipped || flow.watchlist.reason || 'no_peak'
        console.log(
          '[cron] peak/dump skip:',
          predatorSkip,
          'scanned',
          memeScanned,
          'hot',
          predatorHotlist.length,
          predatorHotlist.slice(0, 8),
          'rejects',
          flow.rejects.slice(0, 6)
        )
      } else {
        console.log(
          '[cron] peak alerts',
          flow.alerts.map((a) => `${a.tradePlan?.symbol}:${a.tradePlan?.setup}`),
          'elite dumps',
          flow.eliteAlerts.map(
            (a) => `${a.tradePlan?.symbol}:${a.tradePlan?.setup}`
          ),
          'scanned',
          memeScanned,
          '/',
          predatorHotlist.length
        )
      }
      // Expose rejects on scan status for Lab /status debugging
      if (flow.rejects.length) {
        predatorSkip =
          (predatorSkip ? predatorSkip + ' · ' : '') +
          flow.rejects
            .slice(0, 4)
            .map((r) => `${r.symbol}:${r.reason}`)
            .join(',')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      predatorSkip = `scan_error:${msg.slice(0, 160)}`
      console.error('[cron] meme order-flow scan failed', err)
    }
  }

  const runVane = async () => {
    // Elite Assistant mode: no auto trade spam on Enterpriseelite_bot
    if (isEliteAssistantOnly(env)) {
      console.log('[cron] vane skipped — Elite Assistant mode')
      return
    }
    if (!env.TELEGRAM_SNIPER_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN) return
    try {
      const pinSymbols = (await listPaperTrades(env))
        .filter(
          (t) =>
            t.alertType === 'SNIPER' &&
            (t.status === 'OPEN' || t.status === 'WAITING')
        )
        .map((t) => t.symbol)
      const sniperAlerts = await runVaneScan({
        kv,
        pinSymbols,
        batchSize: 5,
      })
      for (const a of sniperAlerts) {
        try {
          await deliver(a)
        } catch (err) {
          console.error('[cron] vane deliver failed', a.dedupeKey, err)
          failed++
        }
      }
    } catch (err) {
      console.error('[cron] vane sniper scan failed', err)
    }
  }

  const runEliteBrief = async (kind: 'hourly' | 'daily') => {
    if (!env.TELEGRAM_SNIPER_BOT_TOKEN) return
    try {
      const stamp =
        kind === 'daily'
          ? new Date().toISOString().slice(0, 10)
          : String(Math.floor(Date.now() / 3_600_000))
      const dedupKey = `telegram:dedup:sniper:elite:${kind}:${stamp}`
      const prev = await runtimeGet(dedupKey)
      if (prev && kind === 'hourly') {
        // allow re-run within hour only via /brief (manual); cron once per hour
        const age = Date.now() - Number(prev)
        if (Number.isFinite(age) && age < 50 * 60_000) {
          console.log('[elite] skip cron — already sent this hour')
          skipped++
          return
        }
      }
      const briefing = await buildEliteBriefing({ kind, kv })
      const subs = await listSubscribers(env, 'sniper')
      for (let i = 0; i < briefing.htmlParts.length; i++) {
        const part = briefing.htmlParts[i]!
        for (const sub of subs) {
          if (sub.sniper === false) continue
          const ok = await tgSend(env, sub.chatId, part, 'sniper')
          if (ok) sent++
          else failed++
        }
      }
      await runtimePut(dedupKey, String(Date.now()))
      // Cache-only elite stamp — hourly KV burned free quota for nothing
      console.log(
        `[elite] ${kind} parts=${briefing.htmlParts.length} coins=${briefing.coins.length} ideas=${briefing.rankedIdeas.length} subs=${subs.length}`
      )
    } catch (err) {
      console.error(`[cron] elite ${kind} failed`, err)
    }
  }

  const runSignalWatches = async () => {
    if (!env.TELEGRAM_SNIPER_BOT_TOKEN && !env.TELEGRAM_BOT_TOKEN) return
    try {
      const alerts = await monitorWatchedSetups(env)
      // Hard filter: Elite alts = actionable only
      const actionable = alerts.filter(
        (a) => a.kind === 'READY' || a.kind === 'INVALIDATED'
      )
      let budget = 4
      for (const a of actionable) {
        if (budget <= 0) break
        const r = await broadcastAlert(env, {
          type: 'SETUP_WATCH',
          channel: 'sniper',
          chatId: a.chatId,
          title: a.title,
          text: a.text,
          dedupeKey: a.dedupeKey,
        })
        if (r.sent > 0) {
          watchAlerts += r.sent
          sent += r.sent
          budget--
        } else {
          failed += r.failed
        }

        // Journal + paper only on READY — Lab WR for Mini App Signals
        if (a.kind === 'READY' && a.setup && a.symbol) {
          const plan = setupToTradePlan(a.symbol, a.setup)
          const logged = await recordBotAlert(env, {
            alertType: 'SNIPER',
            score: Math.round(a.setup.probability),
            dedupeKey: a.dedupeKey,
            plan,
          })
          if (logged) journalLogged++
          try {
            await createPaperTradeFromPlan(env, {
              ...plan,
              alertType: 'SNIPER',
            })
          } catch (err) {
            console.error('[cron] signal watch paper failed', err)
          }
        }
      }
      if (actionable.length) {
        console.log(
          '[cron] signal watches',
          actionable
            .map((x) => `${x.kind ?? '?'}:${x.symbol ?? x.chatId}`)
            .slice(0, 8)
        )
      }
    } catch (err) {
      console.error('[cron] monitorWatchedSetups failed', err)
    }
  }

  // Lightweight housekeeping only on paper ticks (or full manual scan)
  if (role === 'paper' || role === 'all') {
    try {
      await maybeAnnounceEngine(env)
    } catch (err) {
      console.error('[cron] engine announce failed', err)
    }
    try {
      heartbeat = await maybeHeartbeat(env)
    } catch (err) {
      console.error('[cron] heartbeat persist failed', err)
    }
    try {
      const probed = await maybeDeliveryProbe(env)
      if (probed > 0) heartbeat += probed
    } catch (err) {
      console.error('[cron] delivery probe failed', err)
    }
    await runJournal()
    await runPaper()
    await runSignalWatches()
  }

  if (role === 'predator' || role === 'all') {
    await runPredator()
  }

  if (role === 'vane' || role === 'all') {
    await runVane()
    // Do NOT run delivery probe on vane ticks — scan already near CF subrequest cap.
    // Probe stays on paper cron only.
  }

  if (role === 'elite_hourly' || role === 'all') {
    await runEliteBrief('hourly')
  }

  if (role === 'elite_daily') {
    await runEliteBrief('daily')
  }

  const result = {
    role,
    alerts: allAlerts.length,
    sent,
    failed,
    skipped,
    heartbeat,
    paperComments,
    watchAlerts,
    idlePulses: 0,
    journalLogged,
    journalResolved,
    resultAlerts,
    predatorSkip: predatorSkip || (role === 'predator' ? 'ok' : undefined),
    predatorHotlist: predatorHotlist.length ? predatorHotlist : undefined,
    memeScanned: role === 'predator' ? memeScanned : undefined,
  }
  const scanDone = JSON.stringify({
    status: 'COMPLETED',
    startedAt: scanStartedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - scanStartedAt,
    ...result,
  })
  await runtimePut(LAST_SCAN_KEY, scanDone)
  // Always persist per-role snapshot so silence is diagnosable (was 60m throttle)
  await kvPutThrottled(
    env.SUBSCRIBERS,
    `${LAST_SCAN_KEY}:${role}`,
    scanDone,
    90_000,
    { force: true, expirationTtl: 60 * 60 * 24 * 3 }
  )
  return result
}

// ── Subscribers KV ───────────────────────────────────────────────────────────

async function listSubscribers(
  env: Env,
  channel: TgChannel = 'meme'
): Promise<Subscriber[]> {
  const mem = memorySubs[channel]
  if (!env.SUBSCRIBERS) return [...mem.values()]
  const raw = await env.SUBSCRIBERS.get(subKey(channel))
  if (!raw) return [...mem.values()]
  try {
    return JSON.parse(raw) as Subscriber[]
  } catch {
    return [...mem.values()]
  }
}

async function saveSubscribers(
  env: Env,
  list: Subscriber[],
  channel: TgChannel = 'meme'
): Promise<void> {
  const mem = memorySubs[channel]
  mem.clear()
  for (const s of list) mem.set(s.chatId, s)
  if (!env.SUBSCRIBERS) return
  await env.SUBSCRIBERS.put(subKey(channel), JSON.stringify(list))
}

async function upsertSubscriber(
  env: Env,
  sub: Subscriber,
  channel: TgChannel = 'meme'
): Promise<void> {
  const list = await listSubscribers(env, channel)
  const idx = list.findIndex((s) => s.chatId === sub.chatId)
  if (idx >= 0) list[idx] = { ...list[idx], ...sub }
  else list.push(sub)
  await saveSubscribers(env, list, channel)
}

async function removeSubscriber(
  env: Env,
  chatId: number,
  channel: TgChannel = 'meme'
): Promise<void> {
  const list = await listSubscribers(env, channel)
  await saveSubscribers(
    env,
    list.filter((s) => s.chatId !== chatId),
    channel
  )
}

// ── Telegram Bot API ─────────────────────────────────────────────────────────

const HEARTBEAT_KEY = 'telegram:last_heartbeat'
const HEARTBEAT_MS = 30 * 60_000 // every 30 min
/** If no TG delivery stamp for this long → Worker→TG self-check (not a signal) */
const DELIVERY_PROBE_MS = 6 * 60 * 60_000

interface TelegramUpdate {
  message?: {
    chat: { id: number; username?: string; first_name?: string }
    text?: string
    from?: { username?: string }
  }
}

/** `/start@Bot` → `start` */
function parseCommand(text: string): { cmd: string; arg: string } {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return { cmd: '', arg: trimmed }
  const [head, ...rest] = trimmed.split(/\s+/)
  const cmd = (head.split('@')[0] || '').slice(1).toLowerCase()
  return { cmd, arg: rest.join(' ') }
}

async function sendDemoSignal(
  env: Env,
  chatId: number,
  channel: TgChannel
): Promise<void> {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const text =
    channel === 'sniper'
      ? [
          '🟢 <b>LONG BTC/USDT · TEST · SNIPER</b>',
          '',
          'Биржа: MEXC Futures · контракт BTC_USDT',
          `Сигнал @ ${now}`,
          '',
          'Тип: лимит на откат в HTF-зону (как Mini App)',
          'Зона: 94200 – 95100 · ориентир 94600',
          'SL 93800 · TP 96200 · P≈68% · R:R 1:2',
          '',
          'DEMO — проверка доставки. Не торговать.',
        ].join('\n')
      : [
          '🦈 <b>MEME ORDER-FLOW · TEST</b>',
          '',
          `Сигнал @ ${now}`,
          'MEME Day Continue demo — проверка доставки.',
          'Не торговать.',
        ].join('\n')
  await tgSend(env, chatId, text, channel)
}

async function processWebhook(
  env: Env,
  update: TelegramUpdate,
  channel: TgChannel
): Promise<void> {
  const msg = update.message
  if (!msg?.text || !msg.chat?.id) return

  const chatId = msg.chat.id
  const username = msg.from?.username ?? msg.chat.username
  const { cmd } = parseCommand(msg.text)

  try {
    await dispatchCommand(env, chatId, username, cmd, msg.text, channel)
  } catch (err) {
    console.error('[cmd]', channel, cmd, err)
    await tgSend(
      env,
      chatId,
      `⚠️ Ошибка команды /${cmd || '?'}: <code>${String(err).slice(0, 180)}</code>\nПопробуй /ping`,
      channel
    )
  }
}

async function dispatchCommand(
  env: Env,
  chatId: number,
  username: string | undefined,
  cmd: string,
  text: string,
  channel: TgChannel
): Promise<void> {
  const engine = channel === 'sniper' ? SNIPER_ENGINE : BOT_ENGINE

  if (cmd === 'start') {
    await upsertSubscriber(
      env,
      {
        chatId,
        username,
        subscribedAt: Date.now(),
        sniper: true,
        meme: true,
      },
      channel
    )
    const welcome =
      channel === 'sniper'
        ? '🏛 <b>ENTERPRISE ELITE</b> — meme LONG + Signals Lab\n\nМемы LONG A: <b>PUMP_CONTINUE</b> (памп + fuel) · <b>DUMP reclaim</b>\nРаз в час: BTC + TOP-8 · F&amp;G · новости · зоны\nMini App → <b>Сигналы</b> (альты) → READY → журнал WR\n\nКоманды:\n/brief · /market · /zone BTC 94000-96000\n/status · /journal · /trades · /stop'
        : '🚀 <b>ENTERPRISE PREDATOR</b> (@Enterprisesystem_bot)\n\nМемы · PEAK SHORT A · paper companion.\n\nКоманды:\n/status · /scan · /journal · /trades\n/test · /ping · /stop\n/meme_on · /meme_off'
    await tgSend(env, chatId, welcome, channel)
    if (channel === 'sniper') {
      await tgSend(
        env,
        chatId,
        'Следующий автодоклад около :05 UTC каждого часа. Напиши /brief чтобы получить сейчас.',
        channel
      )
    } else {
      await sendDemoSignal(env, chatId, channel)
    }
    return
  }

  if (cmd === 'stop') {
    await removeSubscriber(env, chatId, channel)
    await tgSend(
      env,
      chatId,
      '⏸ Подписка отключена. /start — снова включить.',
      channel
    )
    return
  }

  if (cmd === 'ping' || cmd === 'test') {
    await upsertSubscriber(
      env,
      {
        chatId,
        username,
        subscribedAt: Date.now(),
        sniper: true,
        meme: true,
      },
      channel
    )
    await tgSend(
      env,
      chatId,
      `🏓 <b>PONG</b> · ${engine.id}\nБот онлайн · chatId <code>${chatId}</code>\nКанал: ${channel} · cron */2 · paper ON`,
      channel
    )
    await sendDemoSignal(env, chatId, channel)
    return
  }

  if (cmd === 'trades') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
      return
    }
    const papers = await listPaperTrades(env)
    const filtered = papers.filter((t) =>
      channel === 'sniper' ? t.alertType === 'SNIPER' : t.alertType === 'MEME'
    )
    await tgSend(env, chatId, formatTradesStatus(filtered), channel)
    return
  }

  if (cmd === 'brief' || cmd === 'market') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
      return
    }
    if (channel !== 'sniper') {
      await tgSend(
        env,
        chatId,
        'Доклады Elite — в @Enterpriseelite_bot. Здесь Predator (мемы).',
        channel
      )
      return
    }
    const kvLocal = env.SUBSCRIBERS
      ? {
          get: (key: string) => env.SUBSCRIBERS!.get(key),
          put: (key: string, value: string) => env.SUBSCRIBERS!.put(key, value),
        }
      : undefined
    const arg = parseCommand(text).arg
    if (cmd === 'brief' && arg && !/^(hourly|daily|час|день)$/i.test(arg)) {
      await tgSend(env, chatId, `⏳ Бриф ${arg.toUpperCase()}…`, channel)
      try {
        const body = await buildEliteCoinBrief(arg, kvLocal)
        await tgSend(env, chatId, body, channel)
      } catch (err) {
        console.error('[brief coin]', err)
        await tgSend(env, chatId, 'Не собрал бриф по монете.', channel)
      }
      return
    }
    const kind =
      cmd === 'market'
        ? 'hourly'
        : arg && /daily|день/i.test(arg)
          ? 'daily'
          : 'hourly'
    await tgSend(
      env,
      chatId,
      kind === 'daily' ? '⏳ Суточный Elite…' : '⏳ Hourly Elite…',
      channel
    )
    try {
      const briefing = await buildEliteBriefing({ kind, kv: kvLocal })
      for (const part of briefing.htmlParts) {
        await tgSend(env, chatId, part, channel)
      }
    } catch (err) {
      console.error('[brief]', err)
      await tgSend(env, chatId, 'Не удалось собрать доклад.', channel)
    }
    return
  }

  if (cmd === 'scan') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
      return
    }
    if (channel === 'sniper' && isEliteAssistantOnly(env)) {
      await tgSend(env, chatId, '⏳ Собираю Elite доклад…', channel)
      try {
        const briefing = await buildEliteBriefing({
          kind: 'hourly',
          kv: env.SUBSCRIBERS
            ? {
                get: (key: string) => env.SUBSCRIBERS!.get(key),
                put: (key: string, value: string) =>
                  env.SUBSCRIBERS!.put(key, value),
              }
            : undefined,
        })
        for (const part of briefing.htmlParts) {
          await tgSend(env, chatId, part, channel)
        }
      } catch (err) {
        console.error('[brief] failed', err)
        await tgSend(env, chatId, 'Не удалось собрать доклад. Попробуй позже.', channel)
      }
      return
    }
    await tgSend(env, chatId, '⏳ Сканирую рынок…', channel)
    const result = await runCronScan(env, channel === 'sniper' ? 'vane' : 'predator')
    if (result.alerts === 0) {
      await tgSend(
        env,
        chatId,
        [
          `✅ Скан завершён: сильных сетапов сейчас нет.`,
          `Отправлено: ${result.sent} · дедуп: ${result.skipped}`,
          '',
          `⚙ Движок: <code>${engine.id}</code>`,
          engine.deployedNote,
          '',
          `/status · /test`,
        ].join('\n'),
        channel
      )
    } else {
      await tgSend(
        env,
        chatId,
        `✅ Скан (${engine.id}): найдено ${result.alerts}, отправлено ${result.sent}, дедуп ${result.skipped}\nСопровождение: ${result.paperComments} сообщений`,
        channel
      )
    }
    return
  }

  if (cmd === 'zone' || cmd === 'зона') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await upsertSubscriber(
        env,
        {
          chatId,
          username,
          subscribedAt: Date.now(),
          sniper: true,
          meme: true,
        },
        channel
      )
    }
    const { arg } = parseCommand(text)
    const parsed = parseZoneArg(arg)
    if ('error' in parsed) {
      await tgSend(env, chatId, parsed.error, channel)
      return
    }
    await tgSend(
      env,
      chatId,
      `⏳ Анализирую <code>${parsed.symbol}</code> зону ${parsed.zoneLow}–${parsed.zoneHigh}…`,
      channel
    )
    const result = await analyzeUserZone(parsed)
    if ('error' in result) {
      await tgSend(env, chatId, `❌ ${result.error}`, channel)
      return
    }
    const watches = await createWatchesBatch(env, {
      chatId,
      symbol: result.display,
      internalSymbol: result.symbol,
      setups: [result.setup],
      ttlHours: 72,
    })
    await tgSend(
      env,
      chatId,
      [
        result.reportHtml,
        '',
        watches.length
          ? `✅ Watch на сервере: <code>${watches[0]?.watchId}</code> (TTL 72ч)`
          : '⚠️ Не удалось сохранить watch',
      ].join('\n'),
      channel
    )
    return
  }

  if (cmd === 'zones' || cmd === 'зоны') {
    const watches = await listWatchesForChat(env, chatId)
    const userZones = watches.filter(
      (w) => w.setup.kind === 'USER_ZONE' || w.setup.title.includes('👤')
    )
    if (userZones.length === 0) {
      await tgSend(
        env,
        chatId,
        'Нет твоих зон.\nПример: /zone BTC 94000-96000\nили /zone ETH 3200 3350 long',
        channel
      )
      return
    }
    const lines = userZones.map((w) => {
      const s = w.setup
      const icon = s.side === 'LONG' ? '🟢' : '🔴'
      return `${icon} ${w.symbol} ${s.side} · ${s.entryZone.bottom}–${s.entryZone.top} · ${w.lastLifecyclePhase ?? w.lastStatus} · ~${Math.round(s.probability)}%\n  цель ${s.target} · id <code>${w.watchId}</code>`
    })
    await tgSend(
      env,
      chatId,
      [`<b>👤 Твои зоны (${userZones.length})</b>`, ...lines, '', '/zoneoff BTC — снять по монете'].join(
        '\n'
      ),
      channel
    )
    return
  }

  if (cmd === 'zoneoff' || cmd === 'зонастоп') {
    const { arg } = parseCommand(text)
    const sym = resolveMexcSymbol(arg.split(/\s+/)[0] || '')
    if (!sym) {
      await tgSend(env, chatId, 'Формат: /zoneoff BTC', channel)
      return
    }
    const watches = await listWatchesForChat(env, chatId)
    const victims = watches.filter(
      (w) =>
        (w.internalSymbol === sym || w.symbol.includes(sym.replace('_USDT', ''))) &&
        (w.setup.kind === 'USER_ZONE' || w.setup.title.includes('👤'))
    )
    if (!victims.length) {
      await tgSend(env, chatId, `Нет USER_ZONE watch по ${sym}`, channel)
      return
    }
    let n = 0
    for (const w of victims) {
      if (await deleteWatch(env, chatId, w.watchId)) n++
    }
    await tgSend(env, chatId, `Снято зон: ${n} по ${sym}`, channel)
    return
  }

  if (cmd === 'status') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Вы не подписаны. Нажмите /start', channel)
      return
    }
    const papers = await listPaperTrades(env)
    const live = papers.filter(
      (t) =>
        (t.status === 'WAITING' || t.status === 'OPEN') &&
        (channel === 'sniper' ? t.alertType === 'SNIPER' : t.alertType === 'MEME')
    ).length
    const journal = await getBotJournalPayload(env)
    const wrBlock =
      channel === 'meme'
        ? formatPeakShortStatsReport(journal.entries, journal.gates)
        : formatCorridorWrReport(
            journal.analytics,
            journal.entries,
            journal.gates
          )

    if (channel === 'sniper') {
      const session = evaluateVaneSession()
      await tgSend(
        env,
        chatId,
        [
          `🏛 <b>Статус ELITE Assistant</b>`,
          `⚙ <code>${SNIPER_ENGINE.id}</code>`,
          SNIPER_ENGINE.label,
          SNIPER_ENGINE.deployedNote,
          ``,
          `Доклад: каждый час :05 UTC · суточный 00:05 UTC`,
          `Вселенная: BTC + ETH SOL BNB XRP AVAX LINK DOGE SUI`,
          `Режим: помощник + Mini App Сигналы → журнал Lab`,
          session.ok
            ? `Сессия: ${session.session} OK`
            : `Сессия: ${session.reason}`,
          `Paper (legacy): ${live}`,
          `Подписчиков: ${list.length}`,
          `chatId: <code>${chatId}</code>`,
          ``,
          `/brief · /brief ETH · /market · /zone · /scan · /journal`,
        ].join('\n'),
        channel
      )
      return
    }

    const hot = await loadHotMemeWatchlist(
      env.SUBSCRIBERS
        ? {
            get: (key) => env.SUBSCRIBERS!.get(key),
            put: (key, value) => env.SUBSCRIBERS!.put(key, value),
          }
        : undefined
    )
    const hotParts =
      hot?.entries.map((e) => {
        const name = e.displayName.replace('/USDT', '')
        const tag = e.dayBias === 'PUMP' ? '↑' : '↓'
        return `${name}${tag}${e.chg24hPct >= 0 ? '+' : ''}${e.chg24hPct.toFixed(0)}%`
      }) ?? []
    const hotLine = hotParts.length
      ? `Hot memes: ${hotParts.join(', ')}`
      : 'Hot memes: пуст (жду 24h movers ≥6%)'
    await tgSend(
      env,
      chatId,
      [
        `📊 Статус MEME`,
        `⚙ Движок: <code>${BOT_ENGINE.id}</code>`,
        BOT_ENGINE.label,
        BOT_ENGINE.deployedNote,
        ``,
        `Режим: только PEAK_FUEL_FAIL SHORT A · SL 1% / TP 1.8%`,
        `Сделок в работе: ${live}`,
        `Meme alerts: ${me.meme ? 'ON' : 'OFF'}`,
        hotLine,
        `Подписчиков: ${list.length}`,
        `chatId: <code>${chatId}</code>`,
        ``,
        wrBlock,
        ``,
        `/scan · /trades · /journal`,
      ].join('\n'),
      channel
    )
    return
  }

  if (cmd === 'journal') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
      return
    }
    const journal = await getBotJournalPayload(env)
    const wrBlock =
      channel === 'meme'
        ? formatPeakShortStatsReport(journal.entries, journal.gates)
        : formatCorridorWrReport(
            journal.analytics,
            journal.entries,
            journal.gates
          )
    const insights = journal.analytics.insights
      .slice(0, 5)
      .map((i) => `· ${i.title}: ${i.detail}`)

    const {
      listPeakDecisions,
      summarizePeakDecisions,
    } = await import('./peakDecisionLog')
    const { getJournalAnalysisDump } = await import('./botJournal')
    const peakRows = await listPeakDecisions(env.SUBSCRIBERS, 40)
    const peakSum = summarizePeakDecisions(peakRows)
    const dump = await getJournalAnalysisDump(env, {
      setup: 'PEAK_FUEL_FAIL',
      limit: 80,
      includeArchive: true,
    })
    const peakLines = peakRows.slice(0, 8).map((r) => {
      const tag =
        r.action === 'ALERT'
          ? r.outcome
            ? `${r.outcome.status}${
                r.outcome.pnlPercent != null
                  ? ` ${r.outcome.pnlPercent >= 0 ? '+' : ''}${r.outcome.pnlPercent.toFixed(1)}%`
                  : ''
              }`
            : 'OPEN'
          : r.action.replace('SKIP_', 'skip ')
      return `· ${r.symbol.replace('_USDT', '')} ${tag} · ${(r.reasons ?? []).slice(0, 3).join(',')}`
    })
    const closedPeak = dump.merged.filter(
      (e) => e.status === 'WIN' || e.status === 'LOSS'
    )
    const pw = closedPeak.filter((e) => e.status === 'WIN').length
    const pl = closedPeak.filter((e) => e.status === 'LOSS').length

    await tgSend(
      env,
      chatId,
      [
        `<b>📓 Журнал · ${channel}</b>`,
        wrBlock,
        insights.length ? `\nИнсайты:\n${insights.join('\n')}` : '',
        `\nПороги: meme≥${journal.gates.minMemeScore} sniper≥${journal.gates.minSniperScore}`,
        `\n<b>PEAK архив</b> · ${dump.merged.length} записей · W${pw}/L${pl}${
          pw + pl ? ` · WR ${((100 * pw) / (pw + pl)).toFixed(0)}%` : ''
        }`,
        `\n<b>PEAK лог</b> · alert ${peakSum.alerts} (W${peakSum.alertWins}/L${peakSum.alertLosses}) · skip ${peakSum.skips}`,
        peakLines.length ? peakLines.join('\n') : '· пока пусто',
        peakSum.topSkipReasons.length
          ? `Топ skip: ${peakSum.topSkipReasons
              .slice(0, 4)
              .map((x) => `${x.reason}×${x.n}`)
              .join(' · ')}`
          : '',
        `\nЭкспорт: <code>/telegram/journal?detail=1&setup=PEAK_FUEL_FAIL&format=csv</code>`,
      ]
        .filter(Boolean)
        .join('\n'),
      channel
    )
    return
  }

  if (cmd === 'sniper_on' || cmd === 'sniper_off') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
      return
    }
    me.sniper = cmd === 'sniper_on'
    await saveSubscribers(env, list, channel)
    await tgSend(
      env,
      chatId,
      `Sniper alerts: ${me.sniper ? 'ON ✅' : 'OFF'}`,
      channel
    )
    return
  }

  if (cmd === 'meme_on' || cmd === 'meme_off') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
      return
    }
    me.meme = cmd === 'meme_on'
    await saveSubscribers(env, list, channel)
    await tgSend(
      env,
      chatId,
      `Meme alerts: ${me.meme ? 'ON ✅' : 'OFF'}`,
      channel
    )
  }
}

function formatAlertMessage(payload: AlertPayload): string {
  // Companion / system titles already carry their own emoji
  const icon =
    payload.type === 'SNIPER'
      ? '🎯 '
      : payload.type === 'MEME'
        ? '🚀 '
        : payload.type === 'SETUP_WATCH'
          ? ''
          : ''
  const title = payload.title ? `<b>${escapeHtml(payload.title)}</b>\n` : ''
  return `${icon}${title}${escapeHtml(payload.text)}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function recordDelivery(
  env: Env,
  payload: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify({ ...payload, at: Date.now() })
  // Cache always; KV throttled so probe gate survives isolate/colo churn
  // without burning the free-plan write budget on every TG send.
  await durablePut(env, LAST_TG_KEY, body, 60 * 60 * 24, 40 * 60_000)
  if (payload.ok === false && typeof payload.error === 'string') {
    try {
      await noteFailoverFailure(env, payload.error)
    } catch {
      // ignore
    }
  }
}

async function tgSendDetailed(
  env: Env,
  chatId: number,
  text: string,
  channel: TgChannel = 'meme'
): Promise<{ ok: boolean; status: number; error?: string }> {
  const token = tokenForChannel(env, channel)
  if (!token) {
    await recordDelivery(env, {
      ok: false,
      channel,
      chatId,
      status: 0,
      length: text.length,
      error: 'token missing for channel',
    })
    return { ok: false, status: 0, error: 'token missing for channel' }
  }

  const sendOnce = async (parseMode: 'HTML' | null) => {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: parseMode === 'HTML' ? text : text.replace(/<[^>]+>/g, ''),
      disable_web_page_preview: true,
    }
    if (parseMode) body.parse_mode = parseMode
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const errorText = res.ok ? undefined : (await res.text()).slice(0, 500)
    return { ok: res.ok, status: res.status, error: errorText }
  }

  try {
    let result = await sendOnce('HTML')
    // Bad HTML / entities → retry plain text so signals are not silently dropped
    if (!result.ok && result.status === 400) {
      result = await sendOnce(null)
    }
    await recordDelivery(env, {
      ok: result.ok,
      channel,
      chatId,
      status: result.status,
      length: text.length,
      error: result.error ?? null,
    })
    return result
  } catch (error) {
    const err = String(error).slice(0, 500)
    await recordDelivery(env, {
      ok: false,
      channel,
      chatId,
      status: 0,
      length: text.length,
      error: err,
    })
    return { ok: false, status: 0, error: err }
  }
}

async function tgSend(
  env: Env,
  chatId: number,
  text: string,
  channel: TgChannel = 'meme'
): Promise<boolean> {
  const r = await tgSendDetailed(env, chatId, text, channel)
  return r.ok
}

const DELIVERY_TEST_KEY = 'telegram:delivery_test_at'
const DELIVERY_TEST_COOLDOWN_MS = 3 * 60_000

async function assertDeliveryTestGate(
  env: Env,
  force: boolean
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (env.ALERT_SECRET) {
    // force=1 still rate-limited unless secret presented via header elsewhere;
    // keep public probe but cooldown so it can't be abused to spam.
  }
  if (force) return { ok: true }
  const last = Number((await runtimeGet(DELIVERY_TEST_KEY)) || 0)
  const kvLast = Number((await env.SUBSCRIBERS?.get(DELIVERY_TEST_KEY)) || 0)
  const prev = Math.max(last, kvLast)
  if (prev && Date.now() - prev < DELIVERY_TEST_COOLDOWN_MS) {
    return {
      ok: false,
      error: `cooldown ${Math.ceil((DELIVERY_TEST_COOLDOWN_MS - (Date.now() - prev)) / 1000)}s`,
      status: 429,
    }
  }
  const now = String(Date.now())
  await runtimePut(DELIVERY_TEST_KEY, now)
  // Cache only — probe must not burn KV
  return { ok: true }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

async function proxyFetch(
  targetUrl: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/xml, application/rss+xml, */*',
        'User-Agent': 'EnterpriseSystem/2.0',
      },
    })

    const body = await upstream.arrayBuffer()
    const headers = new Headers(corsHeaders)
    const ct = upstream.headers.get('Content-Type')
    if (ct) headers.set('Content-Type', ct)
    headers.set('Cache-Control', 'public, max-age=5')

    return new Response(body, { status: upstream.status, headers })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Upstream failed', detail: String(err) }),
      {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
}
