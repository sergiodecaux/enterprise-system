/**
 * Offline watched setups: KV persistence + readiness evaluation on cron.
 * Portable (no imports from frontend src).
 */

import {
  assessZoneFuel,
  buildHtfLiquidityMap,
  findSmartZone,
} from './liquidityZones'

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
  /** Last 10-min levels refresh (pullback/zone rebuild) */
  lastLevelsRefreshAt?: number
  /** Lifecycle phase for hard transition alerts */
  lastLifecyclePhase?: LifecyclePhase
}

export type LifecyclePhase =
  | 'FAR'
  | 'APPROACH'
  | 'TOUCH'
  | 'REACTION'
  | 'FUEL'
  | 'READY'
  | 'INVALIDATED'

export interface WatchAlert {
  chatId: number
  title: string
  text: string
  dedupeKey: string
}

type Candle = [number, number, number, number, number, number]

const WATCH_KEY = 'telegram:watched_setups'
const DIGEST_MS = 5 * 60_000
const REFRESH_MS = 10 * 60_000
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
  lifecycle: LifecyclePhase
  bookOk: boolean
  reactionOk: boolean
  fuelOk: boolean
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

async function fetchBookImbalance(symbol: string): Promise<number | null> {
  const json = await mexcJson<{
    data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
  }>(`/api/v1/contract/depth/${symbol}?limit=20`)
  const asks = json?.data?.asks ?? []
  const bids = json?.data?.bids ?? []
  if (!asks.length || !bids.length) return null
  let askVol = 0
  let bidVol = 0
  for (const a of asks) askVol += Number(a[1] ?? 0)
  for (const b of bids) bidVol += Number(b[1] ?? 0)
  const tot = askVol + bidVol
  if (!(tot > 0)) return null
  return ((bidVol - askVol) / tot) * 100
}

