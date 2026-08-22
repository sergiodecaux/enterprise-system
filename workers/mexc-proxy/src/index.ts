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
  applyJewelerPaperExit,
  createPaperTradeFromPlan,
  formatTradesStatus,
  listPaperTrades,
  monitorPaperTrades,
} from './paperTrades'
import {
  isSymbolSideBlocked,
  markSymbolSideLock,
} from './symbolSideLock'
import {
  createWatch,
  createWatchesBatch,
  deleteWatch,
  listWatches,
  listWatchesForChat,
  countActiveWatches,
  monitorWatchedSetups,
  type ConditionalSetupPayload,
  type WatchedSetupRecord,
} from './watchedSetups'
import { scanProcessMoments } from './processMoment'
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
import {
  formatMemePipelineDebug,
  loadMemePipelineDebug,
} from './memePipelineDebug'
import { ALT_JEWEL_SETUP } from './eliteAltJewel'
import { loadHotMemeWatchlist } from './hotMemeWatchlist'
import {
  isKvQuotaHandoffDone,
  isKvWriteQuotaExhausted,
  kvPutThrottled,
  markKvWriteQuotaExhausted,
  refreshKvWriteQuotaFromCache,
} from './kvWrite'
import {
  enqueuePendingMeme,
  flushPendingMemeAlerts,
} from './pendingMemeTg'
import {
  activateThisWorker,
  authorizeFailover,
  failoverConfigured,
  HANDOFF_KV_KEYS,
  handoffToPeer,
  loadFailoverState,
  maybeHandoffOnLimit,
  noteFailoverFailure,
  pingRing,
  processPendingHandoff,
  ringIndex,
  ringUrls,
  shouldRunCronWork,
  standbyThisWorker,
  botLane,
  pinEliteWebhook,
  type FailoverHandoffPayload,
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

function toHandoffSub(s: Subscriber): FailoverSubscriberPayload {
  return {
    chatId: s.chatId,
    username: s.username,
    joinedAt: s.subscribedAt,
    memeAlerts: s.meme,
    sniperAlerts: s.sniper,
  }
}

function clipBlob(raw: string | null, max: number): string | null {
  if (!raw) return null
  return raw.length <= max ? raw : raw.slice(0, max)
}

async function collectHandoffPayload(env: Env): Promise<FailoverHandoffPayload> {
  const kv = env.SUBSCRIBERS
  const [memeSubs, sniperSubs, journal, paper, gates, watchlist] =
    await Promise.all([
      listSubscribers(env, 'meme'),
      listSubscribers(env, 'sniper'),
      kv?.get(HANDOFF_KV_KEYS.journal) ?? Promise.resolve(null),
      kv?.get(HANDOFF_KV_KEYS.paper) ?? Promise.resolve(null),
      kv?.get(HANDOFF_KV_KEYS.gates) ?? Promise.resolve(null),
      kv?.get(HANDOFF_KV_KEYS.watchlist) ?? Promise.resolve(null),
    ])
  return {
    memeSubs: memeSubs.map(toHandoffSub),
    sniperSubs: sniperSubs.map(toHandoffSub),
    journal: clipBlob(journal, 400_000),
    paper: clipBlob(paper, 80_000),
    gates: clipBlob(gates, 40_000),
    watchlist: clipBlob(watchlist, 80_000),
  }
}

async function importHandoffKv(
  env: Env,
  body: FailoverHandoffPayload
): Promise<void> {
  const kv = env.SUBSCRIBERS
  if (!kv) return
  const jobs: Promise<unknown>[] = []
  if (body.journal && body.journal.length > 2) {
    jobs.push(
      kvPutThrottled(kv, HANDOFF_KV_KEYS.journal, body.journal, 0, {
        force: true,
      })
    )
  }
  if (body.paper && body.paper.length > 2) {
    jobs.push(
      kvPutThrottled(kv, HANDOFF_KV_KEYS.paper, body.paper, 0, {
        force: true,
      })
    )
  }
  if (body.gates && body.gates.length > 2) {
    jobs.push(
      kvPutThrottled(kv, HANDOFF_KV_KEYS.gates, body.gates, 0, {
        force: true,
      })
    )
  }
  if (body.watchlist && body.watchlist.length > 2) {
    jobs.push(
      kvPutThrottled(kv, HANDOFF_KV_KEYS.watchlist, body.watchlist, 0, {
        force: true,
      })
    )
  }
  if (jobs.length) await Promise.all(jobs)
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
  /** Comma-separated worker URLs in priority order (A,B,C,…) */
  FAILOVER_RING?: string
  FAILOVER_SECRET?: string
  /** This worker public URL, e.g. https://mexc-proxy-xxx.workers.dev */
  PUBLIC_BASE_URL?: string
  /** meme = Predator ring; elite = dedicated alt worker */
  BOT_LANE?: string
  ELITE_PUBLIC_URL?: string
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
  | 'jewel'
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

/** Mini App watches belong on the Elite worker (F). */
async function forwardToEliteProxy(
  env: Env,
  request: Request,
  path: string
): Promise<Response | null> {
  if (botLane(env) === 'elite') return null
  const elite = (env.ELITE_PUBLIC_URL ?? '').replace(/\/$/, '')
  if (!elite) return null
  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('Content-Type') || 'application/json',
  }
  const secret = request.headers.get('X-Alert-Secret')
  if (secret) headers['X-Alert-Secret'] = secret
  const r = await fetch(`${elite}${path}`, {
    method: 'POST',
    headers,
    body: await request.clone().text(),
  })
  return new Response(await r.text(), {
    status: r.status,
    headers: {
      'Content-Type': r.headers.get('Content-Type') || 'application/json',
    },
  })
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
    const shallow = new URL(request.url).searchParams.get('shallow') === '1'
    const state = await loadFailoverState(env)
    await refreshKvWriteQuotaFromCache()
    const peers =
      !shallow && failoverConfigured(env) ? await pingRing(env) : []
    let predatorScanStatus: string | null = null
    let predatorScanStartedAt: number | null = null
    let lastPredatorCompletedAt: number | null = null
    try {
      const raw = await runtimeGet(`${LAST_SCAN_KEY}:predator`)
      if (raw) {
        const scan = JSON.parse(raw) as {
          status?: string
          startedAt?: number
          completedAt?: number
        }
        predatorScanStatus = scan.status ?? null
        predatorScanStartedAt = Number(scan.startedAt ?? 0) || null
        lastPredatorCompletedAt = Number(scan.completedAt ?? 0) || null
      }
    } catch {
      /* health metadata is best-effort */
    }
    return json({
      ok: true,
      configured: failoverConfigured(env),
      role: state.role,
      ring: ringUrls(env),
      ringIndex: ringIndex(env),
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
      kvQuotaExhausted: isKvWriteQuotaExhausted(),
      kvQuotaHandoff: isKvQuotaHandoffDone(),
      predatorScanStatus,
      predatorScanStartedAt,
      lastPredatorCompletedAt,
      peers,
    })
  }

  if (
    path === '/telegram/failover/activate' &&
    (request.method === 'POST' || request.method === 'GET')
  ) {
    if (!authorizeFailover(request, env)) {
      return json({ error: 'Unauthorized' }, 401)
    }
    let reason =
      request.method === 'GET' ? 'manual_force_activate' : 'peer_activate'
    let memeSubs: FailoverSubscriberPayload[] = []
    let sniperSubs: FailoverSubscriberPayload[] = []
    let kvBlob: FailoverHandoffPayload = {}
    if (request.method === 'GET') {
      const u = new URL(request.url)
      if (u.searchParams.get('reason')) {
        reason = String(u.searchParams.get('reason')).slice(0, 200)
      }
    } else {
      try {
        const body = (await request.json()) as FailoverHandoffPayload & {
          reason?: string
        }
        if (body?.reason) reason = String(body.reason).slice(0, 200)
        if (Array.isArray(body?.memeSubs)) memeSubs = body.memeSubs
        if (Array.isArray(body?.sniperSubs)) sniperSubs = body.sniperSubs
        kvBlob = {
          journal: body?.journal,
          paper: body?.paper,
          gates: body?.gates,
          watchlist: body?.watchlist,
        }
      } catch {
        // empty body ok
      }
    }
    // Import subscribers from peer so standby isn't mute (separate KV)
    try {
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
    } catch (err) {
      console.error('[failover] import subs failed', err)
    }
    try {
      await importHandoffKv(env, kvBlob)
    } catch (err) {
      console.error('[failover] import journal/paper failed', err)
    }
    // Never 500 on activate — peer handoff treats non-2xx as failure and dual-active sticks
    try {
      const r = await activateThisWorker(env, reason)
      if (!r.ok) {
        return json(
          {
            ok: false,
            error: r.state.lastReason ?? 'activate_refused',
            state: r.state,
          },
          409
        )
      }
      try {
        await maybeAnnounceEngine(env)
      } catch {
        // Strategy announce is best-effort; activation already succeeded.
      }
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
    const r = await handoffToPeer(
      env,
      'manual_handoff',
      await collectHandoffPayload(env)
    )
    return json(r)
  }

  // Pipeline funnel snapshot (hotlist → ageGate → rejects)
  if (
    (path === '/telegram/pipeline-debug' ||
      path === '/telegram/pipeline-debug/') &&
    request.method === 'GET'
  ) {
    const secret =
      request.headers.get('X-Alert-Secret') ||
      new URL(request.url).searchParams.get('secret')
    if (env.ALERT_SECRET && secret !== env.ALERT_SECRET) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const snap = await loadMemePipelineDebug(env.SUBSCRIBERS)
    return json({ ok: true, snap, text: formatMemePipelineDebug(snap) })
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
      roleParam === 'jewel' ||
      roleParam === 'elite_hourly' ||
      roleParam === 'elite_daily' ||
      roleParam === 'all'
        ? roleParam
        : 'all'
    const result = await runCronScan(env, role)
    return json({ ok: true, ...result })
  }

  if (
    (path === '/telegram/jeweler/command' ||
      path === '/telegram/jeweler/command/') &&
    request.method === 'POST'
  ) {
    if (!env.ALERT_SECRET) {
      return json({ ok: false, error: 'ALERT_SECRET is not configured' }, 503)
    }
    if (request.headers.get('X-Alert-Secret') !== env.ALERT_SECRET) {
      return json({ ok: false, error: 'Unauthorized' }, 401)
    }
    const raw = await request.text()
    if (raw.length > 64_000) {
      return json({ ok: false, error: 'Command is too large' }, 413)
    }
    const signature = request.headers.get('X-Jeweler-Signature') ?? ''
    if (!(await verifyJewelerSignature(raw, env.ALERT_SECRET, signature))) {
      return json({ ok: false, error: 'Invalid command signature' }, 401)
    }
    let command: JewelerCommand
    try {
      command = JSON.parse(raw) as JewelerCommand
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400)
    }
    const now = Date.now()
    if (
      (command.action !== 'SIGNAL' && command.action !== 'EXIT') ||
      command.mode !== 'paper_signal' ||
      !Number.isFinite(command.issuedAt) ||
      !Number.isFinite(command.expiresAt) ||
      command.issuedAt > now + 5_000 ||
      now - command.issuedAt > 30_000 ||
      command.expiresAt < now ||
      command.expiresAt - command.issuedAt > 30_000
    ) {
      return json({ ok: false, error: 'Expired or invalid command envelope' }, 400)
    }
    if (failoverConfigured(env)) {
      const state = await loadFailoverState(env)
      if (!state.active) {
        return json(
          {
            ok: false,
            error: 'standby_node',
            role: state.role,
            peerUrl: state.peerUrl,
          },
          409
        )
      }
    }
    if (command.action === 'EXIT') {
      const exit = command.exit
      if (
        !exit ||
        !/^[A-Z0-9]{2,30}_USDT$/.test(exit.symbol) ||
        (exit.side !== 'LONG' && exit.side !== 'SHORT') ||
        !Number.isFinite(exit.price) ||
        exit.price <= 0 ||
        (exit.action !== 'PARTIAL_EXIT' && exit.action !== 'FULL_EXIT') ||
        ![
          'halfway',
          'book_reversal',
          'toxic_wall',
          'trailing',
          'stop',
          'target',
        ].includes(exit.reason)
      ) {
        return json({ ok: false, error: 'Invalid exit command' }, 400)
      }
      const applied = await applyJewelerPaperExit(env, exit)
      if (applied.comment) {
        await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: 'meme',
          title: applied.comment.title,
          text: applied.comment.text,
          dedupeKey: applied.comment.dedupeKey,
        })
      }
      return json(
        { ok: applied.applied, ...applied },
        applied.applied ? 200 : 409
      )
    }
    const validation = validateJewelerAlert(command.alert)
    if (!validation.ok) {
      return json({ ok: false, error: validation.error }, 400)
    }
    try {
      const delivered = await deliverJewelerAlert(env, command.alert!)
      return json(
        { ok: delivered.accepted, ...delivered },
        delivered.accepted ? 200 : 409
      )
    } catch (err) {
      console.error('[jeweler] command failed', err)
      return json(
        {
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 200) : 'command_failed',
        },
        500
      )
    }
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
    if (payload.type === 'MEME') {
      return json(
        { error: 'Legacy MEME ingress disabled; Jeweler Burst only' },
        410
      )
    }

    const auth = await assertAlertAuth(env, request, payload.chatId)
    if (!auth.ok) return json({ error: auth.error }, 401)

    const broadcast = await broadcastAlert(env, payload)
    return json(broadcast)
  }

  if (path === '/telegram/watch' && request.method === 'POST') {
    const fwd = await forwardToEliteProxy(env, request, '/telegram/watch')
    if (fwd) return fwd
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
    const fwd = await forwardToEliteProxy(env, request, '/telegram/watch/batch')
    if (fwd) return fwd
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
    const { resetAllPeakStats } = await import('./botJournal')
    const { clearPeakDecisions } = await import('./peakDecisionLog')
    const { closeAllMemePapers } = await import('./paperTrades')
    const result = await resetAllPeakStats(env)
    const clearedDecisions = await clearPeakDecisions(env.SUBSCRIBERS)
    const closedPapers = await closeAllMemePapers(env)
    await env.SUBSCRIBERS?.delete('telegram:peak_only_purged_v283')
    await env.SUBSCRIBERS?.delete('telegram:last_peak_alert_at')
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
      engine: BOT_ENGINE.id,
      note: 'Predator MEME clean slate — Elite history preserved; detailed directional journal enabled',
    })
  }

  // Announce current engines / lab to both Telegram bots
  if (
    (path === '/telegram/strategy-status' ||
      path === '/telegram/strategy-status/') &&
    (request.method === 'GET' || request.method === 'POST')
  ) {
    const secret =
      request.headers.get('X-Alert-Secret') ||
      new URL(request.url).searchParams.get('secret')
    if (env.ALERT_SECRET && secret !== env.ALERT_SECRET) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const targetBlock = [
      `<b>🎯 РАЗДЕЛЕНИЕ БОТОВ</b>`,
      `Predator (@Enterprisesystem_bot): только Jeweler Burst LONG/SHORT · quality от 68.`,
      `Elite (@Enterpriseelite_bot): альты как Mini App «Сигналы» · прокси mexc-proxy-f.`,
    ].join('\n')
    const memeText = [
      `🚀 <b>ENTERPRISE PREDATOR</b>`,
      `Engine: <code>${BOT_ENGINE.id}</code>`,
      '',
      targetBlock,
      '',
      `<b>Обновление v28.1:</b>`,
      '• Только Jeweler Burst; legacy и внешний Jeweler Live отключены',
      '• Ищет не только PEAK: RANGE low/high reclaim и пробои границ с объёмом',
      '• Направление LONG/SHORT рассчитывает по forecast + event + tape + walls',
      '• LONG/SHORT: phase + BTC + momentum + свечи, затем 3 снимка стакана',
      '• SHORT veto: bid wall · OBI ≥10% · bid/ask ≥1.55 · forecast NEXT_UP',
      '• LONG veto: ask wall · OBI ≤−10% · bid/ask ≤0.65 · forecast NEXT_DOWN',
      '• sync ≥8 + минимум 2 независимых book evidence + realBook/event',
      '• quality score без базового якоря: SILVER 68 · GOLD 75 · PLATINUM 85',
      '• журнал: phase, BTC, momentum, sync, OBI, book/event, patterns, MFE/MAE',
      '• failover A→B→C при KV/daily limit; quota-dead и stale/CPU-dead peer пропускаются',
      '• сейчас только сигнал + paper companion; одновременно одна MEME-сделка',
      '',
      `Журнал lab <code>v293</code>.`,
      new Date().toISOString(),
    ].join('\n')
    const eliteText = [
      `🏛 <b>ENTERPRISE ELITE</b>`,
      `Engine: <code>${SNIPER_ENGINE.id}</code>`,
      '',
      targetBlock,
      '',
      `<b>Стратегия:</b>`,
      '• как Mini App: зоны HTF, SMC hunt, confluence, ScoreCard',
      '• вход только READY (или INVALIDATED)',
      '• /scan · /brief · /zone · слежение из вкладки Сигналы',
      '',
      `Журнал lab <code>v293</code>.`,
      new Date().toISOString(),
    ].join('\n')
    const meme = await broadcastAlert(env, {
      type: 'SYSTEM',
      channel: 'meme',
      title: 'Predator · цель 30–40% @ ×20',
      text: memeText,
      dedupeKey: `strategy-status:meme:roe30:${Math.floor(Date.now() / 60_000)}`,
    })
    const sniper = await broadcastAlert(env, {
      type: 'SYSTEM',
      channel: 'sniper',
      title: 'Elite · цель 30–40% @ ×20',
      text: eliteText,
      dedupeKey: `strategy-status:sniper:roe30:${Math.floor(Date.now() / 60_000)}`,
    })
    return json({
      ok: true,
      lab: 'v293',
      engines: { meme: BOT_ENGINE.id, elite: SNIPER_ENGINE.id },
      meme,
      sniper,
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

interface JewelerCommand {
  action: 'SIGNAL' | 'EXIT'
  mode: 'paper_signal'
  issuedAt: number
  expiresAt: number
  alert?: ScanAlert
  exit?: {
    symbol: string
    side: 'LONG' | 'SHORT'
    price: number
    action: 'PARTIAL_EXIT' | 'FULL_EXIT'
    reason:
      | 'halfway'
      | 'book_reversal'
      | 'toxic_wall'
      | 'trailing'
      | 'stop'
      | 'target'
  }
}

async function verifyJewelerSignature(
  raw: string,
  secret: string,
  signatureHex: string
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(signatureHex)) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const signature = new Uint8Array(
      signatureHex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16))
    )
    return await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(raw)
    )
  } catch {
    return false
  }
}

