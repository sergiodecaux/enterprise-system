/**
 * Offline watched setups: KV persistence + readiness evaluation on cron.
 * Portable (no imports from frontend src).
 */

export type SetupStatus =
  | 'HYPOTHESIS'
  | 'ARMED'
  | 'READY'
  | 'INVALIDATED'
  | 'EXPIRED'

export interface ConditionalSetupPayload {
  id: string
  kind: string
  side: 'LONG' | 'SHORT'
  title: string
  probability: number
  preconditions: { id: string; label: string; status: string }[]
  entryZone: { top: number; bottom: number }
  limitEntry: number
  target: number
  invalidation: number
  triggerSummary: string
  reasoning: string[]
  status: SetupStatus
  symbol?: string
  internalSymbol?: string
  createdAt: number
}

export interface WatchedSetupRecord {
  watchId: string
  chatId: number
  symbol: string
  internalSymbol: string
  setup: ConditionalSetupPayload
  createdAt: number
  expiresAt: number
  lastStatus: SetupStatus
  readyNotified: boolean
  invalidatedNotified: boolean
  updatedAt: number
  /** Last 5-min monitoring digest sent to Telegram */
  lastDigestAt?: number
}

export interface WatchAlert {
  chatId: number
  title: string
  text: string
  dedupeKey: string
}

type Candle = [number, number, number, number, number, number]

const WATCH_KEY = 'telegram:watched_setups'
const DIGEST_MS = 5 * 60_000
const memoryWatches: WatchedSetupRecord[] = []

interface WatchEvalSnapshot {
  status: SetupStatus
  price: number
  inZone: boolean
  distToZonePct: number
  distToLimitPct: number
  distToInvPct: number
  preconditions: { id: string; label: string; status: string }[]
  narrative: string
}

interface Env {
  SUBSCRIBERS?: KVNamespace
}

