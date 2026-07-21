/**
 * Example (paper) trades + live market companion commentary.
 * Memes: commentary ≥ every 2 min. Alts: ≥ every 5 min.
 * Comments cover pressure / structure / updated win probability — not fluff.
 */

const PAPER_KEY = 'telegram:paper_trades'
const MAX_ACTIVE = 5
const WAITING_TTL_MS = 45 * 60_000
const OPEN_TTL_MS = 6 * 60 * 60_000
/** Meme setups — comment at least every cron cycle (~2 min) */
const PULSE_MEME_MS = 2 * 60_000
/** Regular alts / sniper — every ~5 min */
const PULSE_ALT_MS = 5 * 60_000
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
  /** Last published success probability 0–100 */
  lastWinPct: number | null
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
  bid1: number
  ask1: number
  fundingRate: number | null
  amount24: number
}

interface MarketBrief {
  buyShare: number
  sellShare: number
  pressure: 'BUYERS' | 'SELLERS' | 'MIXED'
  pressureLabel: string
  candleBias: 'UP' | 'DOWN' | 'CHOP'
  volMult: number
  move1mPct: number
  spreadBps: number
  fundingPct: number | null
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

function pulseMs(t: PaperTrade): number {
  return t.alertType === 'MEME' ? PULSE_MEME_MS : PULSE_ALT_MS
}

function isMemeTrade(t: PaperTrade): boolean {
  return t.alertType === 'MEME'
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
          bid1?: number
          ask1?: number
          fundingRate?: number
          amount24?: number
          volume24?: number
        }
      | Array<{
          lastPrice?: number
          bid1?: number
          ask1?: number
          fundingRate?: number
          amount24?: number
        }>
  }>(`/api/v1/contract/ticker?symbol=${symbol}`)

  const row = Array.isArray(json?.data) ? json?.data[0] : json?.data
  if (!row) return null
  const last = Number(row.lastPrice)
  if (!(last > 0)) return null

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

  return {
    last,
    high,
    low,
    bid1: Number(row.bid1 ?? last),
    ask1: Number(row.ask1 ?? last),
    fundingRate:
      row.fundingRate != null && !Number.isNaN(Number(row.fundingRate))
        ? Number(row.fundingRate)
        : null,
    amount24: Number(row.amount24 ?? row.volume24 ?? 0),
  }
}

async function fetchMarketBrief(
  symbol: string,
  snap: TickerSnap
): Promise<MarketBrief> {
  const [klines, deals] = await Promise.all([
    mexcJson<{
      data: {
        open: number[]
        high: number[]
        low: number[]
        close: number[]
        vol: number[]
      }
    }>(`/api/v1/contract/kline/${symbol}?interval=Min1&limit=20`),
    mexcJson<{
      data: Array<{ p: number; v: number; T: number; O?: number }>
    }>(`/api/v1/contract/deals/${symbol}?limit=60`),
  ])

  const o = klines?.data?.open?.map(Number) ?? []
  const c = klines?.data?.close?.map(Number) ?? []
  const v = klines?.data?.vol?.map(Number) ?? []

  let up = 0
  let down = 0
  for (let i = Math.max(0, c.length - 8); i < c.length; i++) {
    if (c[i] >= o[i]) up++
    else down++
  }
  const candleBias: MarketBrief['candleBias'] =
    up >= down + 2 ? 'UP' : down >= up + 2 ? 'DOWN' : 'CHOP'

  const recent = v.slice(-5)
  const base = v.slice(-15, -5)
  const avgBase =
    base.length > 0 ? base.reduce((s, x) => s + x, 0) / base.length : 0
  const avgRecent =
    recent.length > 0 ? recent.reduce((s, x) => s + x, 0) / recent.length : 0
  const volMult = avgBase > 0 ? avgRecent / avgBase : 1

  const lastO = o[o.length - 1] ?? snap.last
  const lastC = c[c.length - 1] ?? snap.last
  const move1mPct = lastO > 0 ? ((lastC - lastO) / lastO) * 100 : 0

  // MEXC deals: T=1 taker buy, T=2 taker sell (common); O sometimes side
  let buyVol = 0
  let sellVol = 0
  const rows = deals?.data ?? []
  for (const d of rows) {
    const vol = Number(d.v ?? 0) * Number(d.p ?? 0)
    const side = d.T ?? d.O
    if (side === 1 || side === 2) {
      // T: 1 buy / 2 sell on many MEXC docs; if inverted still relative
      if (side === 1) buyVol += vol
      else sellVol += vol
    } else {
      // fallback: compare to mid
      if (Number(d.p) >= snap.last) buyVol += vol
      else sellVol += vol
    }
  }
  const tot = buyVol + sellVol
  const buyShare = tot > 0 ? buyVol / tot : 0.5
  const sellShare = 1 - buyShare

  let pressure: MarketBrief['pressure'] = 'MIXED'
  if (buyShare >= 0.58) pressure = 'BUYERS'
  else if (sellShare >= 0.58) pressure = 'SELLERS'

  const pressureLabel =
    pressure === 'BUYERS'
      ? `Покупатели давят (${(buyShare * 100).toFixed(0)}% taker buy)`
      : pressure === 'SELLERS'
        ? `Продавцы давят (${(sellShare * 100).toFixed(0)}% taker sell)`
        : `Баланс сил (~${(buyShare * 100).toFixed(0)}/${(sellShare * 100).toFixed(0)} buy/sell)`

  const mid = (snap.bid1 + snap.ask1) / 2
  const spreadBps = mid > 0 ? ((snap.ask1 - snap.bid1) / mid) * 10_000 : 0

  return {
    buyShare,
    sellShare,
    pressure,
    pressureLabel,
    candleBias,
    volMult,
    move1mPct,
    spreadBps,
    fundingPct: snap.fundingRate != null ? snap.fundingRate * 100 : null,
  }
}