function validateJewelerAlert(
  alert: ScanAlert | null | undefined
): { ok: true } | { ok: false; error: string } {
  const plan = alert?.tradePlan
  if (!alert || alert.type !== 'MEME' || !plan) {
    return { ok: false, error: 'MEME tradePlan is required' }
  }
  if (
    !alert.dedupeKey.startsWith('jeweler:burst:') ||
    !plan.entryReasons?.includes('source:jeweler_burst')
  ) {
    return { ok: false, error: 'Invalid dedupe namespace' }
  }
  if (
    !Number.isFinite(alert.score) ||
    !Number.isFinite(alert.winPct) ||
    alert.score < 68 ||
    alert.score > 100 ||
    alert.winPct < 68 ||
    alert.winPct > 100
  ) {
    return { ok: false, error: 'Score gate failed' }
  }
  if (
    plan.qualityTier !== 'A' ||
    !/^[A-Z0-9]{2,30}_USDT$/.test(plan.symbol) ||
    !Number.isFinite(plan.signalPrice) ||
    !Number.isFinite(plan.sl) ||
    !Number.isFinite(plan.tp) ||
    plan.signalPrice <= 0 ||
    plan.sl <= 0 ||
    plan.tp <= 0
  ) {
    return { ok: false, error: 'Invalid trade plan' }
  }
  const validDirection =
    (plan.side === 'LONG' &&
      plan.setup === 'MEME_BOOK_LONG' &&
      plan.sl < plan.signalPrice &&
      plan.tp > plan.signalPrice) ||
    (plan.side === 'SHORT' &&
      plan.setup === 'PEAK_FUEL_FAIL' &&
      plan.sl > plan.signalPrice &&
      plan.tp < plan.signalPrice)
  if (!validDirection) return { ok: false, error: 'Direction/setup mismatch' }
  return { ok: true }
}

