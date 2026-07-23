/**
 * Cloudflare Worker — CORS proxy (MEXC + news) + Telegram signal bot.
 *
 * Secrets:
 *   npx wrangler secret put TELEGRAM_BOT_TOKEN
 *   npx wrangler secret put ALERT_SECRET
 *
 * KV:
 *   binding SUBSCRIBERS (see wrangler.toml)
 *
 * Webhook (once after deploy):
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/telegram/webhook"
 */

import { runMarketScan } from './scanner'
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
  monitorWatchedSetups,
  markChatDigestSent,
  countActiveWatches,
  type ConditionalSetupPayload,
} from './watchedSetups'
import {
  getAdaptiveGates,
  getBotJournalPayload,
  recordBotAlert,
  resolveBotJournal,
} from './botJournal'

const MEXC_ORIGIN = 'https://contract.mexc.com'

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

const SUB_KEY = 'telegram:subscribers'
const DEDUP_PREFIX = 'telegram:dedup:'

/** In-memory fallback when KV not bound (dev / first deploy) */
const memorySubs = new Map<number, Subscriber>()
const memoryDedup = new Map<string, number>()

interface Env {
  TELEGRAM_BOT_TOKEN?: string
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

  /** 24/7 cron — every 2 minutes */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runCronScan(env))
  },
}