/**
 * Live success probability for the example trade (calibrated band, not historical WR).
 */
function computeWinPct(
  t: PaperTrade,
  price: number,
  brief: MarketBrief
): { winPct: number; factors: string[] } {
  let score = 58
  const factors: string[] = []
  const entry = t.fillPrice ?? t.entryIdeal
  const risk = Math.abs(entry - t.sl)
  const reward = Math.abs(t.tp - entry)

  // Path progress: how much of risk/reward path used
  if (risk > 0) {
    const towardTp =
      t.side === 'LONG'
        ? (price - entry) / reward
        : (entry - price) / reward
    const towardSl =
      t.side === 'LONG'
        ? (entry - price) / risk
        : (price - entry) / risk

    if (towardTp > 0.15) {
      const bump = Math.min(18, towardTp * 22)
      score += bump
      factors.push(`к цели ${(towardTp * 100).toFixed(0)}% пути`)
    }
    if (towardSl > 0.2) {
      const pen = Math.min(22, towardSl * 28)
      score -= pen
      factors.push(`к стопу ${(towardSl * 100).toFixed(0)}% риска`)
    }
  }

  // Order-flow alignment
  const flowWithUs =
    (t.side === 'LONG' && brief.pressure === 'BUYERS') ||
    (t.side === 'SHORT' && brief.pressure === 'SELLERS')
  const flowAgainst =
    (t.side === 'LONG' && brief.pressure === 'SELLERS') ||
    (t.side === 'SHORT' && brief.pressure === 'BUYERS')

  if (flowWithUs) {
    score += 8
    factors.push('поток с нами')
  } else if (flowAgainst) {
    score -= 10
    factors.push('поток против')
  } else {
    factors.push('поток нейтрален')
  }

  // Candle structure
  if (
    (t.side === 'LONG' && brief.candleBias === 'UP') ||
    (t.side === 'SHORT' && brief.candleBias === 'DOWN')
  ) {
    score += 5
    factors.push('структура 1м за нас')
  } else if (
    (t.side === 'LONG' && brief.candleBias === 'DOWN') ||
    (t.side === 'SHORT' && brief.candleBias === 'UP')
  ) {
    score -= 6
    factors.push('структура 1м против')
  }

  // Volume expansion
  if (brief.volMult >= 1.8 && flowWithUs) {
    score += 5
    factors.push(`объём ×${brief.volMult.toFixed(1)}`)
  } else if (brief.volMult >= 2.2 && flowAgainst) {
    score -= 7
    factors.push(`объём против ×${brief.volMult.toFixed(1)}`)
  }

  // Funding
  if (brief.fundingPct != null) {
    if (t.side === 'LONG' && brief.fundingPct <= -0.02) {
      score += 4
      factors.push('funding в шортах — топливо лонга')
    } else if (t.side === 'SHORT' && brief.fundingPct >= 0.03) {
      score += 3
      factors.push('funding перегрет лонгами')
    } else if (t.side === 'LONG' && brief.fundingPct >= 0.05) {
      score -= 4
      factors.push('funding против лонга')
    }
  }

  // Spread stress (memes)
  if (brief.spreadBps > 25) {
    score -= 3
    factors.push(`широкий спред ${brief.spreadBps.toFixed(0)}bps`)
  }

  // WAITING: slightly lower until filled
  if (t.status === 'WAITING') {
    score -= 4
    factors.push('ещё не в сделке — только зона')
  }

  if (t.beSent) {
    score += 4
    factors.push('стоп уже в BE')
  }

  const winPct = Math.round(Math.min(88, Math.max(22, score)))
  return { winPct, factors: factors.slice(0, 5) }
}