function toMexcSymbol(internalOrFlat: string): string {
  const s = (internalOrFlat || '').trim().toUpperCase()
  if (!s) return 'UNKNOWN_USDT'
  // BTC_USDT
  if (s.includes('_') && s.endsWith('_USDT')) return s
  // BTC/USDT:USDT or BTC/USDT
  if (s.includes('/')) {
    const base = s.split('/')[0]!.replace(/:USDT$/i, '')
    return `${base}_USDT`
  }
  // Flat BTCUSDT → BTC_USDT
  if (s.endsWith('USDT') && !s.endsWith('_USDT')) {
    return `${s.slice(0, -4)}_USDT`
  }
  return `${s}_USDT`
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
  ohlcv4h: Candle[],
  bookImb: number | null = null
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
      lifecycle: 'INVALIDATED',
      bookOk: false,
      reactionOk: false,
      fuelOk: false,
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
      lifecycle: 'INVALIDATED',
      bookOk: false,
      reactionOk: false,
      fuelOk: false,
    }
  }

  const fuel = assessZoneFuel({
    side: setup.side,
    price,
    zoneLow: setup.entryZone.bottom,
    zoneHigh: setup.entryZone.top,
    candles1m: ohlcv1m,
    bookImb,
  })

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
    if (p.id === 'book') {
      if (fuel.bookOk) p.status = 'MET'
      else if (
        bookImb != null &&
        ((setup.side === 'LONG' && bookImb <= -18) ||
          (setup.side === 'SHORT' && bookImb >= 18))
      ) {
        p.status = 'FAILED'
      } else {
        p.status = 'PENDING'
      }
    }
    if (p.id === 'reject' || p.id === 'confirm' || p.id === 'flip' || p.id === 'fuel') {
      if (fuel.reactionOk) p.status = 'MET'
      else if (inside) p.status = p.status === 'MET' ? 'MET' : 'PENDING'
    }
  }

  // Ensure book/confirm exist for zone watches
  if (!pre.some((p) => p.id === 'book')) {
    pre.push({
      id: 'book',
      label: 'Стакан / топливо',
      status: fuel.bookOk ? 'MET' : 'PENDING',
    })
  }
  if (!pre.some((p) => p.id === 'confirm')) {
    pre.push({
      id: 'confirm',
      label: 'Реакция зоны',
      status: fuel.reactionOk ? 'MET' : 'PENDING',
    })
  }

  let status: SetupStatus = 'HYPOTHESIS'
  if (pre.some((p) => p.status === 'FAILED')) status = 'INVALIDATED'
  else if (pre.length > 0 && pre.every((p) => p.status === 'MET')) status = 'READY'
  else if (setup.kind.startsWith('FORECAST') && inside && fuel.fuelOk) status = 'READY'
  else if (inside && fuel.reactionOk && fuel.bookOk) status = 'READY'
  else if (pre.some((p) => p.status === 'MET')) status = 'ARMED'

  const met = pre.filter((p) => p.status === 'MET').length
  const pending = pre.filter((p) => p.status === 'PENDING').length
  const approach = !inside && Math.abs(distToZonePct) < 0.45

  let lifecycle: LifecyclePhase = 'FAR'
  if (status === 'INVALIDATED') lifecycle = 'INVALIDATED'
  else if (status === 'READY' || (inside && fuel.reactionOk && fuel.bookOk)) {
    lifecycle = 'READY'
  } else if (inside && fuel.bookOk && !fuel.reactionOk) lifecycle = 'FUEL'
  else if (inside && fuel.reactionOk) lifecycle = 'REACTION'
  else if (inside) lifecycle = 'TOUCH'
  else if (approach) lifecycle = 'APPROACH'

  let narrative: string
  if (lifecycle === 'READY') {
    narrative = `READY: зона + реакция + топливо → цель ${setup.target}`
  } else if (lifecycle === 'FUEL') {
    narrative = `FUEL: стакан за сторону · ждём 1m реакцию · ${fuel.fuelNote}`
  } else if (lifecycle === 'REACTION') {
    narrative = `REACTION: ${fuel.reactionNote} · ждём топливо стакана`
  } else if (lifecycle === 'TOUCH') {
    narrative = `TOUCH — ${fuel.reactionNote}`
  } else if (lifecycle === 'APPROACH') {
    narrative = `APPROACH (${distToZonePct >= 0 ? '+' : ''}${distToZonePct.toFixed(2)}%) — смотрим закрепление`
  } else if (status === 'ARMED') {
    narrative = `Частично (${met} MET, ${pending} PENDING)`
  } else {
    narrative =
      distToZonePct > 0
        ? `FAR · выше зоны на ${distToZonePct.toFixed(2)}%`
        : `FAR · ниже зоны на ${Math.abs(distToZonePct).toFixed(2)}%`
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
    lifecycle,
    bookOk: fuel.bookOk,
    reactionOk: fuel.reactionOk,
    fuelOk: fuel.fuelOk,
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
  const risk = Math.abs(s.limitEntry - s.invalidation)
  const reward = Math.abs(s.target - s.limitEntry)
  const rr = risk > 0 ? reward / risk : 0
  const ageMin = Math.max(0, Math.round((Date.now() - w.createdAt) / 60_000))
  const liveWin = liveWatchWinPct(s, snap)
  const preLines = snap.preconditions.slice(0, 5).map((p) => {
    const mark =
      p.status === 'MET' ? '✓' : p.status === 'FAILED' ? '✗' : '·'
    return `  ${mark} ${p.label} [${p.status}]`
  })
  const nextStep =
    snap.status === 'READY'
      ? '➡️ Действие: лимитка по зоне, не догонять'
      : snap.status === 'ARMED'
        ? '➡️ Ждём подтверждение / reclaim'
        : snap.inZone
          ? '➡️ Цена в зоне — смотри реакцию стакана'
          : '➡️ Ждём подход цены к зоне'

  return [
    `${icon} ${s.side} ${w.symbol}`,
    `${s.title}`,
    `Статус: ${snap.status} · фаза ${snap.lifecycle} · Live win% ~${liveWin}% (база ${Math.round(s.probability)}%) · R:R 1:${rr.toFixed(1)}`,
    `Цена: ${fmtPx(snap.price)}`,
    `Зона: ${fmtPx(s.entryZone.bottom)} – ${fmtPx(s.entryZone.top)}`,
    `До зоны: ${
      snap.inZone
        ? 'ВНУТРИ ✓'
        : `${snap.distToZonePct >= 0 ? '+' : ''}${snap.distToZonePct.toFixed(2)}%`
    }`,
    `Лимит: ${fmtPx(s.limitEntry)} (${snap.distToLimitPct >= 0 ? '+' : ''}${snap.distToLimitPct.toFixed(2)}%)`,
    `SL: ${fmtPx(s.invalidation)} · TP: ${fmtPx(s.target)}`,
    `Возраст watch: ${ageMin} мин`,
    snap.narrative,
    nextStep,
    'Условия:',
    ...preLines,
  ].join('\n')
}

