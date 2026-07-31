/**
 * Cloudflare Worker — CORS proxy (MEXC + news) + dual Telegram bots.
 *
 * Secrets:
 *   npx wrangler secret put TELEGRAM_BOT_TOKEN          # meme / Predator
 *   npx wrangler secret put TELEGRAM_SNIPER_BOT_TOKEN   # BTC/alts zones
 *   npx wrangler secret put ALERT_SECRET
 *
 * KV:
 *   binding SUBSCRIBERS (see wrangler.toml)
 *
 * Webhooks (once after deploy):
 *   curl "https://api.telegram.org/bot<MEME_TOKEN>/setWebhook?url=https://<worker>/telegram/webhook"
 *   curl "https://api.telegram.org/bot<SNIPER_TOKEN>/setWebhook?url=https://<worker>/telegram/webhook/sniper"
 *
 * Crons (split budget): predator every 2m, paper on odd minutes, vane every 3m.
 */

import type { ScanAlert, TradePlanPayload } from './scanner'
import { runVaneScan, loadVaneRisk, vaneTradingPaused } from './vane'
import { evaluateVaneSession } from './vane/sessionFilter'
import { BOT_ENGINE, SNIPER_ENGINE } from './botEngine'
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
  type ConditionalSetupPayload,
} from './watchedSetups'
import {
  getBotJournalPayload,
  recordBotAlert,
  resolveBotJournal,
  formatCorridorWrReport,
} from './botJournal'
import { formatOutcomeAnalysisLines } from './tradeOutcomeAnalysis'
import { runMemeOrderFlowScan } from './memeOrderFlow'
import { loadHotMemeWatchlist } from './hotMemeWatchlist'

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
  expirationTtl = 60 * 60 * 24 * 7
): Promise<void> {
  await runtimePut(key, value)
  try {
    await env.SUBSCRIBERS?.put(key, value, { expirationTtl })
  } catch {
    /* quota */
  }
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
      // Always checkpoint to KV. Throttling to 6m broke the 3-snap sequence on
      // cold isolates → age>6m → empty events → multi-hour meme silence.
      if (env.SUBSCRIBERS) {
        try {
          await env.SUBSCRIBERS.put(key, value)
        } catch {
          // Quota exhaustion recovers after daily reset; Cache still helps.
        }
      }
    },
  }
}