async function handleTelegram(
  request: Request,
  env: Env,
  path: string,
  ctx?: ExecutionContext
): Promise<Response> {
  // Health works even without token
  if (path === '/telegram/health') {
    const subs = await listSubscribers(env)
    const watches = await countActiveWatches(env)
    return json({
      ok: true,
      bot: 'Enterprisesystem_bot',
      subscribers: subs.length,
      activeWatches: watches,
      hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasSecret: Boolean(env.ALERT_SECRET),
      cron: '*/2 * * * *',
      digestEveryMin: 5,
      refreshSetupMin: 10,
      mode: '24/7',
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
    if (!env.TELEGRAM_BOT_TOKEN) {
      return json({ error: 'TELEGRAM_BOT_TOKEN missing' }, 503)
    }
    const result = await runCronScan(env)
    return json({ ok: true, ...result })
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return json(
      {
        error: 'TELEGRAM_BOT_TOKEN not configured',
        hint: 'npx wrangler secret put TELEGRAM_BOT_TOKEN',
      },
      503
    )
  }

  if (path === '/telegram/webhook' && request.method === 'POST') {
    const update = (await request.json()) as TelegramUpdate
    await processWebhook(env, update)
    return json({ ok: true })
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
    await upsertSubscriber(env, {
      chatId: body.chatId,
      username: body.username,
      subscribedAt: Date.now(),
      sniper: body.sniper !== false,
      meme: body.meme !== false,
    })
    await tgSend(
      env,
      body.chatId,
      '✅ Подписка активна на @Enterprisesystem_bot\n\nСигналы 24/7 (сканер каждые 2 мин) + из Mini App.\n\n/stop — отписаться\n/status — статус\n/scan — ручной прогон сканера'
    )
    return json({ ok: true, chatId: body.chatId })
  }

  if (path === '/telegram/unsubscribe' && request.method === 'POST') {
    const body = (await request.json()) as { chatId: number }
    if (!body.chatId) return json({ error: 'chatId required' }, 400)
    await removeSubscriber(env, body.chatId)
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
    // Ensure subscriber exists so Pages builds without VITE_ALERT_SECRET still work
    await upsertSubscriber(env, {
      chatId: body.chatId,
      subscribedAt: Date.now(),
      sniper: true,
      meme: true,
    })
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
    await upsertSubscriber(env, {
      chatId: body.chatId,
      subscribedAt: Date.now(),
      sniper: true,
      meme: true,
    })
    const auth = await assertAlertAuth(env, request, body.chatId)
    if (!auth.ok) return json({ error: auth.error }, 401)
    const watches = await createWatchesBatch(env, {
      chatId: body.chatId,
      symbol: body.symbol,
      internalSymbol: body.internalSymbol || body.symbol,
      setups: body.setups,
      ttlHours: body.ttlHours,
    })
    // Confirm monitoring is on the server (not only localStorage)
    if (env.TELEGRAM_BOT_TOKEN && watches.length > 0) {
      await tgSend(
        env,
        body.chatId,
        [
          `<b>📡 Мониторинг включён</b>`,
          `Сетапов на сервере: <b>${watches.length}</b>`,
          `Символ: ${body.symbol}`,
          `Отчёт в Telegram каждые <b>5 минут</b> · уровни сетапов обновляются каждые <b>10 минут</b>.`,
          `Cron worker: каждые 2 мин проверяет зоны / READY / INVALIDATED / устаревший откат.`,
        ].join('\n')
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
    const subs = await listSubscribers(env)
    if (subs.some((s) => s.chatId === chatId)) return { ok: true }
    return {
      ok: false,
      error: 'Unauthorized: need ALERT_SECRET or /start + subscribe for this chatId',
    }
  }

  return { ok: false, error: 'Unauthorized: invalid ALERT_SECRET' }
}

/** Dedup + send to subscribers */
async function broadcastAlert(
  env: Env,
  payload: AlertPayload
): Promise<{ ok: boolean; sent: number; failed: number; skipped?: string }> {
  if (payload.dedupeKey) {
    if (env.SUBSCRIBERS) {
      const dedupKey = DEDUP_PREFIX + payload.dedupeKey
      const exists = await env.SUBSCRIBERS.get(dedupKey)
      if (exists) {
        return { ok: true, sent: 0, failed: 0, skipped: 'dedup' }
      }
    } else {
      const prev = memoryDedup.get(payload.dedupeKey)
      if (prev && Date.now() - prev < 3600_000) {
        return { ok: true, sent: 0, failed: 0, skipped: 'dedup' }
      }
    }
  }

  const message = formatAlertMessage(payload)
  let sent = 0
  let failed = 0

  if (payload.chatId) {
    const ok = await tgSend(env, payload.chatId, message)
    if (ok && payload.dedupeKey) {
      if (env.SUBSCRIBERS) {
        await env.SUBSCRIBERS.put(DEDUP_PREFIX + payload.dedupeKey, '1', {
          expirationTtl: 3600,
        })
      } else {
        memoryDedup.set(payload.dedupeKey, Date.now())
      }
    }
    return { ok, sent: ok ? 1 : 0, failed: ok ? 0 : 1 }
  }

  const subs = await listSubscribers(env)
  for (const sub of subs) {
    if (payload.type === 'SNIPER' && !sub.sniper) continue
    if (payload.type === 'MEME' && !sub.meme) continue
    const ok = await tgSend(env, sub.chatId, message)
    if (ok) sent++
    else failed++
  }

  if (sent > 0 && payload.dedupeKey) {
    if (env.SUBSCRIBERS) {
      await env.SUBSCRIBERS.put(DEDUP_PREFIX + payload.dedupeKey, '1', {
        expirationTtl: 3600,
      })
    } else {
      memoryDedup.set(payload.dedupeKey, Date.now())
    }
  }

  return { ok: true, sent, failed }
}

async function maybeHeartbeat(env: Env): Promise<number> {
  const subs = await listSubscribers(env)
  if (subs.length === 0) return 0

  let last = 0
  if (env.SUBSCRIBERS) {
    last = Number((await env.SUBSCRIBERS.get(HEARTBEAT_KEY)) || 0)
  }
  if (Date.now() - last < HEARTBEAT_MS) return 0

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const r = await broadcastAlert(env, {
    type: 'SYSTEM',
    title: 'Scanner online',
    text: `🟢 24/7 heartbeat\n${now}\nПодписчиков: ${subs.length}\nСледующий скан ≤ 2 мин`,
    dedupeKey: `heartbeat:${Math.floor(Date.now() / HEARTBEAT_MS)}`,
  })

  if (env.SUBSCRIBERS) {
    await env.SUBSCRIBERS.put(HEARTBEAT_KEY, String(Date.now()))
  }
  return r.sent
}

async function runCronScan(env: Env): Promise<{
  alerts: number
  sent: number
  skipped: number
  heartbeat: number
  paperComments: number
  watchAlerts?: number
  journalLogged?: number
  journalResolved?: number
}> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { alerts: 0, sent: 0, skipped: 0, heartbeat: 0, paperComments: 0 }
  }

  // Watches FIRST — must not be starved by heavy market scan CPU/time limits
  let watchAlerts = 0
  try {
    const wa = await monitorWatchedSetups(env)
    for (const a of wa) {
      const r = await broadcastAlert(env, {
        type: 'SETUP_WATCH',
        title: a.title,
        text: a.text,
        dedupeKey: a.dedupeKey,
        chatId: a.chatId,
      })
      watchAlerts += r.sent
      if (r.sent > 0 && a.dedupeKey.startsWith('watch_digest:')) {
        await markChatDigestSent(env, a.chatId)
      }
    }
  } catch (err) {
    console.error('[cron] watch monitor failed', err)
  }

  const heartbeat = await maybeHeartbeat(env)
  const gates = await getAdaptiveGates(env)
  const alerts = await runMarketScan(gates)
  let sent = 0
  let skipped = 0
  let paperComments = 0
  let journalLogged = 0

  for (const a of alerts) {
    const r = await broadcastAlert(env, {
      type: a.type,
      title: a.title,
      text: a.text,
      dedupeKey: a.dedupeKey,
    })
    if (r.skipped) {
      skipped++
      continue
    }
    sent += r.sent

    // Journal every non-deduped bot signal (for Lab + adaptive gates)
    if (a.tradePlan) {
      const logged = await recordBotAlert(env, {
        alertType: a.type,
        score: a.score,
        dedupeKey: a.dedupeKey,
        plan: a.tradePlan,
      })
      if (logged) journalLogged++
    }

    // Open paper companion only when signal actually went out to someone
    if (r.sent > 0 && a.tradePlan) {
      const paper = await createPaperTradeFromPlan(env, {
        ...a.tradePlan,
        alertType: a.type,
      })
      if (paper.comment) {
        const cr = await broadcastAlert(env, {
          type: 'SYSTEM',
          title: paper.comment.title,
          text: paper.comment.text,
          dedupeKey: paper.comment.dedupeKey,
        })
        paperComments += cr.sent
      }
    }
  }

  // Narrate open / waiting paper trades
  const comments = await monitorPaperTrades(env)
  for (const c of comments) {
    const cr = await broadcastAlert(env, {
      type: 'SYSTEM',
      title: c.title,
      text: c.text,
      dedupeKey: c.dedupeKey,
    })
    paperComments += cr.sent
  }

  // Resolve bot journal outcomes + refresh adaptive gates
  let journalResolved = 0
  try {
    journalResolved = await resolveBotJournal(env)
  } catch {
    /* best-effort */
  }

  return {
    alerts: alerts.length,
    sent,
    skipped,
    heartbeat,
    paperComments,
    watchAlerts,
    journalLogged,
    journalResolved,
  }
}

// ── Subscribers KV ───────────────────────────────────────────────────────────

async function listSubscribers(env: Env): Promise<Subscriber[]> {
  if (!env.SUBSCRIBERS) return [...memorySubs.values()]
  const raw = await env.SUBSCRIBERS.get(SUB_KEY)
  if (!raw) return [...memorySubs.values()]
  try {
    return JSON.parse(raw) as Subscriber[]
  } catch {
    return [...memorySubs.values()]
  }
}

async function saveSubscribers(env: Env, list: Subscriber[]): Promise<void> {
  memorySubs.clear()
  for (const s of list) memorySubs.set(s.chatId, s)
  if (!env.SUBSCRIBERS) return
  await env.SUBSCRIBERS.put(SUB_KEY, JSON.stringify(list))
}

async function upsertSubscriber(env: Env, sub: Subscriber): Promise<void> {
  const list = await listSubscribers(env)
  const idx = list.findIndex((s) => s.chatId === sub.chatId)
  if (idx >= 0) list[idx] = { ...list[idx], ...sub }
  else list.push(sub)
  await saveSubscribers(env, list)
}

async function removeSubscriber(env: Env, chatId: number): Promise<void> {
  const list = await listSubscribers(env)
  await saveSubscribers(
    env,
    list.filter((s) => s.chatId !== chatId)
  )
}

// ── Telegram Bot API ─────────────────────────────────────────────────────────

const HEARTBEAT_KEY = 'telegram:last_heartbeat'
const HEARTBEAT_MS = 30 * 60_000 // every 30 min

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

async function sendDemoSignal(env: Env, chatId: number): Promise<void> {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  await tgSend(
    env,
    chatId,
    [
      '🟢 <b>LONG BTC/USDT · TEST</b>',
      '',
      'Биржа: MEXC Futures',
      'Контракт: BTC_USDT',
      `Сигнал @ ${now}`,
      '',
      'Цена сигнала: 95000.00 (уже могла уйти)',
      'Тип входа: ЛИМИТ на откат — не маркет-chase',
      'Зона входа: 94200.00 – 95100.00',
      'Лимитка (ориентир): 94600.00',
      'Не входить / не догонять выше 95450.00',
      '',
      'Стоп: 93800.00 (−0.85%)',
      'Цель: 96200.00 (+1.69%)',
      'Победа: 68%',
      'R:R 1:2.0',
      '',
      'Причина: DEMO — проверка доставки. Не торговать.',
      '',
      '⚠️ Мем/импульс: если цена уже вне зоны — пропуск.',
    ].join('\n')
  )
}

async function processWebhook(env: Env, update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.text || !msg.chat?.id) return

  const chatId = msg.chat.id
  const username = msg.from?.username ?? msg.chat.username
  const { cmd } = parseCommand(msg.text)

  if (cmd === 'start') {
    await upsertSubscriber(env, {
      chatId,
      username,
      subscribedAt: Date.now(),
      sniper: true,
      meme: true,
    })
    await tgSend(
      env,
      chatId,
      '🚀 <b>ENTERPRISE SYSTEM</b> (@Enterprisesystem_bot)\n\nПодписка 24/7.\nСигналы + <b>пример сделки</b> с комментариями по рынку (давление, объём, вероятность успеха).\nМемы ≈каждые 2 мин · альты ≈каждые 5 мин.\n\nКоманды:\n/test — тест\n/trades — примеры сделок\n/status — статус\n/scan — сканер\n/ping — связь\n/stop — стоп'
    )
    await sendDemoSignal(env, chatId)
    return
  }

  if (cmd === 'stop') {
    await removeSubscriber(env, chatId)
    await tgSend(env, chatId, '⏸ Подписка отключена. /start — снова включить.')
    return
  }

  if (cmd === 'ping' || cmd === 'test') {
    await upsertSubscriber(env, {
      chatId,
      username,
      subscribedAt: Date.now(),
      sniper: true,
      meme: true,
    })
    await tgSend(
      env,
      chatId,
      `🏓 <b>PONG</b>\nБот онлайн · chatId <code>${chatId}</code>\nРежим 24/7 · cron */2 · paper companion ON`
    )
    await sendDemoSignal(env, chatId)
    return
  }

  if (cmd === 'trades') {
    const list = await listSubscribers(env)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start')
      return
    }
    const papers = await listPaperTrades(env)
    await tgSend(env, chatId, formatTradesStatus(papers))
    return
  }

  if (cmd === 'scan') {
    const list = await listSubscribers(env)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start')
      return
    }
    await tgSend(env, chatId, '⏳ Сканирую рынок…')
    const result = await runCronScan(env)
    if (result.alerts === 0) {
      await tgSend(
        env,
        chatId,
        `✅ Скан завершён: сильных сетапов сейчас нет.\nОтправлено: ${result.sent} · дедуп: ${result.skipped}\nКомментарии по сделкам: ${result.paperComments}\n\nБот жив — жди следующий cron (≤2 мин) или /test`
      )
    } else {
      await tgSend(
        env,
        chatId,
        `✅ Скан: найдено ${result.alerts}, отправлено ${result.sent}, дедуп ${result.skipped}\nСопровождение: ${result.paperComments} сообщений`
      )
    }
    return
  }

  if (cmd === 'status') {
    const list = await listSubscribers(env)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Вы не подписаны. Нажмите /start')
      return
    }
    const papers = await listPaperTrades(env)
    const live = papers.filter(
      (t) => t.status === 'WAITING' || t.status === 'OPEN'
    ).length
    await tgSend(
      env,
      chatId,
      `📊 Статус @Enterprisesystem_bot\nРежим: 24/7 (cron */2)\nPaper companion: ON\nСделок в работе: ${live}\nSniper: ${me.sniper ? 'ON' : 'OFF'}\nMeme: ${me.meme ? 'ON' : 'OFF'}\nПодписчиков: ${list.length}\nchatId: <code>${chatId}</code>\n\n/trades — детали`
    )
    return
  }

  if (cmd === 'sniper_on' || cmd === 'sniper_off') {
    const list = await listSubscribers(env)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start')
      return
    }
    me.sniper = cmd === 'sniper_on'
    await saveSubscribers(env, list)
    await tgSend(env, chatId, `Sniper alerts: ${me.sniper ? 'ON ✅' : 'OFF'}`)
    return
  }

  if (cmd === 'meme_on' || cmd === 'meme_off') {
    const list = await listSubscribers(env)
    const me = list.find((s) => s.chatId === chatId)
    if (!me) {
      await tgSend(env, chatId, 'Сначала /start')
      return
    }
    me.meme = cmd === 'meme_on'
    await saveSubscribers(env, list)
    await tgSend(env, chatId, `Meme alerts: ${me.meme ? 'ON ✅' : 'OFF'}`)
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

async function tgSend(
  env: Env,
  chatId: number,
  text: string
): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) return false

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    return res.ok
  } catch {
    return false
  }
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