/** Live win% for watch: zone progress + path vs SL/TP (not a static snapshot). */
function liveWatchWinPct(
  setup: ConditionalSetupPayload,
  snap: WatchEvalSnapshot
): number {
  let p = Math.max(40, Math.min(78, setup.probability || 55))
  if (snap.status === 'READY') p += 8
  else if (snap.status === 'ARMED') p += 4
  else if (snap.status === 'INVALIDATED') p = Math.min(p, 28)

  if (snap.inZone) p += 6

  // Price progressing toward TP from limit
  const risk = Math.abs(setup.limitEntry - setup.invalidation)
  const reward = Math.abs(setup.target - setup.limitEntry)
  if (risk > 0 && reward > 0) {
    const r =
      setup.side === 'LONG'
        ? (snap.price - setup.limitEntry) / risk
        : (setup.limitEntry - snap.price) / risk
    if (r >= 0.4) p += 10
    else if (r >= 0.1) p += 5
    else if (r <= -0.5) p -= 12
    else if (r <= -0.2) p -= 5
  }

  // Approaching zone from the correct side is good for bounce setups
  if (!snap.inZone) {
    if (setup.side === 'LONG' && snap.distToZonePct < 0 && snap.distToZonePct > -1.2) {
      p += 3 // below zone slightly — may reclaim
    }
    if (setup.side === 'SHORT' && snap.distToZonePct > 0 && snap.distToZonePct < 1.2) {
      p += 3
    }
  }

  return Math.round(Math.min(88, Math.max(26, p)))
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

function formatLifecyclePhase(
  w: WatchedSetupRecord,
  snap: WatchEvalSnapshot
): WatchAlert {
  const s = w.setup
  const icon = s.side === 'LONG' ? '🟢' : '🔴'
  const phase = snap.lifecycle
  const titleMap: Record<LifecyclePhase, string> = {
    FAR: `⏳ FAR · ${w.symbol}`,
    APPROACH: `📍 APPROACH · ${w.symbol}`,
    TOUCH: `🖐 TOUCH · ${w.symbol}`,
    REACTION: `⚡ REACTION · ${w.symbol}`,
    FUEL: `⛽ FUEL · ${w.symbol}`,
    READY: `🎯 READY · ${w.symbol}`,
    INVALIDATED: `⛔ INVALIDATED · ${w.symbol}`,
  }
  const chain = 'APPROACH → TOUCH → REACTION → FUEL → READY'
  return {
    chatId: w.chatId,
    title: titleMap[phase] ?? `Фаза ${phase}`,
    text: [
      `${icon} ${s.side} ${w.symbol} · ${s.title}`,
      `Фаза: <b>${phase}</b>`,
      `Цепочка: ${chain}`,
      '',
      snap.narrative,
      `Цена: ${fmtPx(snap.price)}`,
      `Зона: ${fmtPx(s.entryZone.bottom)} – ${fmtPx(s.entryZone.top)}`,
      `Лимит: ${fmtPx(s.limitEntry)} · TP: ${fmtPx(s.target)} · SL: ${fmtPx(s.invalidation)}`,
      `Реакция: ${snap.reactionOk ? '✓' : '·'} · Стакан: ${snap.bookOk ? '✓' : '·'} · Топливо: ${snap.fuelOk ? '✓' : '·'}`,
      `Win% сетапа: ~${Math.round(s.probability)}%`,
    ].join('\n'),
    dedupeKey: `watch:${w.watchId}:phase:${phase}:${Math.floor(Date.now() / 120_000)}`,
  }
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

function formatRefreshed(
  w: WatchedSetupRecord,
  price: number,
  reason: string,
  prev: { limit: number; zoneLo: number; zoneHi: number }
): WatchAlert {
  const s = w.setup
  const icon = s.side === 'LONG' ? '🟢' : '🔴'
  return {
    chatId: w.chatId,
    title: `🔄 Сетап обновлён · ${w.symbol}`,
    text: [
      `${icon} ${s.side} · ${s.title}`,
      `Причина: ${reason}`,
      `Цена сейчас: ${fmtPx(price)}`,
      '',
      `Было: лимит ${fmtPx(prev.limit)} · зона ${fmtPx(prev.zoneLo)}–${fmtPx(prev.zoneHi)}`,
      `Стало: лимит ${fmtPx(s.limitEntry)} · зона ${fmtPx(s.entryZone.bottom)}–${fmtPx(s.entryZone.top)}`,
      `SL ${fmtPx(s.invalidation)} · TP ${fmtPx(s.target)} · ~${Math.round(s.probability)}%`,
      '',
      'Откат/зона пересчитаны по свежим свингам (каждые 10 мин).',
    ].join('\n'),
    dedupeKey: `watch:${w.watchId}:REFRESH:${Math.floor(Date.now() / REFRESH_MS)}`,
  }
}

/** Recent swing low/high from closed candles */
function recentSwing(
  candles: Candle[],
  kind: 'low' | 'high'
): number | null {
  if (candles.length < 8) return null
  const closed = candles.slice(0, -1)
  const slice = closed.slice(-24)
  if (kind === 'low') {
    let v = slice[0][3]
    for (const c of slice) v = Math.min(v, c[3])
    return v
  }
  let v = slice[0][2]
  for (const c of slice) v = Math.max(v, c[2])
  return v
}

function zoneBand(mid: number, pct = 0.0035): { top: number; bottom: number } {
  return { top: mid * (1 + pct), bottom: mid * (1 - pct) }
}

function isBounceLike(setup: ConditionalSetupPayload): boolean {
  // User-defined zones must keep fixed geometry — never auto-rebuild to SSL/BSL
  if (setup.kind === 'USER_ZONE') return false
  const t = `${setup.kind} ${setup.title}`.toUpperCase()
  return (
    t.includes('BOUNCE') ||
    t.includes('ОТСКОК') ||
    t.includes('ОТКАТ') ||
    t.includes('PULL') ||
    t.includes('SURGICAL') ||
    t.includes('FORECAST') ||
    t.includes('SSL') ||
    t.includes('BSL') ||
    t.includes('OTE') ||
    t.includes('FIB')
  )
}

/**
 * Pullback already played / geometry wrong / zone too far → needs rebuild.
 */
function pullbackStaleReason(
  setup: ConditionalSetupPayload,
  price: number,
  ohlcv1m: Candle[]
): string | null {
  if (!isBounceLike(setup) || !(price > 0)) return null

  const zone = setup.entryZone
  const mid = (zone.top + zone.bottom) / 2
  const recent = ohlcv1m.slice(-40)

  const touched = recent.some((c) =>
    setup.side === 'LONG' ? c[3] <= zone.top * 1.002 : c[2] >= zone.bottom * 0.998
  )
  const leftZone =
    setup.side === 'LONG'
      ? price > zone.top * 1.004
      : price < zone.bottom * 0.996

  // Цена уже сходила в зону и ушла — откат отыгран, старый лимит мёртв
  if (touched && leftZone && setup.status !== 'READY') {
    return 'откат уже был: цена касалась зоны и ушла'
  }

  // LONG ждал покупку снизу, а зона выше цены — это не откат вниз
  if (setup.side === 'LONG' && mid > price * 1.003) {
    return 'зона выше цены — сценарий отката устарел'
  }
  // SHORT ждал продажу сверху, а зона ниже
  if (setup.side === 'SHORT' && mid < price * 0.997) {
    return 'зона ниже цены — сценарий отката устарел'
  }

  // Пробой зоны без READY
  if (setup.side === 'LONG' && price < zone.bottom * 0.992) {
    return 'цена пробила зону вниз — нужна новая SSL'
  }
  if (setup.side === 'SHORT' && price > zone.top * 1.008) {
    return 'цена пробила зону вверх — нужна новая BSL'
  }

  // Слишком далеко ждать
  const distPct = Math.abs(((mid - price) / price) * 100)
  if (distPct > 2.8) {
    return `зона слишком далеко (${distPct.toFixed(2)}%)`
  }

  return null
}

/**
 * Rebuild bounce/pullback levels — HTF SSL/BSL (4H/D) only. 15m is never zone source.
 */
function rebuildPullbackSetup(
  setup: ConditionalSetupPayload,
  price: number,
  c15: Candle[],
  c1h: Candle[],
  c4h: Candle[] = [],
  c1d: Candle[] = []
): ConditionalSetupPayload | null {
  if (!(price > 0)) return null

  const htf = c4h.length >= 24 ? c4h : c1h.length >= 40 ? c1h : []
  if (htf.length < 24 && c4h.length < 24) {
    // No HTF → do not invent a 15m "zone"
    return null
  }

  const last = (c4h[c4h.length - 1] ?? c1h[c1h.length - 1])!
  const atrApprox = Math.max((last[2] - last[3]) * 2.5, price * 0.01)
  const map = buildHtfLiquidityMap({
    candles4h: c4h.length >= 24 ? c4h : htf,
    candles1d: c1d,
    candles1h: c1h,
    price,
  })
  const smart = findSmartZone(setup.side, price, map, atrApprox)

  if (!smart || smart.strength < 5) {
    // Keep old levels rather than replacing with weak LTF noise
    return null
  }

  const oldMid = (setup.entryZone.top + setup.entryZone.bottom) / 2
  if (Math.abs(smart.mid - oldMid) / price < 0.0015) return null
  const inZoneNow =
    price >= smart.zoneLow * 0.997 && price <= smart.zoneHigh * 1.003
  return {
    ...setup,
    kind: setup.side === 'LONG' ? 'BOUNCE_SSL' : 'BOUNCE_BSL',
    title: `↗ ${smart.tf} ${smart.source} ×${smart.touches} · ${smart.strength}/10 · ${smart.phase}`,
    probability: Math.round(
      Math.min(
        80,
        Math.max(
          55,
          50 +
            smart.strength +
            (smart.tf === '1D' ? 4 : 0) +
            (smart.phase === 'APPROACH' ? 5 : 0) +
            smart.confluence * 2
        )
      )
    ),
    preconditions: [
      {
        id: 'touch',
        label: `Касание ${smart.tf} ${smart.source}`,
        status: inZoneNow ? 'MET' : 'PENDING',
      },
      { id: 'book', label: 'Стакан / топливо', status: 'PENDING' },
      { id: 'confirm', label: '1m реакция на HTF-зоне', status: 'PENDING' },
    ],
    entryZone: { top: smart.zoneHigh, bottom: smart.zoneLow },
    limitEntry: smart.limitEntry,
    target: smart.target,
    invalidation: smart.invalidate,
    triggerSummary: `${smart.tf} ${smart.source} → ${smart.targetLabel}`,
    reasoning: smart.reasoning,
    status: inZoneNow ? 'ARMED' : 'HYPOTHESIS',
    createdAt: setup.createdAt,
  }
}

function dueForLevelsRefresh(w: WatchedSetupRecord, now: number): boolean {
  const anchor = w.lastLevelsRefreshAt ?? w.createdAt
  return now - anchor >= REFRESH_MS
}

export async function markChatDigestSent(
  env: Env,
  chatId: number,
  at = Date.now()
): Promise<void> {
  const list = await listWatches(env)
  let changed = false
  const next = list.map((w) => {
    if (w.chatId !== chatId || w.expiresAt <= at) return w
    changed = true
    return { ...w, lastDigestAt: at, updatedAt: at }
  })
  if (changed) await saveWatches(env, next)
}

/**
 * Cron: evaluate watches, refresh stale pullback levels every 10 min,
 * emit READY / INVALIDATED / REFRESH, plus 5-min digests.
 * Note: lastDigestAt is stamped by caller AFTER successful Telegram send.
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
    const [c1m, c15, c1h, c4h, c1d, bookImb] = await Promise.all([
      fetchKlines(mexcSym, 'Min1', 60),
      fetchKlines(mexcSym, 'Min15', 64),
      fetchKlines(mexcSym, 'Min60', 60),
      fetchKlines(mexcSym, 'Hour4', 90),
      fetchKlines(mexcSym, 'Day1', 60),
      fetchBookImbalance(mexcSym),
    ])
    const price =
      c1m[c1m.length - 1]?.[4] ??
      c15[c15.length - 1]?.[4] ??
      c1h[c1h.length - 1]?.[4] ??
      0

    for (const w of watches) {
      let working = w

      // Every 10 min: rebuild stale pullback from HTF SSL/BSL only
      // USER_ZONE keeps fixed user geometry forever
      if (
        price &&
        dueForLevelsRefresh(w, now) &&
        w.setup.kind !== 'USER_ZONE'
      ) {
        const staleReason = pullbackStaleReason(w.setup, price, c1m)
        let reason = staleReason
        if (!reason && isBounceLike(w.setup)) {
          const map = buildHtfLiquidityMap({
            candles4h: c4h,
            candles1d: c1d,
            candles1h: c1h,
            price,
          })
          const smart = findSmartZone(w.setup.side, price, map, price * 0.01)
          const oldMid =
            (w.setup.entryZone.top + w.setup.entryZone.bottom) / 2
          if (
            smart &&
            Math.abs(smart.mid - oldMid) / price >= 0.0025
          ) {
            reason = `HTF ${smart.tf} зона сдвинулась — обновляю SSL/BSL`
          }
        }

        if (reason) {
          const rebuilt = rebuildPullbackSetup(
            w.setup,
            price,
            c15,
            c1h,
            c4h,
            c1d
          )
          if (rebuilt) {
            const prev = {
              limit: w.setup.limitEntry,
              zoneLo: w.setup.entryZone.bottom,
              zoneHi: w.setup.entryZone.top,
            }
            working = {
              ...w,
              setup: rebuilt,
              lastStatus: rebuilt.status,
              readyNotified: false,
              lastLevelsRefreshAt: now,
              updatedAt: now,
            }
            alerts.push(formatRefreshed(working, price, reason, prev))
          } else {
            working = { ...w, lastLevelsRefreshAt: now, updatedAt: now }
          }
        } else {
          working = { ...w, lastLevelsRefreshAt: now, updatedAt: now }
        }
      }

      let snap: WatchEvalSnapshot
      if (!price) {
        snap = {
          status: working.lastStatus || 'HYPOTHESIS',
          price: working.setup.limitEntry,
          inZone: false,
          distToZonePct: 0,
          distToLimitPct: 0,
          distToInvPct: 0,
          preconditions: working.setup.preconditions ?? [],
          narrative: `Нет котировки по ${mexcSym} — повторю на следующем цикле`,
          lifecycle: working.lastLifecyclePhase ?? 'FAR',
          bookOk: false,
          reactionOk: false,
          fuelOk: false,
        }
      } else {
        snap = evaluateWatchSnapshot(
          working.setup,
          price,
          c1m,
          c1h,
          c4h,
          bookImb
        )
      }

      const status = snap.status
      const updated: WatchedSetupRecord = {
        ...working,
        lastStatus: status,
        lastLifecyclePhase: snap.lifecycle,
        setup: {
          ...working.setup,
          status,
          preconditions: snap.preconditions,
        },
        updatedAt: Date.now(),
      }

      // Hard lifecycle transitions (skip noisy FAR)
      const prevPhase = working.lastLifecyclePhase
      const nextPhase = snap.lifecycle
      const noteworthy: LifecyclePhase[] = [
        'APPROACH',
        'TOUCH',
        'REACTION',
        'FUEL',
        'READY',
        'INVALIDATED',
      ]
      if (
        price &&
        nextPhase !== prevPhase &&
        noteworthy.includes(nextPhase) &&
        nextPhase !== 'READY' &&
        nextPhase !== 'INVALIDATED'
      ) {
        alerts.push(formatLifecyclePhase(updated, snap))
      }

      if (price && status === 'READY' && !working.readyNotified) {
        alerts.push(formatReady(updated, price))
        updated.readyNotified = true
      }
      if (price && status === 'INVALIDATED' && !working.invalidatedNotified) {
        alerts.push(formatInvalidated(updated, price))
        updated.invalidatedNotified = true
      }

      if (status === 'INVALIDATED' && updated.invalidatedNotified) {
        // Keep record briefly so phase INVALIDATED was sent; drop from active
        continue
      }

      snapshots.set(updated.watchId, snap)
      next.push(updated)
    }
  }

  // One digest per chat every 5 minutes (first ≈ 5 min after create)
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

    const blocks: string[] = []
    let chars = 0
    for (const w of watches.slice(0, 5)) {
      const snap = snapshots.get(w.watchId)
      if (!snap) continue
      const block = formatDigestBlock(w, snap)
      // Telegram hard limit ~4096; keep headroom
      if (chars + block.length > 3200) break
      blocks.push(block)
      chars += block.length + 8
    }
    if (blocks.length === 0) continue

    const armed = watches.filter((w) => w.lastStatus === 'ARMED').length
    const ready = watches.filter((w) => w.lastStatus === 'READY').length
    const hyp = watches.filter(
      (w) => w.lastStatus === 'HYPOTHESIS' || !w.lastStatus
    ).length

    const phaseLine = watches
      .slice(0, 5)
      .map((w) => {
        const snap = snapshots.get(w.watchId)
        const ph = snap?.lifecycle ?? w.lastLifecyclePhase ?? 'FAR'
        return `  · ${w.symbol} · ${ph}`
      })
      .join('\n')

    alerts.push({
      chatId,
      title: `📡 Мониторинг · ${blocks.length}/${watches.length}`,
      text: [
        `Отчёт каждые 5 мин · ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
        `Сводка: READY ${ready} · ARMED ${armed} · HYPOTHESIS ${hyp} · всего ${watches.length}`,
        'Фазы:',
        phaseLine || '  · —',
        'Цепочка: APPROACH → TOUCH → REACTION → FUEL → READY',
        `Уровни зон (4H/D) пересчитываются каждые 10 мин.`,
        '',
        ...blocks.flatMap((block, i) =>
          i < blocks.length - 1 ? [block, '────────'] : [block]
        ),
        '',
        'Смена фазы шлётся сразу · READY → лимит · ⛔ INVALIDATED.',
      ].join('\n'),
      // Unique per send window; retries ok if previous send failed (dedup after success)
      dedupeKey: `watch_digest:${chatId}:${Math.floor(now / DIGEST_MS)}`,
    })
  }

  void expired
  await saveWatches(env, next)
  return alerts
}

/** Short lines for idle pulse (per chat) */
export async function watchSummaryLines(
  env: Env,
  chatId: number,
  limit = 5
): Promise<string[]> {
  const watches = await listWatchesForChat(env, chatId)
  return watches.slice(0, limit).map((w) => {
    const s = w.setup
    const mid = (s.entryZone.top + s.entryZone.bottom) / 2
    return `  · ${s.side} ${w.symbol} · ${w.lastStatus} · зона≈${fmtPx(mid)} · ~${Math.round(s.probability)}%`
  })
}

export async function countActiveWatches(env: Env): Promise<number> {
  const list = await listWatches(env)
  const now = Date.now()
  return list.filter((w) => w.expiresAt > now).length
}

/** Create many watches in one KV write (avoids lost updates). */
export async function createWatchesBatch(
  env: Env,
  input: {
    chatId: number
    symbol: string
    internalSymbol: string
    setups: ConditionalSetupPayload[]
    ttlHours?: number
  }
): Promise<WatchedSetupRecord[]> {
  const ttl = (input.ttlHours ?? 48) * 3600_000
  const now = Date.now()
  const list = await listWatches(env)
  const setupIds = new Set(input.setups.map((s) => s.id))
  const filtered = list.filter(
    (w) => !(w.chatId === input.chatId && setupIds.has(w.setup.id))
  )
  const created: WatchedSetupRecord[] = []
  for (const setup of input.setups.slice(0, 8)) {
    const watch: WatchedSetupRecord = {
      watchId: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      chatId: input.chatId,
      symbol: input.symbol,
      internalSymbol: input.internalSymbol,
      setup,
      createdAt: now,
      expiresAt: now + ttl,
      lastStatus: setup.status,
      readyNotified: false,
      invalidatedNotified: false,
      updatedAt: now,
    }
    created.push(watch)
    filtered.push(watch)
  }
  await saveWatches(env, filtered)
  return created
}
