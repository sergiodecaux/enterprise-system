/**
 * Paper trades for Telegram companion commentary.
 * Bot "enters" on limit zone touch and narrates BE / TP / SL / trail / pulse.
 */

const PAPER_KEY = 'telegram:paper_trades'
const MAX_ACTIVE = 5
const WAITING_TTL_MS = 45 * 60_000
const OPEN_TTL_MS = 6 * 60 * 60_000
const PULSE_MS = 20 * 60_000
const MEXC = 'https://contract.mexc.com'

export type PaperSide = 'LONG' | 'SHORT'
export type PaperStatus = 'WAITING' | 'OPEN' | 'CLOSED'
export type AlertKind = 'SNIPER' | 'MEME'

export interface TradePlan {
  side: PaperSide
  symbol: string
  setup: string
  signalPrice: number
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
  alertType: AlertKind
}

export interface PaperTrade {
  id: string
  symbol: string
  side: PaperSide
  setup: string
  alertType: AlertKind
  signalPrice: number
  zoneLow: number
  zoneHigh: number
  entryIdeal: number
  invalidate: number
  sl: number
  tp: number
  status: PaperStatus
  fillPrice: number | null
  peak: number | null
  trailingStop: number | null
  createdAt: number
  openedAt: number | null
  expiresAt: number
  closedAt: number | null
  lastPulseAt: number | null
  closeReason: string | null
  beSent: boolean
  tpSent: boolean
  trailMovedSent: boolean
  waitingAnnounced: boolean
}

export interface PaperComment {
  title: string
  text: string
  dedupeKey: string
  alertType: AlertKind | 'SYSTEM'
}

interface PaperEnv {
  SUBSCRIBERS?: KVNamespace
}

interface TickerSnap {
  last: number
  high: number
  low: number
}

const memoryPapers: PaperTrade[] = []

function fmt(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(6)
  return p.toFixed(8)
}

function pnlPct(side: PaperSide, entry: number, price: number): number {
  if (!(entry > 0)) return 0
  return side === 'LONG'
    ? ((price - entry) / entry) * 100
    : ((entry - price) / entry) * 100
}

function nameOf(symbol: string): string {
  return symbol.replace('_USDT', '/USDT')
}

function riskUnit(t: PaperTrade): number {
  const entry = t.fillPrice ?? t.entryIdeal
  return Math.abs(entry - t.sl)
}