function buildCommentary(opts: {
  t: PaperTrade
  price: number
  brief: MarketBrief
  winPct: number
  prevWin: number | null
  factors: string[]
  phase: 'WAITING' | 'OPEN'
}): PaperComment {
  const { t, price, brief, winPct, prevWin, factors, phase } = opts
  const entry = t.fillPrice ?? t.entryIdeal
  const unreal =
    phase === 'OPEN' && t.fillPrice != null
      ? pnlPct(t.side, t.fillPrice, price)
      : null
  const delta =
    prevWin != null ? winPct - prevWin : 0
  const deltaStr =
    prevWin == null
      ? ''
      : delta > 0
        ? `↑ +${delta}`
        : delta < 0
          ? `↓ ${delta}`
          : '→ 0'

  const distTp =
    t.side === 'LONG'
      ? ((t.tp - price) / price) * 100
      : ((price - t.tp) / price) * 100
  const distSl =
    t.side === 'LONG'
      ? ((price - t.sl) / price) * 100
      : ((t.sl - price) / price) * 100

  const actionHint =
    winPct >= 70
      ? 'План держу. Вероятность в мою пользу.'
      : winPct >= 50
        ? 'Пока ок, но без догона — только по плану.'
        : winPct >= 35
          ? 'Осторожно: преимущество тает. Ближе к стопу — без усреднения.'
          : 'Сценарий слабый. Если выбьет стоп — ок, риск уже заложен.'

  const title =
    phase === 'WAITING'
      ? `👁 Пример ${nameOf(t.symbol)} · жду зону`
      : `📡 Пример ${t.side} ${nameOf(t.symbol)}`

  const lines = [
    `Учебная (бумажная) сделка · ${t.setup} · ${isMemeTrade(t) ? 'MEME 2м' : 'ALT 5м'}`,
    phase === 'WAITING'
      ? `Статус: жду лимитку ${fmt(t.zoneLow)}–${fmt(t.zoneHigh)}`
      : `Вход ${fmt(entry)} · сейчас ${fmt(price)} · uPnL ${unreal != null && unreal >= 0 ? '+' : ''}${unreal?.toFixed(2) ?? '—'}%`,
    '',
    `🎯 Вероятность успеха: ${winPct}%${deltaStr ? ` (${deltaStr} п.п.)` : ''}`,
    `Факторы: ${factors.join('; ') || '—'}`,
    '',
    brief.pressureLabel,
    `1м: ${brief.move1mPct >= 0 ? '+' : ''}${brief.move1mPct.toFixed(2)}% · свечи ${brief.candleBias} · vol ×${brief.volMult.toFixed(1)}`,
    brief.fundingPct != null
      ? `Funding: ${brief.fundingPct.toFixed(3)}% · спред ~${brief.spreadBps.toFixed(0)} bps`
      : `Спред ~${brief.spreadBps.toFixed(0)} bps`,
    `До цели ~${distTp.toFixed(2)}% · до стопа ~${distSl.toFixed(2)}%`,
    '',
    actionHint,
  ]

  return {
    alertType: 'SYSTEM',
    title,
    text: lines.join('\n'),
    dedupeKey: `paper:pulse:${t.id}:${Math.floor(Date.now() / pulseMs(t))}`,
  }
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
    lastWinPct: null,
  }

  pruned.push(trade)
  await savePaperTrades(env, pruned)

  const icon = plan.side === 'LONG' ? '🟢' : '🔴'
  const cadence = plan.alertType === 'MEME' ? 'каждые ~2 мин' : 'каждые ~5 мин'
  const comment: PaperComment = {
    alertType: 'SYSTEM',
    title: `${icon} Пример: беру ${nameOf(plan.symbol)} в работу`,
    text: [
      `Это учебная (бумажная) сделка — как если бы я вошёл по плану.`,
      `Сторона: ${plan.side} · ${plan.setup}`,
      `Зона лимитки: ${fmt(plan.zoneLow)} – ${fmt(plan.zoneHigh)}`,
      `Ориентир: ${fmt(plan.entryIdeal)} · SL ${fmt(plan.sl)} · TP ${fmt(plan.tp)}`,
      plan.side === 'LONG'
        ? `Инвалидация выше ${fmt(plan.invalidate)} — не догоняю.`
        : `Инвалидация ниже ${fmt(plan.invalidate)} — не догоняю.`,
      `Дальше пишу, что происходит с монетой (${cadence}): давление, объём, вероятность успеха.`,
    ].join('\n'),
    dedupeKey: `paper:wait:${trade.id}`,
  }

  return { created: true, comment }
}