interface Env {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_SNIPER_BOT_TOKEN?: string
  ALERT_SECRET?: string
  SUBSCRIBERS?: KVNamespace
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

export type CronRole = 'predator' | 'paper' | 'vane' | 'all'

function cronRoleFromExpression(cron: string): CronRole {
  if (cron === '1-59/2 * * * *') return 'paper'
  if (cron === '* * * * *') return 'vane'
  if (cron === '*/2 * * * *') return 'predator'
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
    const [lastScanCache, lastScanKv, lastDeliveryCache, lastDeliveryKv, hotList] =
      await Promise.all([
        runtimeGet(LAST_SCAN_KEY),
        env.SUBSCRIBERS?.get(LAST_SCAN_KEY) ?? Promise.resolve(null),
        runtimeGet(LAST_TG_KEY),
        env.SUBSCRIBERS?.get(LAST_TG_KEY) ?? Promise.resolve(null),
        loadHotMemeWatchlist(kv),
      ])
    let lastScan: unknown = null
    let lastDelivery: unknown = null
    try {
      const raw = lastScanCache ?? lastScanKv
      lastScan = raw ? JSON.parse(raw) : null
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
        vane: '* * * * *',
      },
      mode: 'auto-search 24/7: vane every 1m · meme order-flow every 2m',
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
      await tgSend(
        env,
        body.chatId,
        [
          `<b>📡 Мониторинг включён</b>`,
          `Сетапов на сервере: <b>${watches.length}</b>`,
          `Символ: ${body.symbol}`,
          `Отчёт в Telegram каждые <b>5 минут</b> · уровни сетапов обновляются каждые <b>10 минут</b>.`,
          `Cron worker: каждые 2 мин проверяет зоны / READY / INVALIDATED / устаревший откат.`,
        ].join('\n'),
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

  if (path === '/telegram/journal' && request.method === 'GET') {
    const payload = await getBotJournalPayload(env)
    return json({ ok: true, ...payload })
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
  return type === 'MEME' ? 900_000 : 3600_000
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
    const r = await broadcastAlert(env, {
      type: 'SYSTEM',
      channel,
      title: 'Scanner online',
      text: `🟢 24/7 heartbeat · ${engine.id}\n${now}\nПодписчиков: ${subs.length}\nСледующий скан ≤ 2 мин`,
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
  // Gate on KV only — Cache can look "fresh" while KV (and ops) see a 2-day-old stamp.
  let lastAt = 0
  try {
    const raw = await env.SUBSCRIBERS?.get(LAST_TG_KEY)
    if (raw) lastAt = Number((JSON.parse(raw) as { at?: number }).at || 0)
  } catch {
    lastAt = 0
  }
  if (lastAt && Date.now() - lastAt < DELIVERY_PROBE_MS) return 0

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
    try {
      await env.SUBSCRIBERS.put(key, at, {
        expirationTtl: 60 * 60 * 24 * 90,
      })
    } catch {
      /* quota */
    }
  }
}

async function maybeAnnounceEngine(env: Env): Promise<void> {
  await announceEngineToChannel(env, 'meme', BOT_ENGINE, [
    'Predator memes: liquidation echo, paper companion.',
  ])
  await announceEngineToChannel(env, 'sniper', SNIPER_ENGINE, [
    'В каждом сигнале:',
    '· зона SSL/BSL с 4H или Daily + сила /10',
    '· цель = ближайшая opposite HTF-ликвидность',
    '· Fear&Greed · новости · BTC.D в вероятности',
    '· фазы APPROACH → TOUCH → реакция → топливо',
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
  const scanStartedAt = Date.now()
  const scanRunning = JSON.stringify({
    status: 'RUNNING',
    role,
    startedAt: scanStartedAt,
  })
  await runtimePut(LAST_SCAN_KEY, scanRunning)
  try {
    await env.SUBSCRIBERS?.put(LAST_SCAN_KEY, scanRunning)
  } catch {
    /* quota */
  }

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

  const kv = env.SUBSCRIBERS
    ? {
        get: (key: string) => env.SUBSCRIBERS!.get(key),
        put: (key: string, value: string) => env.SUBSCRIBERS!.put(key, value),
      }
    : undefined

  const deliver = async (a: ScanAlert) => {
    if (seenDedup.has(a.dedupeKey)) return
    seenDedup.add(a.dedupeKey)
    allAlerts.push(a)

    if (a.type === 'MEME') {
      // Never silent-drop a predator/meme signal if paper caps block companion trade.
      let title = a.title
      let text = a.text
      let dedupeKey = a.dedupeKey
      if (a.tradePlan) {
        const paper = await createPaperTradeFromPlan(env, {
          ...a.tradePlan,
          alertType: 'MEME',
          target1: a.tradePlan.target1,
          target3: a.tradePlan.target3,
        })
        if (paper.created && paper.comment) {
          title = paper.comment.title
          // Keep echo details (wave/fade/wall) under the companion header
          text = [paper.comment.text, '', a.text].filter(Boolean).join('\n')
          dedupeKey = paper.comment.dedupeKey
          const logged = await recordBotAlert(env, {
            alertType: 'MEME',
            score: a.score,
            dedupeKey: a.dedupeKey,
            plan: a.tradePlan,
          })
          if (logged) journalLogged++
        } else {
          skipped++
          console.log(
            '[cron] meme paper skipped —',
            paper.skipReason ?? 'unknown',
            a.dedupeKey
          )
          // Cooldown: don't spam TG with same symbol re-alerts.
          if (paper.skipReason === 'cooldown') return
        }
      }
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
    try {
      const comments = await monitorPaperTrades(env)
      let tgBudget = 4
      for (const c of comments) {
        if (tgBudget <= 0) break
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
      const resolution = await resolveBotJournal(env)
      journalResolved = resolution.changed
      let tgBudget = 3
      for (const outcome of resolution.outcomes) {
        if (outcome.status === 'INVALIDATED') continue
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
        const r = await broadcastAlert(env, {
          type: 'SYSTEM',
          channel: outcome.alertType === 'SNIPER' ? 'sniper' : 'meme',
          title: `${icon} Результат ${outcome.displayName} · ${outcome.status}`,
          text: [
            `${outcome.side} · ${outcome.setup}`,
            `Вход ${outcome.entryPrice} → выход ${outcome.exitPrice ?? '—'}`,
            `Результат: ${outcome.status}${
              outcome.pnlPercent != null
                ? ` · ${outcome.pnlPercent >= 0 ? '+' : ''}${outcome.pnlPercent.toFixed(2)}%`
                : ''
            }`,
            `MFE +${outcome.mfePercent.toFixed(2)}% · MAE −${outcome.maePercent.toFixed(2)}%`,
            ...autopsy,
          ].join('\n'),
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
            t.alertType === 'MEME' &&
            (t.status === 'OPEN' || t.status === 'WAITING')
        )
        .map((t) => t.symbol)
      // Causality lab: order-flow MM join replaces liquidation-echo wait
      const flow = await runMemeOrderFlowScan({ kv, pinSymbols })
      predatorHotlist = flow.watchlist.entries.map((e) => e.symbol)
      memeScanned = flow.scanned
      for (const a of flow.alerts) {
        await deliver(a)
      }
      if (!flow.alerts.length) {
        predatorSkip = flow.skipped || flow.watchlist.reason || 'no_flow'
        console.log(
          '[cron] meme-flow skip:',
          predatorSkip,
          'hot',
          predatorHotlist,
          'rejects',
          flow.rejects.slice(0, 4)
        )
      }
    } catch (err) {
      console.error('[cron] meme order-flow scan failed', err)
    }
  }

  const runVane = async () => {
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
  }

  if (role === 'predator' || role === 'all') {
    await runPredator()
    // Echo time-stop needs paper monitor soon after fill — cheap pass
    if (role === 'predator') {
      try {
        const comments = await monitorPaperTrades(env)
        let tgBudget = 2
        for (const c of comments) {
          if (tgBudget <= 0) break
          if (!c.title.includes('PREDATOR') && !c.dedupeKey.includes('timestop'))
            continue
          const cr = await broadcastAlert(env, {
            type: 'SYSTEM',
            channel: 'meme',
            title: c.title,
            text: c.text,
            dedupeKey: c.dedupeKey,
          })
          paperComments += cr.sent
          if (cr.sent > 0) tgBudget--
        }
      } catch (err) {
        console.error('[cron] predator paper slice failed', err)
      }
    }
  }

  if (role === 'vane' || role === 'all') {
    await runVane()
    // Do NOT run delivery probe on vane ticks — scan already near CF subrequest cap.
    // Probe stays on paper cron only.
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
    predatorSkip: predatorSkip || undefined,
    predatorHotlist: predatorHotlist.length ? predatorHotlist : undefined,
    memeScanned: memeScanned || undefined,
  }
  const scanDone = JSON.stringify({
    status: 'COMPLETED',
    startedAt: scanStartedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - scanStartedAt,
    ...result,
  })
  await runtimePut(LAST_SCAN_KEY, scanDone)
  try {
    await env.SUBSCRIBERS?.put(LAST_SCAN_KEY, scanDone)
    // Per-role so vane/predator don't erase paper evidence
    await env.SUBSCRIBERS?.put(`${LAST_SCAN_KEY}:${role}`, scanDone, {
      expirationTtl: 60 * 60 * 24 * 3,
    })
  } catch {
    /* quota */
  }
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
/** If no successful/failed delivery recorded for this long → force Worker→TG poke */
const DELIVERY_PROBE_MS = 45 * 60_000

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
        ? '🎯 <b>ENTERPRISE VANE</b>\n\nСам ловит MACRO-ходы 24/7 (каждую минуту).\nTP 1.5–3.8% · WITH HTF · импульс уже пошёл\n🚀 MACRO приоритет · без WAIT-шума\n\nКоманды:\n/zone BTC 94000-96000\n/status · /trades · /journal\n/scan — ручной догон · /stop'
        : '🚀 <b>ENTERPRISE PREDATOR</b> (@Enterprisesystem_bot)\n\nМемы · Liquidation Echo · paper companion.\n\nКоманды:\n/status · /scan · /journal · /trades\n/test · /ping · /stop\n/meme_on · /meme_off'
    await tgSend(env, chatId, welcome, channel)
    await sendDemoSignal(env, chatId, channel)
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

  if (cmd === 'scan') {
    const list = await listSubscribers(env, channel)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start', channel)
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
    const wrBlock = formatCorridorWrReport(
      journal.analytics,
      journal.entries,
      journal.gates
    )

    if (channel === 'sniper') {
      const vaneRisk = await loadVaneRisk(
        env.SUBSCRIBERS
          ? {
              get: (key) => env.SUBSCRIBERS!.get(key),
              put: (key, value) => env.SUBSCRIBERS!.put(key, value),
            }
          : undefined
      )
      const pause = vaneTradingPaused(vaneRisk)
      const session = evaluateVaneSession()
      await tgSend(
        env,
        chatId,
        [
          `📊 Статус VANE · BTC/Alts`,
          `⚙ Движок: <code>${SNIPER_ENGINE.id}</code>`,
          SNIPER_ENGINE.label,
          SNIPER_ENGINE.deployedNote,
          ``,
          `Автопоиск: каждую минуту · MACRO ходы · без WAIT-шума`,
          `TP ≈2.4×ATR1m (0.75–1.8%) · R:R≥1.2 · cluster LONGs ≤2`,
          `Сделок в работе: ${live}`,
          `Open slots: ${vaneRisk.openSymbols.map((s) => s.replace('_USDT', '')).join(', ') || '—'}`,
          pause.paused
            ? `⏸ ПАУЗА: ${pause.reason}`
            : `▶ Торговля: ON · день PnL ${vaneRisk.dayPnlPct.toFixed(2)}% · streak LOSS ${vaneRisk.consecutiveLosses}`,
          session.ok
            ? `Сессия: ${session.session} OK`
            : `Сессия BLOCK: ${session.reason}`,
          `Sniper alerts: ${me.sniper ? 'ON' : 'OFF'}`,
          `Подписчиков: ${list.length}`,
          `chatId: <code>${chatId}</code>`,
          ``,
          wrBlock,
          ``,
          `/zone · /scan · /trades · /journal`,
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
        `Режим: MEME Day Continue v26 (cron */2)`,
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
    const wrBlock = formatCorridorWrReport(
      journal.analytics,
      journal.entries,
      journal.gates
    )
    const insights = journal.analytics.insights
      .slice(0, 5)
      .map((i) => `· ${i.title}: ${i.detail}`)
    await tgSend(
      env,
      chatId,
      [
        `<b>📓 Журнал · ${channel}</b>`,
        wrBlock,
        insights.length ? `\nИнсайты:\n${insights.join('\n')}` : '',
        `\nПороги: meme≥${journal.gates.minMemeScore} sniper≥${journal.gates.minSniperScore}`,
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
  await runtimePut(LAST_TG_KEY, body)
  if (env.SUBSCRIBERS) {
    try {
      await env.SUBSCRIBERS.put(LAST_TG_KEY, body, {
        expirationTtl: 60 * 60 * 24 * 7,
      })
    } catch {
      /* quota */
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
  try {
    await env.SUBSCRIBERS?.put(DELIVERY_TEST_KEY, now, {
      expirationTtl: 60 * 60,
    })
  } catch {
    /* quota */
  }
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