async function mexcJson<T>(path: string): Promise<T | null> {
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

async function fetchTickerSnap(symbol: string): Promise<TickerSnap | null> {
  const json = await mexcJson<{
    data:
      | {
          lastPrice?: number
          high24Price?: number
          lower24Price?: number
          bid1?: number
          ask1?: number
        }
      | Array<{
          lastPrice?: number
          high24Price?: number
          lower24Price?: number
        }>
  }>(`/api/v1/contract/ticker?symbol=${symbol}`)

  const row = Array.isArray(json?.data) ? json?.data[0] : json?.data
  if (!row) return null
  const last = Number(row.lastPrice)
  if (!(last > 0)) return null

  // Prefer 1m candle range for intrabar touch; fallback to last±tiny
  const k = await mexcJson<{
    data: { high: number[]; low: number[]; close: number[] }
  }>(`/api/v1/contract/kline/${symbol}?interval=Min1&limit=3`)

  let high = last
  let low = last
  const hs = k?.data?.high
  const ls = k?.data?.low
  if (hs?.length && ls?.length) {
    high = Math.max(...hs.map(Number), last)
    low = Math.min(...ls.map(Number), last)
  }

  return { last, high, low }
}

export async function listPaperTrades(env: PaperEnv): Promise<PaperTrade[]> {
  if (!env.SUBSCRIBERS) return [...memoryPapers]
  const raw = await env.SUBSCRIBERS.get(PAPER_KEY)
  if (!raw) return [...memoryPapers]
  try {
    return JSON.parse(raw) as PaperTrade[]
  } catch {
    return [...memoryPapers]
  }
}

async function savePaperTrades(
  env: PaperEnv,
  list: PaperTrade[]
): Promise<void> {
  memoryPapers.length = 0
  memoryPapers.push(...list)
  if (!env.SUBSCRIBERS) return
  await env.SUBSCRIBERS.put(PAPER_KEY, JSON.stringify(list))
}

function activeCount(list: PaperTrade[]): number {
  return list.filter((t) => t.status === 'WAITING' || t.status === 'OPEN').length
}

export async function createPaperTradeFromPlan(
  env: PaperEnv,
  plan: TradePlan
): Promise<{ created: boolean; comment: PaperComment | null }> {
  const list = await listPaperTrades(env)
  const now = Date.now()

  // Drop very old closed from storage (keep last 30)
  const pruned = list
    .filter((t) => {
      if (t.status !== 'CLOSED') return true
      return now - (t.closedAt ?? t.createdAt) < 24 * 60 * 60_000
    })
    .slice(-40)

  if (activeCount(pruned) >= MAX_ACTIVE) {
    return { created: false, comment: null }
  }

  const dup = pruned.find(
    (t) =>
      (t.status === 'WAITING' || t.status === 'OPEN') &&
      t.symbol === plan.symbol &&
      t.side === plan.side
  )
  if (dup) return { created: false, comment: null }

  const trade: PaperTrade = {
    id: `${plan.symbol}:${plan.side}:${now}`,
    symbol: plan.symbol,
    side: plan.side,
    setup: plan.setup,
    alertType: plan.alertType,
    signalPrice: plan.signalPrice,
    zoneLow: plan.zoneLow,
    zoneHigh: plan.zoneHigh,
    entryIdeal: plan.entryIdeal,
    invalidate: plan.invalidate,
    sl: plan.sl,
    tp: plan.tp,
    status: 'WAITING',
    fillPrice: null,
    peak: null,
    trailingStop: null,
    createdAt: now,
    openedAt: null,
    expiresAt: now + WAITING_TTL_MS,
    closedAt: null,
    lastPulseAt: null,
    closeReason: null,
    beSent: false,
    tpSent: false,
    trailMovedSent: false,
    waitingAnnounced: true,
  }

  pruned.push(trade)
  await savePaperTrades(env, pruned)

  const icon = plan.side === 'LONG' ? '🟢' : '🔴'
  const comment: PaperComment = {
    alertType: 'SYSTEM',
    title: `${icon} Беру в работу ${nameOf(plan.symbol)}`,
    text: [
      `Я в сделку ещё не вошёл — жду лимитку.`,
      `Сторона: ${plan.side} · ${plan.setup}`,
      `Зона: ${fmt(plan.zoneLow)} – ${fmt(plan.zoneHigh)}`,
      `Ориентир: ${fmt(plan.entryIdeal)}`,
      plan.side === 'LONG'
        ? `Если улетит выше ${fmt(plan.invalidate)} без отката — пропускаю.`
        : `Если улетит ниже ${fmt(plan.invalidate)} без отката — пропускаю.`,
      `Стоп план: ${fmt(plan.sl)} · Цель: ${fmt(plan.tp)}`,
    ].join('\n'),
    dedupeKey: `paper:wait:${trade.id}`,
  }

  return { created: true, comment }
}

function touchesZone(t: PaperTrade, snap: TickerSnap): boolean {
  // Any overlap between candle range and entry zone
  return snap.low <= t.zoneHigh && snap.high >= t.zoneLow
}

function clampFill(t: PaperTrade, price: number): number {
  return Math.min(t.zoneHigh, Math.max(t.zoneLow, price))
}

function invalidatedWithoutFill(t: PaperTrade, snap: TickerSnap): boolean {
  if (t.side === 'LONG') return snap.high >= t.invalidate && !touchesZone(t, snap)
  return snap.low <= t.invalidate && !touchesZone(t, snap)
}

function hitTp(t: PaperTrade, snap: TickerSnap, fill: number): boolean {
  if (t.side === 'LONG') return snap.high >= t.tp
  return snap.low <= t.tp
}

function hitSl(t: PaperTrade, snap: TickerSnap): boolean {
  if (t.side === 'LONG') return snap.low <= t.sl
  return snap.high >= t.sl
}

function updateTrail(t: PaperTrade, price: number): {
  peak: number
  trailingStop: number
  moved: boolean
} {
  const trailPct = 0.02
  let peak = t.peak ?? t.fillPrice ?? t.entryIdeal
  if (t.side === 'LONG' && price > peak) peak = price
  if (t.side === 'SHORT' && price < peak) peak = price

  const trailingStop =
    t.side === 'LONG' ? peak * (1 - trailPct) : peak * (1 + trailPct)

  const prev = t.trailingStop
  const moved =
    prev != null &&
    t.fillPrice != null &&
    Math.abs(trailingStop - prev) / t.fillPrice > 0.005 &&
    ((t.side === 'LONG' && trailingStop > prev) ||
      (t.side === 'SHORT' && trailingStop < prev))

  return { peak, trailingStop, moved }
}

function trailHit(t: PaperTrade, snap: TickerSnap): boolean {
  if (t.trailingStop == null || t.fillPrice == null || t.peak == null) return false
  if (t.side === 'LONG') {
    return (
      snap.low <= t.trailingStop && t.peak > t.fillPrice * 1.03
    )
  }
  return snap.high >= t.trailingStop && t.peak < t.fillPrice * 0.97
}

/**
 * Monitor all paper trades; return companion comments to broadcast.
 */
export async function monitorPaperTrades(
  env: PaperEnv
): Promise<PaperComment[]> {
  const list = await listPaperTrades(env)
  const now = Date.now()
  const comments: PaperComment[] = []
  let dirty = false

  for (const t of list) {
    if (t.status === 'CLOSED') continue

    // Expire
    if (now > t.expiresAt) {
      const wasWaiting = t.status === 'WAITING' || !t.fillPrice
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = wasWaiting ? 'timeout_waiting' : 'timeout_open'
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: wasWaiting
          ? `⏱ Не дождался входа ${nameOf(t.symbol)}`
          : `⏱ Закрываю по времени ${nameOf(t.symbol)}`,
        text: wasWaiting
          ? `Зона ${fmt(t.zoneLow)}–${fmt(t.zoneHigh)} так и не дала откат. Переключаюсь на следующий сетап.`
          : `Держал слишком долго. Выхожу из бумажной позиции ${t.side} ${nameOf(t.symbol)}.`,
        dedupeKey: `paper:expire:${t.id}`,
      })
      continue
    }

    const snap = await fetchTickerSnap(t.symbol)
    if (!snap) continue

    if (t.status === 'WAITING') {
      if (invalidatedWithoutFill(t, snap)) {
        t.status = 'CLOSED'
        t.closedAt = now
        t.closeReason = 'invalidate'
        dirty = true
        comments.push({
          alertType: 'SYSTEM',
          title: `⏭ Пропуск ${nameOf(t.symbol)}`,
          text: [
            `Цена ушла без отката в мою зону — не догоняю.`,
            `Инвалидация: ${fmt(t.invalidate)} · сейчас ${fmt(snap.last)}`,
            `Жду следующий чистый сетап.`,
          ].join('\n'),
          dedupeKey: `paper:skip:${t.id}`,
        })
        continue
      }

      if (touchesZone(t, snap)) {
        const fill = clampFill(t, snap.last)
        t.status = 'OPEN'
        t.fillPrice = fill
        t.openedAt = now
        t.expiresAt = now + OPEN_TTL_MS
        t.peak = fill
        t.trailingStop =
          t.side === 'LONG' ? fill * 0.98 : fill * 1.02
        dirty = true
        comments.push({
          alertType: 'SYSTEM',
          title: `✅ Вошёл ${t.side} ${nameOf(t.symbol)}`,
          text: [
            `Лимитка исполнилась. Я в позиции.`,
            `Вход: ${fmt(fill)}`,
            `Стоп: ${fmt(t.sl)} · Цель: ${fmt(t.tp)}`,
            `Дальше веду как свою сделку — отпишусь на BE / TP / SL.`,
          ].join('\n'),
          dedupeKey: `paper:fill:${t.id}`,
        })
      }
      continue
    }

    // OPEN
    const fill = t.fillPrice!
    const trail = updateTrail(t, snap.last)
    if (trail.peak !== t.peak || trail.trailingStop !== t.trailingStop) {
      t.peak = trail.peak
      t.trailingStop = trail.trailingStop
      dirty = true
    }

    if (trail.moved && !t.trailMovedSent) {
      t.trailMovedSent = true
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: `📈 Трейл двигаю ${nameOf(t.symbol)}`,
        text: [
          `Пик/дно обновилось — подтягиваю тень стопа.`,
          `Trail ≈ ${fmt(trail.trailingStop)} · цена ${fmt(snap.last)}`,
          `uPnL: ${pnlPct(t.side, fill, snap.last).toFixed(2)}%`,
        ].join('\n'),
        dedupeKey: `paper:trail:${t.id}:${Math.floor(now / 600_000)}`,
      })
    }

    const r = riskUnit(t)
    const unreal = pnlPct(t.side, fill, snap.last)
    const favorR = r > 0 ? (Math.abs(snap.last - fill) / r) * (unreal >= 0 ? 1 : -1) : 0

    // Move SL to BE around +0.6R
    if (!t.beSent && favorR >= 0.6) {
      t.beSent = true
      t.sl = fill
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: `🛡 Безубыток ${nameOf(t.symbol)}`,
        text: [
          `Движение в мою сторону — стоп перевожу в BE.`,
          `Новый стоп: ${fmt(fill)} · цена ${fmt(snap.last)}`,
          `uPnL: ${unreal.toFixed(2)}% · цель всё ещё ${fmt(t.tp)}`,
        ].join('\n'),
        dedupeKey: `paper:be:${t.id}`,
      })
    }

    if (hitTp(t, snap, fill) && !t.tpSent) {
      t.tpSent = true
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'tp'
      dirty = true
      const exit = t.side === 'LONG' ? Math.max(snap.last, t.tp) : Math.min(snap.last, t.tp)
      comments.push({
        alertType: 'SYSTEM',
        title: `🎯 Цель взята ${nameOf(t.symbol)}`,
        text: [
          `Закрываю бумажную позицию по цели.`,
          `Вход ${fmt(fill)} → выход ~${fmt(exit)}`,
          `Результат: ${pnlPct(t.side, fill, exit).toFixed(2)}% · ${t.setup}`,
          `Хороший сетап. Ищу следующий.`,
        ].join('\n'),
        dedupeKey: `paper:tp:${t.id}`,
      })
      continue
    }

    if (trailHit(t, snap)) {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'trail'
      dirty = true
      const exit = t.trailingStop ?? snap.last
      comments.push({
        alertType: 'SYSTEM',
        title: `🚨 Трейл сработал ${nameOf(t.symbol)}`,
        text: [
          `Тень стопа пробита — фиксирую.`,
          `Вход ${fmt(fill)} → выход ~${fmt(exit)}`,
          `Результат: ${pnlPct(t.side, fill, exit).toFixed(2)}%`,
        ].join('\n'),
        dedupeKey: `paper:trailhit:${t.id}`,
      })
      continue
    }

    if (hitSl(t, snap)) {
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'sl'
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: `🛑 Стоп ${nameOf(t.symbol)}`,
        text: [
          `Стоп поймали — выхожу без догона.`,
          `Вход ${fmt(fill)} · стоп ${fmt(t.sl)} · цена ${fmt(snap.last)}`,
          `Результат: ${pnlPct(t.side, fill, t.sl).toFixed(2)}%`,
          `Риск отработан. Жду следующий сетап.`,
        ].join('\n'),
        dedupeKey: `paper:sl:${t.id}`,
      })
      continue
    }

    // Pulse every ~20 min
    const lastPulse = t.lastPulseAt ?? t.openedAt ?? t.createdAt
    if (now - lastPulse >= PULSE_MS) {
      t.lastPulseAt = now
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: `📡 Держу ${nameOf(t.symbol)}`,
        text: [
          `${t.side} · ${t.setup}`,
          `Вход ${fmt(fill)} · сейчас ${fmt(snap.last)}`,
          `uPnL: ${unreal >= 0 ? '+' : ''}${unreal.toFixed(2)}%`,
          `Стоп ${fmt(t.sl)} · Цель ${fmt(t.tp)}`,
          `Пока без событий — сижу спокойно.`,
        ].join('\n'),
        dedupeKey: `paper:pulse:${t.id}:${Math.floor(now / PULSE_MS)}`,
      })
    }
  }

  if (dirty) await savePaperTrades(env, list)
  return comments
}

export function formatTradesStatus(list: PaperTrade[]): string {
  const live = list.filter((t) => t.status === 'WAITING' || t.status === 'OPEN')
  if (!live.length) {
    return 'Сейчас бумажных сделок нет.\nЖду следующий сигнал сканера.'
  }
  const lines = ['Мои бумажные сделки:', '']
  for (const t of live) {
    const st = t.status === 'WAITING' ? '⏳ жду вход' : '✅ в позиции'
    const fill = t.fillPrice != null ? ` @ ${fmt(t.fillPrice)}` : ''
    lines.push(
      `${st} · ${t.side} ${nameOf(t.symbol)} · ${t.setup}${fill}`,
      `  зона ${fmt(t.zoneLow)}–${fmt(t.zoneHigh)} · SL ${fmt(t.sl)} · TP ${fmt(t.tp)}`
    )
  }
  return lines.join('\n')
}