function touchesZone(t: PaperTrade, snap: TickerSnap): boolean {
  return snap.low <= t.zoneHigh && snap.high >= t.zoneLow
}

function clampFill(t: PaperTrade, price: number): number {
  return Math.min(t.zoneHigh, Math.max(t.zoneLow, price))
}

function invalidatedWithoutFill(t: PaperTrade, snap: TickerSnap): boolean {
  if (t.side === 'LONG') return snap.high >= t.invalidate && !touchesZone(t, snap)
  return snap.low <= t.invalidate && !touchesZone(t, snap)
}

function hitTp(t: PaperTrade, snap: TickerSnap): boolean {
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
    return snap.low <= t.trailingStop && t.peak > t.fillPrice * 1.03
  }
  return snap.high >= t.trailingStop && t.peak < t.fillPrice * 0.97
}

/**
 * Monitor example trades; emit market commentary + milestones.
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

    if (now > t.expiresAt) {
      const wasWaiting = t.status === 'WAITING' || !t.fillPrice
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = wasWaiting ? 'timeout_waiting' : 'timeout_open'
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: wasWaiting
          ? `⏱ Пример закрыт: нет входа ${nameOf(t.symbol)}`
          : `⏱ Пример закрыт по времени ${nameOf(t.symbol)}`,
        text: wasWaiting
          ? `Зона не дали — учебная сделка отменена. Жду следующий сетап.`
          : `Держал пример слишком долго — закрываю бумажную позицию.`,
        dedupeKey: `paper:expire:${t.id}`,
      })
      continue
    }

    const snap = await fetchTickerSnap(t.symbol)
    if (!snap) continue

    const brief = await fetchMarketBrief(t.symbol, snap)
    const { winPct, factors } = computeWinPct(t, snap.last, brief)

    if (t.status === 'WAITING') {
      if (invalidatedWithoutFill(t, snap)) {
        t.status = 'CLOSED'
        t.closedAt = now
        t.closeReason = 'invalidate'
        dirty = true
        comments.push({
          alertType: 'SYSTEM',
          title: `⏭ Пример: пропуск ${nameOf(t.symbol)}`,
          text: [
            `Цена ушла без отката в зону — учебный вход отменяю.`,
            brief.pressureLabel,
            `Вероятность на момент отмены: ${winPct}%`,
            `Сейчас ${fmt(snap.last)} · инвалидация ${fmt(t.invalidate)}`,
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
        t.trailingStop = t.side === 'LONG' ? fill * 0.98 : fill * 1.02
        t.lastWinPct = winPct
        t.lastPulseAt = now
        dirty = true
        comments.push({
          alertType: 'SYSTEM',
          title: `✅ Пример: вошёл ${t.side} ${nameOf(t.symbol)}`,
          text: [
            `Лимитка в зоне исполнилась (бумажно).`,
            `Вход: ${fmt(fill)} · SL ${fmt(t.sl)} · TP ${fmt(t.tp)}`,
            `Стартовая вероятность успеха: ${winPct}%`,
            brief.pressureLabel,
            `Дальше веду комментарии по рынку ${isMemeTrade(t) ? '≈каждые 2 мин' : '≈каждые 5 мин'}.`,
          ].join('\n'),
          dedupeKey: `paper:fill:${t.id}`,
        })
        continue
      }

      // Waiting commentary on cadence
      const lastPulse = t.lastPulseAt ?? t.createdAt
      if (now - lastPulse >= pulseMs(t)) {
        const prevWin = t.lastWinPct
        t.lastPulseAt = now
        t.lastWinPct = winPct
        dirty = true
        comments.push(
          buildCommentary({
            t,
            price: snap.last,
            brief,
            winPct,
            prevWin,
            factors,
            phase: 'WAITING',
          })
        )
      }
      continue
    }

    // OPEN milestones + commentary
    const fill = t.fillPrice!
    const trail = updateTrail(t, snap.last)
    if (trail.peak !== t.peak || trail.trailingStop !== t.trailingStop) {
      t.peak = trail.peak
      t.trailingStop = trail.trailingStop
      dirty = true
    }

    const prevWin = t.lastWinPct
    const r = riskUnit(t)
    const unreal = pnlPct(t.side, fill, snap.last)
    const favorR =
      r > 0 ? (Math.abs(snap.last - fill) / r) * (unreal >= 0 ? 1 : -1) : 0

    if (trail.moved && !t.trailMovedSent) {
      t.trailMovedSent = true
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: `📈 Пример: трейл ${nameOf(t.symbol)}`,
        text: [
          `Пик обновился — подтягиваю тень стопа ≈ ${fmt(trail.trailingStop)}.`,
          `uPnL ${unreal.toFixed(2)}% · вероятность ${winPct}%`,
          brief.pressureLabel,
        ].join('\n'),
        dedupeKey: `paper:trail:${t.id}:${Math.floor(now / 300_000)}`,
      })
    }

    if (!t.beSent && favorR >= 0.6) {
      t.beSent = true
      t.sl = fill
      dirty = true
      comments.push({
        alertType: 'SYSTEM',
        title: `🛡 Пример: BE ${nameOf(t.symbol)}`,
        text: [
          `Есть +0.6R — в примере стоп перевожу в безубыток (${fmt(fill)}).`,
          `Вероятность ${winPct}% · ${brief.pressureLabel}`,
          `Цель всё ещё ${fmt(t.tp)}.`,
        ].join('\n'),
        dedupeKey: `paper:be:${t.id}`,
      })
    }

    if (hitTp(t, snap) && !t.tpSent) {
      t.tpSent = true
      t.status = 'CLOSED'
      t.closedAt = now
      t.closeReason = 'tp'
      dirty = true
      const exit =
        t.side === 'LONG' ? Math.max(snap.last, t.tp) : Math.min(snap.last, t.tp)
      comments.push({
        alertType: 'SYSTEM',
        title: `🎯 Пример: цель ${nameOf(t.symbol)}`,
        text: [
          `Учебная сделка закрыта по TP.`,
          `Вход ${fmt(fill)} → ~${fmt(exit)} · ${pnlPct(t.side, fill, exit).toFixed(2)}%`,
          `Финальная вероятность перед выходом была ${winPct}%`,
          brief.pressureLabel,
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
        title: `🚨 Пример: трейл-выход ${nameOf(t.symbol)}`,
        text: [
          `Тень стопа пробита — фиксирую пример.`,
          `Результат ${pnlPct(t.side, fill, exit).toFixed(2)}% · win% был ${winPct}%`,
          brief.pressureLabel,
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
        title: `🛑 Пример: стоп ${nameOf(t.symbol)}`,
        text: [
          `Стоп по учебному плану. Без догона.`,
          `Результат ${pnlPct(t.side, fill, t.sl).toFixed(2)}% · win% перед стопом ${winPct}%`,
          brief.pressureLabel,
          `Риск отработан — жду следующий сетап.`,
        ].join('\n'),
        dedupeKey: `paper:sl:${t.id}`,
      })
      continue
    }

    const lastPulse = t.lastPulseAt ?? t.openedAt ?? t.createdAt
    if (now - lastPulse >= pulseMs(t)) {
      t.lastPulseAt = now
      t.lastWinPct = winPct
      dirty = true
      comments.push(
        buildCommentary({
          t,
          price: snap.last,
          brief,
          winPct,
          prevWin,
          factors,
          phase: 'OPEN',
        })
      )
    }
  }

  if (dirty) await savePaperTrades(env, list)
  return comments
}

export function formatTradesStatus(list: PaperTrade[]): string {
  const live = list.filter((t) => t.status === 'WAITING' || t.status === 'OPEN')
  if (!live.length) {
    return 'Сейчас учебных (бумажных) сделок нет.\nЖду следующий сигнал сканера.'
  }
  const lines = ['Примеры сделок (бумажные):', '']
  for (const t of live) {
    const st = t.status === 'WAITING' ? '⏳ жду вход' : '✅ в позиции'
    const fill = t.fillPrice != null ? ` @ ${fmt(t.fillPrice)}` : ''
    const cad = t.alertType === 'MEME' ? '2м' : '5м'
    const win = t.lastWinPct != null ? ` · P≈${t.lastWinPct}%` : ''
    lines.push(
      `${st} · ${t.side} ${nameOf(t.symbol)} · ${t.setup} · ${cad}${fill}${win}`,
      `  зона ${fmt(t.zoneLow)}–${fmt(t.zoneHigh)} · SL ${fmt(t.sl)} · TP ${fmt(t.tp)}`
    )
  }
  return lines.join('\n')
}