const MEXC = 'https://contract.mexc.com'

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MEXC}${path}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const json = await mexcJson<{
    data: {
      time: number[]
      open: number[]
      high: number[]
      low: number[]
      close: number[]
      vol: number[]
    }
  }>(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=${limit}`)

  const d = json?.data
  if (!d?.time?.length) return []
  const out: Candle[] = []
  for (let i = 0; i < d.time.length; i++) {
    out.push([
      d.time[i] * 1000,
      Number(d.open[i]),
      Number(d.high[i]),
      Number(d.low[i]),
      Number(d.close[i]),
      Number(d.vol[i] ?? 0),
    ])
  }
  return out
}

function toMexcSymbol(internalOrFlat: string): string {
  // BTC/USDT:USDT → BTC_USDT ; BTC_USDT stays
  if (internalOrFlat.includes('_')) return internalOrFlat
  const base = internalOrFlat.split('/')[0]?.replace(':USDT', '') ?? internalOrFlat
  return `${base}_USDT`
}

function lastSwing(candles: Candle[], kind: 'high' | 'low'): number | null {
  if (candles.length < 10) return null
  const slice = candles.slice(0, -1) // closed only
  for (let i = slice.length - 3; i >= 2; i--) {
    const h = slice[i][2]
    const l = slice[i][3]
    if (
      kind === 'high' &&
      h > slice[i - 1][2] &&
      h > slice[i - 2][2] &&
      h > slice[i + 1][2] &&
      h >= slice[i + 2]?.[2]
    ) {
      return h
    }
    if (
      kind === 'low' &&
      l < slice[i - 1][3] &&
      l < slice[i - 2][3] &&
      l < slice[i + 1][3] &&
      l <= (slice[i + 2]?.[3] ?? l)
    ) {
      return l
    }
  }
  return kind === 'high'
    ? Math.max(...slice.slice(-20).map((c) => c[2]))
    : Math.min(...slice.slice(-20).map((c) => c[3]))
}

function htfBreached(
  candles: Candle[],
  side: 'LONG' | 'SHORT'
): boolean {
  if (candles.length < 24) return false
  const closed = candles[candles.length - 2]
  const close = closed[4]
  if (side === 'LONG') {
    const swing = lastSwing(candles, 'low')
    return swing != null && close < swing
  }
  const swing = lastSwing(candles, 'high')
  return swing != null && close > swing
}

function inZone(
  price: number,
  zone: { top: number; bottom: number }
): boolean {
  return price >= zone.bottom * 0.997 && price <= zone.top * 1.003
}

function wickSweep(
  candles: Candle[],
  micro: number,
  side: 'LONG' | 'SHORT'
): boolean {
  for (const c of candles.slice(-40)) {
    const [, , high, low, close] = c
    if (side === 'LONG' && low <= micro * 1.001 && close > micro * 0.999) {
      return true
    }
    if (side === 'SHORT' && high >= micro * 0.999 && close < micro * 1.001) {
      return true
    }
  }
  return false
}

export function evaluateWatchSetup(
  setup: ConditionalSetupPayload,
  price: number,
  ohlcv1m: Candle[],
  ohlcv1h: Candle[],
  ohlcv4h: Candle[]
): SetupStatus {
  return evaluateWatchSnapshot(setup, price, ohlcv1m, ohlcv1h, ohlcv4h).status
}

export function evaluateWatchSnapshot(
  setup: ConditionalSetupPayload,
  price: number,
  ohlcv1m: Candle[],
  ohlcv1h: Candle[],
  ohlcv4h: Candle[]
): WatchEvalSnapshot {
  const zoneMid = (setup.entryZone.top + setup.entryZone.bottom) / 2
  const inside = inZone(price, setup.entryZone)
  const distToZonePct =
    price === 0
      ? 0
      : inside
        ? 0
        : ((price - zoneMid) / price) * 100
  const distToLimitPct =
    price === 0 ? 0 : ((price - setup.limitEntry) / price) * 100
  const distToInvPct =
    price === 0 ? 0 : ((price - setup.invalidation) / price) * 100

  if (htfBreached(ohlcv4h, setup.side) || htfBreached(ohlcv1h, setup.side)) {
    return {
      status: 'INVALIDATED',
      price,
      inZone: inside,
      distToZonePct,
      distToLimitPct,
      distToInvPct,
      preconditions: setup.preconditions.map((p) => ({ ...p, status: 'FAILED' })),
      narrative: 'HTF слом — сетап снят',
    }
  }
  if (
    (setup.side === 'LONG' && price < setup.invalidation) ||
    (setup.side === 'SHORT' && price > setup.invalidation)
  ) {
    return {
      status: 'INVALIDATED',
      price,
      inZone: inside,
      distToZonePct,
      distToLimitPct,
      distToInvPct,
      preconditions: setup.preconditions.map((p) => ({ ...p, status: 'FAILED' })),
      narrative: 'Цена за invalidation',
    }
  }

  const pre = setup.preconditions.map((p) => ({ ...p }))
  for (const p of pre) {
    if (p.id === 'touch' || p.id === 'zone' || p.id === 'limit' || p.id === 'entry') {
      p.status = inside ? 'MET' : 'PENDING'
    }
    if (p.id === 'sweep' || p.id === 'stop_hunt') {
      p.status = wickSweep(ohlcv1m, setup.limitEntry, setup.side)
        ? 'MET'
        : p.status
    }
    if (p.id === 'reject' || p.id === 'confirm' || p.id === 'flip' || p.id === 'book') {
      const swept = pre.find(
        (x) =>
          x.id === 'sweep' ||
          x.id === 'stop_hunt' ||
          x.id === 'touch' ||
          x.id === 'zone'
      )
      if (swept?.status === 'MET' && inside) {
        if (p.id !== 'book') p.status = 'MET'
      }
    }
  }

  let status: SetupStatus = 'HYPOTHESIS'
  if (pre.some((p) => p.status === 'FAILED')) status = 'INVALIDATED'
  else if (pre.length > 0 && pre.every((p) => p.status === 'MET')) status = 'READY'
  else if (setup.kind.startsWith('FORECAST') && inside) status = 'READY'
  else if (pre.some((p) => p.status === 'MET')) status = 'ARMED'

  const met = pre.filter((p) => p.status === 'MET').length
  const pending = pre.filter((p) => p.status === 'PENDING').length
  let narrative: string
  if (status === 'READY') {
    narrative = 'Все условия MET — можно входить по лимиту'
  } else if (status === 'ARMED') {
    narrative = inside
      ? `В зоне · условий ${met}/${pre.length} · ждём подтверждение`
      : `Частично готово (${met} MET, ${pending} PENDING)`
  } else if (inside) {
    narrative = 'Цена в зоне — ждём реакцию / reclaim'
  } else if (Math.abs(distToZonePct) < 0.35) {
    narrative = `Почти у зоны (${distToZonePct >= 0 ? '+' : ''}${distToZonePct.toFixed(2)}%)`
  } else {
    narrative =
      distToZonePct > 0
        ? `Выше зоны на ${distToZonePct.toFixed(2)}% — ждём подход`
        : `Ниже зоны на ${Math.abs(distToZonePct).toFixed(2)}% — ждём подход`
  }

  return {
    status,
    price,
    inZone: inside,
    distToZonePct,
    distToLimitPct,
    distToInvPct,
    preconditions: pre,
    narrative,
  }
}

function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  if (Math.abs(n) >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

function formatDigestBlock(
  w: WatchedSetupRecord,
  snap: WatchEvalSnapshot
): string {
  const s = w.setup
  const icon = s.side === 'LONG' ? '🟢' : '🔴'
  const preLines = snap.preconditions
    .slice(0, 4)
    .map((p) => {
      const mark =
        p.status === 'MET' ? '✓' : p.status === 'FAILED' ? '✗' : '·'
      return `  ${mark} ${p.label}`
    })
  return [
    `${icon} ${s.side} ${w.symbol} · ${s.title}`,
    `Статус: ${snap.status}`,
    `Цена: ${fmtPx(snap.price)} · зона ${fmtPx(s.entryZone.bottom)}–${fmtPx(s.entryZone.top)}`,
    `До зоны: ${snap.inZone ? 'ВНУТРИ' : `${snap.distToZonePct >= 0 ? '+' : ''}${snap.distToZonePct.toFixed(2)}%`}`,
    `Лимит ${fmtPx(s.limitEntry)} (${snap.distToLimitPct >= 0 ? '+' : ''}${snap.distToLimitPct.toFixed(2)}%) · SL ${fmtPx(s.invalidation)} · TP ${fmtPx(s.target)}`,
    `Win% ~${Math.round(s.probability)}%`,
    snap.narrative,
    ...preLines,
  ].join('\n')
}

export async function listWatches(env: Env): Promise<WatchedSetupRecord[]> {
  if (!env.SUBSCRIBERS) return [...memoryWatches]
  const raw = await env.SUBSCRIBERS.get(WATCH_KEY)
  if (!raw) return [...memoryWatches]
  try {
    return JSON.parse(raw) as WatchedSetupRecord[]
  } catch {
    return [...memoryWatches]
  }
}

async function saveWatches(
  env: Env,
  list: WatchedSetupRecord[]
): Promise<void> {
  memoryWatches.length = 0
  memoryWatches.push(...list)
  if (!env.SUBSCRIBERS) return
  await env.SUBSCRIBERS.put(WATCH_KEY, JSON.stringify(list))
}

export async function createWatch(
  env: Env,
  input: {
    chatId: number
    symbol: string
    internalSymbol: string
    setup: ConditionalSetupPayload
    ttlHours?: number
  }
): Promise<WatchedSetupRecord> {
  const ttl = (input.ttlHours ?? 48) * 3600_000
  const watch: WatchedSetupRecord = {
    watchId: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: input.chatId,
    symbol: input.symbol,
    internalSymbol: input.internalSymbol,
    setup: input.setup,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    lastStatus: input.setup.status,
    readyNotified: false,
    invalidatedNotified: false,
    updatedAt: Date.now(),
  }
  const list = await listWatches(env)
  // Replace same setup id for same chat
  const filtered = list.filter(
    (w) =>
      !(w.chatId === input.chatId && w.setup.id === input.setup.id)
  )
  filtered.push(watch)
  await saveWatches(env, filtered)
  return watch
}

export async function deleteWatch(
  env: Env,
  chatId: number,
  watchId: string
): Promise<boolean> {
  const list = await listWatches(env)
  const next = list.filter(
    (w) => !(w.chatId === chatId && w.watchId === watchId)
  )
  if (next.length === list.length) return false
  await saveWatches(env, next)
  return true
}

export async function listWatchesForChat(
  env: Env,
  chatId: number
): Promise<WatchedSetupRecord[]> {
  const list = await listWatches(env)
  const now = Date.now()
  return list.filter((w) => w.chatId === chatId && w.expiresAt > now)
}

function formatReady(w: WatchedSetupRecord, price: number): WatchAlert {
  const s = w.setup
  const icon = s.side === 'LONG' ? '🟢' : '🔴'
  const isJewel =
    s.title.includes('💎') ||
    s.kind === 'BOUNCE_SSL' ||
    s.kind === 'BOUNCE_BSL' ||
    s.kind === 'SURGICAL' ||
    s.kind === 'MM_HUNT'
  return {
    chatId: w.chatId,
    title: isJewel
      ? `💎 ${icon} Ювелирный ${s.side} · ${w.symbol}`
      : `🎯 Вход возможен · ${w.symbol}`,
    text: [
      `${s.side} ${w.symbol} · ${s.title}`,
      `Статус: READY`,
      `Цена сейчас: ${price}`,
      '',
      `Лимит (вход): ${s.limitEntry}`,
      `Зона: ${s.entryZone.bottom} – ${s.entryZone.top}`,
      `Стоп / Inv: ${s.invalidation}`,
      `Цель (TP): ${s.target}`,
      `Вероятность: ~${Math.round(s.probability)}%`,
      '',
      `Условие: ${s.triggerSummary}`,
      ...(s.reasoning?.slice(0, 3) ?? []),
    ].join('\n'),
    dedupeKey: `watch:${w.watchId}:READY`,
  }
}

function formatInvalidated(w: WatchedSetupRecord, price: number): WatchAlert {
  return {
    chatId: w.chatId,
    title: `⛔ Сетап снят · ${w.symbol}`,
    text: [
      `${w.setup.side} ${w.symbol} · ${w.setup.title}`,
      `Статус: INVALIDATED`,
      `Цена: ${price}`,
      `Inv: ${w.setup.invalidation}`,
      'HTF close / слом условий — слежение остановлено.',
    ].join('\n'),
    dedupeKey: `watch:${w.watchId}:INVALIDATED`,
  }
}

/**
 * Cron: evaluate all active watches, emit READY / INVALIDATED once each,
 * plus a 5-min monitoring digest per chat while watches are live.
 */
export async function monitorWatchedSetups(env: Env): Promise<WatchAlert[]> {
  const list = await listWatches(env)
  const now = Date.now()
  const alerts: WatchAlert[] = []
  const next: WatchedSetupRecord[] = []
  const snapshots = new Map<string, WatchEvalSnapshot>()

  const active = list.filter((w) => w.expiresAt > now)
  const expired = list.filter((w) => w.expiresAt <= now)

  const bySymbol = new Map<string, WatchedSetupRecord[]>()
  for (const w of active) {
    const key = toMexcSymbol(w.internalSymbol || w.symbol)
    const arr = bySymbol.get(key) ?? []
    arr.push(w)
    bySymbol.set(key, arr)
  }

  for (const [mexcSym, watches] of bySymbol) {
    const [c1m, c1h, c4h] = await Promise.all([
      fetchKlines(mexcSym, 'Min1', 60),
      fetchKlines(mexcSym, 'Min60', 60),
      fetchKlines(mexcSym, 'Hour4', 40),
    ])
    const price =
      c1m[c1m.length - 1]?.[4] ??
      c1h[c1h.length - 1]?.[4] ??
      0
    if (!price) {
      next.push(...watches)
      continue
    }

    for (const w of watches) {
      const snap = evaluateWatchSnapshot(w.setup, price, c1m, c1h, c4h)
      const status = snap.status
      const updated: WatchedSetupRecord = {
        ...w,
        lastStatus: status,
        setup: {
          ...w.setup,
          status,
          preconditions: snap.preconditions,
        },
        updatedAt: Date.now(),
      }

      if (status === 'READY' && !w.readyNotified) {
        alerts.push(formatReady(updated, price))
        updated.readyNotified = true
      }
      if (status === 'INVALIDATED' && !w.invalidatedNotified) {
        alerts.push(formatInvalidated(updated, price))
        updated.invalidatedNotified = true
      }

      if (status === 'INVALIDATED' && updated.invalidatedNotified) {
        continue
      }

      snapshots.set(updated.watchId, snap)
      next.push(updated)
    }
  }

  // One digest per chat every 5 minutes (first report 5 min after watch create)
  const byChat = new Map<number, WatchedSetupRecord[]>()
  for (const w of next) {
    const arr = byChat.get(w.chatId) ?? []
    arr.push(w)
    byChat.set(w.chatId, arr)
  }

  for (const [chatId, watches] of byChat) {
    const due = watches.some((w) => {
      const anchor = w.lastDigestAt ?? w.createdAt
      return now - anchor >= DIGEST_MS
    })
    if (!due) continue

    const lines: string[] = []
    for (const w of watches) {
      const snap = snapshots.get(w.watchId)
      if (!snap) continue
      lines.push(formatDigestBlock(w, snap))
    }
    if (lines.length === 0) continue

    for (let i = 0; i < next.length; i++) {
      if (next[i].chatId === chatId) {
        next[i] = { ...next[i], lastDigestAt: now }
      }
    }

    alerts.push({
      chatId,
      title: `📡 Мониторинг сетапов · ${lines.length}`,
      text: [
        `Отчёт каждые 5 мин · активных: ${lines.length}`,
        '',
        ...lines.flatMap((block, i) =>
          i < lines.length - 1 ? [block, '———'] : [block]
        ),
        '',
        'READY — вход по лимиту · INVALIDATED — стоп слежения.',
      ].join('\n'),
      dedupeKey: `watch_digest:${chatId}:${Math.floor(now / DIGEST_MS)}`,
    })
  }

  void expired
  await saveWatches(env, next)
  return alerts
}