async function deliverJewelerAlert(
  env: Env,
  alert: ScanAlert
): Promise<{
  accepted: boolean
  reason?: string
  sent?: number
  queued?: boolean
  paperId?: string
  journalLogged?: boolean
}> {
  const plan = alert.tradePlan!
  try {
    const paceRaw = await env.SUBSCRIBERS?.get('telegram:last_peak_alert_at')
    const lastAt = paceRaw ? Number(paceRaw) : 0
    if (lastAt > 0 && Date.now() - lastAt < 8 * 60_000) {
      return { accepted: false, reason: 'meme_signal_paced' }
    }
  } catch {
    // Paper creation remains the authoritative duplicate/open-position gate.
  }

  const conflict = await isSymbolSideBlocked(
    env.SUBSCRIBERS,
    plan.symbol,
    plan.side
  )
  if (conflict.blocked) {
    return {
      accepted: false,
      reason: `symbol_side_conflict:${conflict.reason ?? 'locked'}`,
    }
  }

  const paper = await createPaperTradeFromPlan(env, {
    ...plan,
    alertType: 'MEME',
    target1: plan.target1,
    target3: plan.target3,
    markPrice: plan.signalPrice || plan.entryIdeal || undefined,
  })
  if (!paper.created) {
    return {
      accepted: false,
      reason: `paper_blocked:${paper.skipReason ?? 'unknown'}`,
    }
  }
  const paperId =
    paper.comment?.dedupeKey?.replace(/^paper:fill:/, '') || undefined
  const delivery = await broadcastAlert(env, {
    type: 'SYSTEM',
    channel: 'meme',
    title: alert.title,
    text: alert.text,
    dedupeKey: alert.dedupeKey,
  })
  let queued = false
  if (delivery.sent === 0 && !delivery.skipped) {
    await enqueuePendingMeme(env, {
      title: alert.title,
      text: alert.text,
      dedupeKey: alert.dedupeKey,
    })
    queued = true
  }
  if (delivery.sent > 0 || queued) {
    try {
      await env.SUBSCRIBERS?.put('telegram:last_peak_alert_at', String(Date.now()))
    } catch {
      /* runtime paper slot still prevents duplicates */
    }
    await markSymbolSideLock(env.SUBSCRIBERS, plan.symbol, plan.side, plan.setup)
  }
  if (paper.comment && (delivery.sent > 0 || queued)) {
    await broadcastAlert(env, {
      type: 'SYSTEM',
      channel: 'meme',
      title: paper.comment.title,
      text: paper.comment.text,
      dedupeKey: paper.comment.dedupeKey,
    })
  }
  const journal = await recordBotAlert(env, {
    alertType: 'MEME',
    score: alert.score,
    dedupeKey: alert.dedupeKey,
    plan: {
      ...plan,
      engineId: `${BOT_ENGINE.id}+jeweler-live-v1`,
      paperId,
      tgEntrySent: delivery.sent > 0 || queued,
    },
  })
  return {
    accepted: true,
    sent: delivery.sent,
    queued,
    paperId,
    journalLogged: Boolean(journal),
  }
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
    if (botLane(env) === 'elite' && channel === 'meme') continue
    if (botLane(env) !== 'elite' && channel === 'sniper') continue
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
    const elite = channel === 'sniper'
    const r = await broadcastAlert(env, {
      type: 'SYSTEM',
      channel,
      title: elite ? 'Elite alts online' : 'Scanner online',
      text: elite
        ? `🏛 Elite · альты как Mini App · ${engine.id}\n${now}\nПодписчиков: ${subs.length}\nЗоны / SMC / READY · прокси mexc-proxy-f`
        : `🟢 Predator · мемы BOOK LONG/SHORT ≥68% · ${engine.id}\n${now}\nПодписчиков: ${subs.length}\nСледующий скан ≤ 2 мин`,
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
    if (botLane(env) === 'elite' && channel === 'meme') continue
    if (botLane(env) !== 'elite' && channel === 'sniper') continue
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

function stableTextHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

async function announceEngineToChannel(
  env: Env,
  channel: TgChannel,
  engine: { id: string; label: string; deployedNote: string },
  extraLines: string[]
): Promise<void> {
  if (!tokenForChannel(env, channel) || !env.SUBSCRIBERS) return
  const releaseHash = stableTextHash(
    [engine.id, engine.label, engine.deployedNote, ...extraLines].join('\n')
  )
  const key = `${ENGINE_ANNOUNCE_KEY}:${channel}:${engine.id}:${releaseHash}`
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
  if (botLane(env) !== 'elite') {
    await announceEngineToChannel(env, 'meme', BOT_ENGINE, [
      '• Только Jeweler Burst; старые MEME и внешний live-ingress отключены.',
      '• Ищет PEAK и RANGE: отбой от границы или подтверждённый пробой.',
      '• Направление выбирается по forecast + event + tape + walls.',
      '• LONG/SHORT: phase + BTC + momentum + свечи, затем 3 снимка стакана.',
      '• SHORT запрещён против bid wall, OBI ≥10%, bid/ask ≥1.55 или NEXT_UP.',
      '• LONG запрещён против ask wall, OBI ≤−10%, bid/ask ≤0.65 или NEXT_DOWN.',
      '• Требуются sync ≥8, ≥2 независимых book evidence и realBook/event.',
      '• Quality score без базы: SILVER 68 · GOLD 75 · PLATINUM 85.',
      '• Журнал v293: phase/BTC/momentum/sync, OBI, book/event, паттерны, MFE/MAE.',
      '• Failover A→B→C: KV/daily limit, отказ исчерпанного peer и stale/CPU-dead scan.',
      '• Режим проверки: только signal + paper companion; максимум одна активная MEME-сделка.',
    ])
  } else {
    await announceEngineToChannel(env, 'sniper', SNIPER_ENGINE, [
      'Hourly /brief · daily close · зоны · F&G · новости',
      'ALT JEWEL: топ‑3 альта · SHORT ×50 · +40% ROE (0.8% цены) — без Mini App',
      'Mini App → Сигналы (альты): слежение + READY → журнал Lab WR',
    ])
  }
}

async function notifyFailoverHandoff(
  env: Env,
  reason: string
): Promise<void> {
  try {
    await broadcastAlert(env, {
      type: 'SYSTEM',
      channel: 'meme',
      title: '🔀 Cloudflare failover',
      text: [
        `Текущий Worker передал сканер следующему узлу A/B/C.`,
        `Причина: ${reason}`,
        'Новый узел повторно проверяет лимит, включает webhook и продолжает paper-журнал.',
      ].join('\n'),
      dedupeKey: `failover:handoff:${reason}:${Math.floor(Date.now() / 300_000)}`,
    })
  } catch {
    // Limit handoff must not fail because Telegram notification failed.
  }
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
    if (st.pendingHandoff) {
      const pending = await processPendingHandoff(
        env,
        await collectHandoffPayload(env)
      )
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
    if (gate.reason === 'daily_budget' || gate.reason === 'kv_quota') {
      try {
        const payload = await collectHandoffPayload(env).catch(() => undefined)
        const handoff = await maybeHandoffOnLimit(env, payload)
        if (handoff.handedOff) {
          await notifyFailoverHandoff(env, gate.reason)
        }
      } catch (err) {
        console.error('[cron] kv_quota handoff failed', err)
      }
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

  // Only the elected owner announces a deploy; standby accounts have separate KV.
  try {
    await maybeAnnounceEngine(env)
  } catch (err) {
    console.error('[cron] engine announce failed', err)
  }

  const scanStartedAt = Date.now()
  const lane = botLane(env)
  if (lane === 'elite') {
    try {
      await pinEliteWebhook(env)
    } catch (err) {
      console.error('[cron] pin elite webhook failed', err)
    }
  }
  const scanRunning = JSON.stringify({
    status: 'RUNNING',
    role,
    startedAt: scanStartedAt,
  })
  await runtimePut(LAST_SCAN_KEY, scanRunning)
  await runtimePut(`${LAST_SCAN_KEY}:${role}`, scanRunning)
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
  let idlePulses = 0
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
            await kvPutThrottled(env.SUBSCRIBERS, key, value, 10 * 60_000)
            return
          }
          await kvPutThrottled(env.SUBSCRIBERS, key, value, 20 * 60_000)
        },
      }
    : undefined

  const deliver = async (a: ScanAlert) => {
    if (seenDedup.has(a.dedupeKey)) return
    // Exclusive meme lane: only Cloudflare Jeweler Burst signals.
    if (a.type === 'MEME') {
      const plan = a.tradePlan
      if (
        !plan ||
        !['PEAK_FUEL_FAIL', 'MEME_BOOK_LONG'].includes(plan.setup) ||
        !plan.entryReasons?.includes('source:jeweler_burst') ||
        !a.dedupeKey.startsWith('jeweler:burst:') ||
        plan.qualityTier !== 'A' ||
        a.winPct < 68
      ) {
        skipped++
        console.log(
          '[cron] meme blocked directional gate',
          plan?.setup ?? 'no_plan',
          plan?.side,
          plan?.qualityTier,
          a.winPct
        )
        return
      }
    }
    seenDedup.add(a.dedupeKey)
    allAlerts.push(a)

    if (a.type === 'MEME' && a.watchOnly) {
      const cr = await broadcastAlert(env, {
        type: 'SYSTEM',
        channel: 'meme',
        title: a.title,
        text: a.text,
        dedupeKey: a.dedupeKey,
      })
      sent += cr.sent
      failed += cr.failed
      if (cr.skipped) skipped++
      return
    }

    if (a.type === 'MEME') {
      if (!a.tradePlan) {
        skipped++
        return
      }
      // Global pace: max one directional meme signal every 8m.
      try {
        const paceRaw = await env.SUBSCRIBERS?.get('telegram:last_peak_alert_at')
        const lastAt = paceRaw ? Number(paceRaw) : 0
        if (lastAt > 0 && Date.now() - lastAt < 8 * 60_000) {
          skipped++
          console.log('[cron] meme paced — too soon after last PEAK')
          return
        }
      } catch {
        /* ignore */
      }

      const conflict = await isSymbolSideBlocked(
        env.SUBSCRIBERS,
        a.tradePlan.symbol,
        a.tradePlan.side
      )
      if (conflict.blocked) {
        skipped++
        console.log(
          '[cron] meme blocked — opposite Elite lock',
          a.tradePlan.symbol,
          conflict.reason
        )
        return
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
        await markSymbolSideLock(
          env.SUBSCRIBERS,
          a.tradePlan.symbol,
        a.tradePlan.side,
          a.tradePlan.setup
        )
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

    // Elite meme LONG: CONT_* / PUMP_CONTINUE / DUMP_FUEL_FAIL A — paper-first
    if (
      a.type === 'SNIPER' &&
      a.tradePlan &&
      (a.tradePlan.setup === 'DUMP_FUEL_FAIL' ||
        a.tradePlan.setup === 'PUMP_CONTINUE' ||
        a.tradePlan.setup.startsWith('CONT_')) &&
      a.tradePlan.side === 'LONG'
    ) {
      if (a.tradePlan.qualityTier !== 'A') {
        skipped++
        return
      }
      // DUMP reclaim 0% WR on v291 — mute until rewrite
      if (a.tradePlan.setup === 'DUMP_FUEL_FAIL') {
        skipped++
        console.log('[cron] elite DUMP muted (0% WR)')
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

      const conflict = await isSymbolSideBlocked(
        env.SUBSCRIBERS,
        a.tradePlan.symbol,
        'LONG'
      )
      if (conflict.blocked) {
        skipped++
        console.log(
          '[cron] elite blocked — opposite Predator lock',
          a.tradePlan.symbol,
          conflict.reason
        )
        return
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
        await markSymbolSideLock(
          env.SUBSCRIBERS,
          a.tradePlan.symbol,
          'LONG',
          a.tradePlan.setup
        )
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

    // Elite ALT_JEWEL — top-3 liquid alts @×50 (SHORT and LONG)
    if (
      a.type === 'SNIPER' &&
      a.tradePlan &&
      a.tradePlan.setup === ALT_JEWEL_SETUP &&
      (a.tradePlan.side === 'SHORT' || a.tradePlan.side === 'LONG')
    ) {
      if (a.tradePlan.qualityTier !== 'A') {
        skipped++
        return
      }
      try {
        const paceRaw = await env.SUBSCRIBERS?.get(
          'telegram:last_elite_alt_jewel_at'
        )
        const lastAt = paceRaw ? Number(paceRaw) : 0
        if (lastAt > 0 && Date.now() - lastAt < 20 * 60_000) {
          skipped++
          console.log('[cron] alt jewel paced — too soon')
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
            '[cron] alt jewel blocked — no paper',
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
        console.error('[cron] alt jewel paper failed', err)
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
            'telegram:last_elite_alt_jewel_at',
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
          if (!item.dedupeKey.startsWith('jeweler:burst:')) {
            return { sent: 0, failed: 0, skipped: 'no_subscribers' }
          }
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
      const burstPaperIds = new Set(
        (await listPaperTrades(env))
          .filter((trade) =>
            trade.entryReasons?.includes('source:jeweler_burst')
          )
          .map((trade) => trade.id)
      )
      let tgBudget = 6
      for (const c of comments) {
        if (tgBudget <= 0) break
        // Meme companion TG: current directional setups only.
        if (
          (c.route ?? 'meme') === 'meme' &&
          (!['PEAK_FUEL_FAIL', 'MEME_BOOK_LONG'].includes(c.setup) ||
            ![...burstPaperIds].some((id) => c.dedupeKey.includes(id)))
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
      // v293 keys are fresh empty — no wipe PUT needed (KV write quota)
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
        // Meme TG: only current directional WIN/LOSS outcomes.
        if (outcome.alertType === 'MEME') {
          if (!['PEAK_FUEL_FAIL', 'MEME_BOOK_LONG'].includes(outcome.setup)) continue
          if (!outcome.entryReasons?.includes('source:jeweler_burst')) continue
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
                  t.setup === 'PUMP_CONTINUE' ||
                  t.setup.startsWith('CONT_'))))
        )
        .map((t) => t.symbol)
      // Predator handles book-confirmed meme LONG/SHORT.
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
        // Do NOT TG here — predator tick already near CF 50-subrequest cap.
        // Idle pulse runs on paper cron (fresh budget). Stamp intent only.
        try {
          const lastIdle = Number(
            (await durableGet(env, IDLE_PULSE_KEY)) || 0
          )
          if (!lastIdle || Date.now() - lastIdle >= IDLE_PULSE_MS) {
            await runtimePut(
              IDLE_PULSE_PENDING_KEY,
              JSON.stringify({
                at: Date.now(),
                scanned: memeScanned,
                hot: predatorHotlist.slice(0, 6),
                rejects: flow.rejects.slice(0, 4).map((r) => ({
                  symbol: r.symbol,
                  reason: r.reason,
                })),
              })
            )
          }
        } catch (err) {
          console.error('[cron] idle pulse stamp failed', err)
        }
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
    if (lane === 'elite') await runSignalWatches()
    // Idle pulse on fresh paper budget (Predator memes only)
    if (lane !== 'elite') {
    try {
      const pendingRaw = await runtimeGet(IDLE_PULSE_PENDING_KEY)
      const lastIdle = Number((await durableGet(env, IDLE_PULSE_KEY)) || 0)
      if (
        pendingRaw &&
        (!lastIdle || Date.now() - lastIdle >= IDLE_PULSE_MS)
      ) {
        let pending: {
          scanned?: number
          hot?: string[]
          rejects?: Array<{ symbol: string; reason: string }>
        } = {}
        try {
          pending = JSON.parse(pendingRaw) as typeof pending
        } catch {
          pending = {}
        }
        const topRejects = (pending.rejects ?? [])
          .slice(0, 4)
          .map((r) => `${r.symbol.replace('_USDT', '')}:${r.reason}`)
          .join('\n• ')
        const nowIso = new Date()
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
        const body = [
          `Сканер жив · A-сетапа нет (~${pending.scanned ?? '?'} тикеров).`,
          `Hot: ${(pending.hot ?? [])
            .map((s) => s.replace('_USDT', ''))
            .join(', ') || '—'}`,
          topRejects ? `Почему:\n• ${topRejects}` : '',
          `${nowIso} UTC · ${BOT_ENGINE.id}`,
        ]
          .filter(Boolean)
          .join('\n')
        const tick = Date.now()
        const m = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: 'meme',
          title: '👁 Ищу мем PEAK',
          text: body,
          dedupeKey: `idle-pulse:meme:${tick}`,
        })
        if (m.sent > 0) {
          idlePulses += m.sent
          await durablePut(
            env,
            IDLE_PULSE_KEY,
            String(Date.now()),
            60 * 60 * 24
          )
          await runtimePut(IDLE_PULSE_PENDING_KEY, '')
        }
      }
    } catch (err) {
      console.error('[cron] idle pulse (paper) failed', err)
    }
    }
  }

  // Mini App watch moments — Elite worker only (alts)
  if (lane === 'elite' && (role === 'paper' || role === 'all')) {
    try {
      const watches = await listWatches(env)
      const now = Date.now()
      const bySym = new Map<string, number>()
      for (const w of watches) {
        if (w.expiresAt <= now) continue
        const sym = (w.internalSymbol || w.symbol || '').toUpperCase()
        if (!sym || sym.includes('MEME')) continue
        if (!bySym.has(sym)) bySym.set(sym, w.chatId)
      }
      const moments = await scanProcessMoments({
        kv: env.SUBSCRIBERS,
        targets: [...bySym.entries()].map(([symbol, chatId]) => ({
          symbol,
          chatId,
        })),
      })
      let momentBudget = 2
      for (const m of moments) {
        if (momentBudget <= 0) break
        const r = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: 'sniper',
          chatId: m.chatId,
          title: m.title,
          text: m.text,
          dedupeKey: m.dedupeKey,
        })
        if (r.sent > 0) {
          watchAlerts += r.sent
          sent += r.sent
          momentBudget--
        } else {
          failed += r.failed
        }
      }
      if (moments.length) {
        console.log(
          '[cron] process moments',
          moments.map((x) => `${x.symbol}:${x.kind}`).slice(0, 6)
        )
      }
    } catch (err) {
      console.error('[cron] processMoment failed', err)
    }
  }

  if (lane !== 'elite' && (role === 'predator' || role === 'all')) {
    await runPredator()
  }

  if (
    lane === 'elite' &&
    (role === 'predator' ||
      role === 'paper' ||
      role === 'vane' ||
      role === 'jewel' ||
      role === 'all')
  ) {
    await runVane()
  }

  if (lane === 'elite' && (role === 'elite_hourly' || role === 'all')) {
    await runEliteBrief('hourly')
  }

  if (lane === 'elite' && role === 'elite_daily') {
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
    idlePulses,
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
  await runtimePut(`${LAST_SCAN_KEY}:${role}`, scanDone)
  await kvPutThrottled(
    env.SUBSCRIBERS,
    `${LAST_SCAN_KEY}:${role}`,
    scanDone,
    10 * 60_000,
    { expirationTtl: 60 * 60 * 24 * 3 }
  )
  if (
    failoverConfigured(env) &&
    isKvWriteQuotaExhausted() &&
    !isKvQuotaHandoffDone()
  ) {
    try {
      const handoff = await maybeHandoffOnLimit(
        env,
        await collectHandoffPayload(env)
      )
      if (handoff.handedOff) {
        await notifyFailoverHandoff(env, 'kv_quota_after_scan')
      }
    } catch (err) {
      console.error('[cron] kv_quota handoff failed', err)
    }
  }
  return result
}

// ── Subscribers KV ───────────────────────────────────────────────────────────

async function listSubscribers(
  env: Env,
  channel: TgChannel = 'meme'
): Promise<Subscriber[]> {
  const mem = memorySubs[channel]
  const parse = (raw: string | null): Subscriber[] | null => {
    if (!raw) return null
    try {
      const list = JSON.parse(raw) as Subscriber[]
      return Array.isArray(list) && list.length ? list : null
    } catch {
      return null
    }
  }
  if (env.SUBSCRIBERS) {
    try {
      const fromKv = parse(await env.SUBSCRIBERS.get(subKey(channel)))
      if (fromKv) {
        mem.clear()
        for (const s of fromKv) mem.set(s.chatId, s)
        await writeSubCache(channel, fromKv)
        return fromKv
      }
    } catch {
      /* quota / network */
    }
  }
  const fromCache = parse(await runtimeGet(`subs:${channel}`))
  if (fromCache) {
    mem.clear()
    for (const s of fromCache) mem.set(s.chatId, s)
    return fromCache
  }
  if (mem.size) return [...mem.values()]
  const seeded = seedSubscribers(channel)
  await saveSubscribers(env, seeded, channel)
  return seeded
}

async function writeSubCache(
  channel: TgChannel,
  list: Subscriber[]
): Promise<void> {
  memoryRuntime.set(`subs:${channel}`, JSON.stringify(list))
  try {
    await caches.default.put(
      runtimeCacheRequest(`subs:${channel}`),
      new Response(JSON.stringify(list), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    )
  } catch {
    /* memory only */
  }
}

/** Lab owner chats — last known live health. Never leave TG with 0 recipients. */
function seedSubscribers(channel: TgChannel): Subscriber[] {
  const ids = channel === 'sniper' ? [1996603727] : [1996603727, 1118540342]
  const now = Date.now()
  return ids.map((chatId) => ({
    chatId,
    subscribedAt: now,
    sniper: channel === 'sniper',
    meme: channel === 'meme',
  }))
}

async function saveSubscribers(
  env: Env,
  list: Subscriber[],
  channel: TgChannel = 'meme'
): Promise<void> {
  const mem = memorySubs[channel]
  mem.clear()
  for (const s of list) mem.set(s.chatId, s)
  await writeSubCache(channel, list)
  if (!env.SUBSCRIBERS) return
  try {
    await env.SUBSCRIBERS.put(subKey(channel), JSON.stringify(list))
  } catch {
    await markKvWriteQuotaExhausted()
  }
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
const IDLE_PULSE_KEY = 'telegram:last_idle_pulse'
const IDLE_PULSE_PENDING_KEY = 'telegram:idle_pulse_pending'
/** «Ищу сетап» — only on paper cron (fresh subrequest budget) */
const IDLE_PULSE_MS = 90 * 60_000
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
        // Channel-scoped lists — never cross-enable both alert families
        sniper: channel === 'sniper',
        meme: channel === 'meme',
      },
      channel
    )
    const welcome =
      channel === 'sniper'
        ? '🏛 <b>ENTERPRISE ELITE</b> (@Enterpriseelite_bot)\n\nАльты · как Mini App «Сигналы»: зоны, SMC, confluence.\nВход в TG только когда сетап <b>READY</b>.\nПрокси: <code>mexc-proxy-f</code> (Money bot 7).\nМемы — в @Enterprisesystem_bot.\n\nКоманды:\n/scan · /brief · /market · /zone BTC 94000-96000\n/status · /journal · /trades · /stop'
        : '🚀 <b>ENTERPRISE PREDATOR</b> (@Enterprisesystem_bot)\n\nJeweler Burst · PEAK + RANGE · направление по forecast/event/tape/walls · phase+BTC+sync+3-snapshot стакан · quality от 68 · paper-first.\nАльты — в @Enterpriseelite_bot.\n\nКоманды:\n/status · /scan · /journal · /trades\n/test · /ping · /stop\n/meme_on · /meme_off'
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

  if (cmd === 'debug' || cmd === 'pipeline') {
    const snap = await loadMemePipelineDebug(env.SUBSCRIBERS)
    await tgSend(env, chatId, formatMemePipelineDebug(snap), channel)
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
    if (channel === 'sniper') {
      await tgSend(env, chatId, '⏳ Сканирую альты (зоны / SMC, как Mini App)…', channel)
      const result = await runCronScan(env, 'vane')
      if (result.alerts === 0) {
        await tgSend(
          env,
          chatId,
          [
            `✅ Скан альтов: сильного сетапа (READY) сейчас нет.`,
            `Отправлено: ${result.sent} · дедуп: ${result.skipped}`,
            '',
            `⚙ Движок: <code>${engine.id}</code>`,
            engine.deployedNote,
            '',
            `/status · /brief · /trades`,
          ].join('\n'),
          channel
        )
      } else {
        await tgSend(
          env,
          chatId,
          `✅ Скан альтов (${engine.id}): найдено ${result.alerts}, отправлено ${result.sent}, дедуп ${result.skipped}`,
          channel
        )
      }
      return
    }
    await tgSend(env, chatId, '⏳ Сканирую мемы…', channel)
    const result = await runCronScan(env, 'predator')
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
          `🏛 <b>Статус ELITE · альты</b>`,
          `⚙ <code>${SNIPER_ENGINE.id}</code>`,
          SNIPER_ENGINE.label,
          SNIPER_ENGINE.deployedNote,
          ``,
          `Ищу: альты как Mini App — зоны HTF, SMC hunt, confluence, READY`,
          `Прокси: mexc-proxy-f · мемы в @Enterprisesystem_bot`,
          `Доклад: каждый час :05 UTC · суточный 00:05 UTC`,
          `Вселенная: BTC + ETH SOL BNB XRP AVAX LINK DOGE SUI + jewel pool`,
          session.ok
            ? `Сессия: ${session.session} OK`
            : `Сессия: ${session.reason}`,
          `Paper альты: ${live}`,
          `Подписчиков: ${list.length}`,
          `chatId: <code>${chatId}</code>`,
          ``,
          `/scan · /brief · /brief ETH · /market · /zone · /journal`,
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
        `Режим: только Jeweler Burst · quality ≥68 · paper-first`,
        `Альты: нет (они в @Enterpriseelite_bot)`,
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
  // Cache hot market GETs — Mini App + bots share Free daily/request budget
  const cacheable =
    /\/api\/v1\/contract\/(ticker|kline|depth|deals|fair_price)/i.test(
      targetUrl
    ) || /\/api\/v3\//i.test(targetUrl)
  const cacheKey = new Request(
    `https://enterprise-system-runtime.invalid/proxy-cache/${encodeURIComponent(targetUrl)}`,
    { method: 'GET' }
  )
  if (cacheable) {
    try {
      const hit = await caches.default.match(cacheKey)
      if (hit) {
        const headers = new Headers(hit.headers)
        for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v)
        headers.set('X-Proxy-Cache', 'HIT')
        return new Response(hit.body, { status: hit.status, headers })
      }
    } catch {
      /* miss */
    }
  }

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
    const maxAge = /\/ticker/i.test(targetUrl)
      ? 8
      : /\/(kline|depth|deals)/i.test(targetUrl)
        ? 5
        : 5
    headers.set('Cache-Control', `public, max-age=${maxAge}`)
    headers.set('X-Proxy-Cache', 'MISS')

    const out = new Response(body, { status: upstream.status, headers })
    if (cacheable && upstream.ok) {
      try {
        const toStore = out.clone()
        const storeHeaders = new Headers(toStore.headers)
        storeHeaders.set(
          'Cache-Control',
          `public, max-age=${Math.max(maxAge, 8)}`
        )
        await caches.default.put(
          cacheKey,
          new Response(toStore.body, {
            status: toStore.status,
            headers: storeHeaders,
          })
        )
      } catch {
        /* ignore cache write */
      }
    }
    return out
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
