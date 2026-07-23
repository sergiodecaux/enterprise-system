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
  /** Last 10-min levels refresh (pullback/zone rebuild) */
  lastLevelsRefreshAt?: number
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
  const risk = Math.abs(s.limitEntry - s.invalidation)
  const reward = Math.abs(s.target - s.limitEntry)
  const rr = risk > 0 ? reward / risk : 0
  const ageMin = Math.max(0, Math.round((Date.now() - w.createdAt) / 60_000))
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
    `Статус: ${snap.status} · Win% ~${Math.round(s.probability)}% · R:R 1:${rr.toFixed(1)}`,
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
 * Rebuild bounce/pullback levels from fresh 15m/1h swings.
 */
function rebuildPullbackSetup(
  setup: ConditionalSetupPayload,
  price: number,
  c15: Candle[],
  c1h: Candle[]
): ConditionalSetupPayload | null {
  const swingSrc = c15.length >= 10 ? c15 : c1h
  if (swingSrc.length < 8 || !(price > 0)) return null

  const swingLow = recentSwing(swingSrc, 'low')
  const swingHigh = recentSwing(swingSrc, 'high')
  if (swingLow == null || swingHigh == null || swingHigh <= swingLow) return null

  const range = swingHigh - swingLow
  let mid: number
  let label: string
  let kind = setup.kind

  if (setup.side === 'LONG') {
    // Prefer SSL under price; else 61.8% pullback of range under price
    const fib618 = swingHigh - range * 0.618
    mid =
      swingLow < price * 0.999
        ? swingLow
        : fib618 < price * 0.999
          ? fib618
          : price * 0.994
    label = swingLow < price * 0.999 ? 'SSL fresh' : 'Fib 0.618 fresh'
    if (setup.kind.startsWith('BOUNCE') || setup.kind === 'SURGICAL') {
      kind = 'BOUNCE_SSL'
    }
  } else {
    const fib618 = swingLow + range * 0.618
    mid =
      swingHigh > price * 1.001
        ? swingHigh
        : fib618 > price * 1.001
          ? fib618
          : price * 1.006
    label = swingHigh > price * 1.001 ? 'BSL fresh' : 'Fib 0.618 fresh'
    if (setup.kind.startsWith('BOUNCE') || setup.kind === 'SURGICAL') {
      kind = 'BOUNCE_BSL'
    }
  }

  const band = zoneBand(mid, 0.0038)
  // Don't rebuild to almost the same place
  const oldMid = (setup.entryZone.top + setup.entryZone.bottom) / 2
  if (Math.abs(mid - oldMid) / price < 0.0015) return null

  const limitEntry = setup.side === 'LONG' ? band.bottom * 1.0005 : band.top * 0.9995
  const invalidation =
    setup.side === 'LONG' ? band.bottom * 0.996 : band.top * 1.004
  const risk = Math.abs(limitEntry - invalidation)
  const target =
    setup.side === 'LONG'
      ? limitEntry + Math.max(risk * 2.1, price * 0.008)
      : limitEntry - Math.max(risk * 2.1, price * 0.008)

  const distPct = ((mid - price) / price) * 100
  const probability = Math.round(
    Math.min(
      78,
      Math.max(
        42,
        52 +
          (Math.abs(distPct) < 0.8 ? 8 : 0) +
          (Math.abs(distPct) < 0.35 ? 4 : 0) -
          (Math.abs(distPct) > 1.5 ? 6 : 0)
      )
    )
  )

  const inZone = price >= band.bottom * 0.997 && price <= band.top * 1.003
  const preconditions = [
    {
      id: 'touch',
      label: `Касание зоны ${label}`,
      status: inZone ? 'MET' : 'PENDING',
    },
    { id: 'book', label: 'Стакан за отскок', status: 'PENDING' },
    { id: 'confirm', label: 'Реакция / reclaim', status: 'PENDING' },
  ]

  return {
    ...setup,
    kind,
    title: `↗ Отскок · ${label}`,
    probability,
    preconditions,
    entryZone: { top: band.top, bottom: band.bottom },
    limitEntry,
    target,
    invalidation,
    triggerSummary: `Обновлено 10м: лимит ${limitEntry.toPrecision(6)} → TP ${target.toPrecision(6)} · ~${probability}%`,
    reasoning: [
      'Уровни пересчитаны по свежим свингам 15m/1h',
      `Было далеко/устарело · новая дистанция ${distPct.toFixed(2)}%`,
      `SL @ ${invalidation.toPrecision(6)}`,
    ],
    status: inZone ? 'ARMED' : 'HYPOTHESIS',
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
    const [c1m, c15, c1h, c4h] = await Promise.all([
      fetchKlines(mexcSym, 'Min1', 60),
      fetchKlines(mexcSym, 'Min15', 64),
      fetchKlines(mexcSym, 'Min60', 60),
      fetchKlines(mexcSym, 'Hour4', 40),
    ])
    const price =
      c1m[c1m.length - 1]?.[4] ??
      c15[c15.length - 1]?.[4] ??
      c1h[c1h.length - 1]?.[4] ??
      0

    for (const w of watches) {
      let working = w

      // Every 10 min: rebuild stale pullback / wrong-geometry setups
      if (price && dueForLevelsRefresh(w, now)) {
        const staleReason = pullbackStaleReason(w.setup, price, c1m)
        // Also refresh bounce-like setups periodically even if not obviously stale,
        // when fresh swing moved ≥0.25% from old mid
        let reason = staleReason
        if (!reason && isBounceLike(w.setup)) {
          const swingSrc = c15.length >= 10 ? c15 : c1h
          const swing =
            w.setup.side === 'LONG'
              ? recentSwing(swingSrc, 'low')
              : recentSwing(swingSrc, 'high')
          const oldMid =
            (w.setup.entryZone.top + w.setup.entryZone.bottom) / 2
          if (
            swing != null &&
            Math.abs(swing - oldMid) / price >= 0.0025
          ) {
            reason = 'структура сдвинулась — новая зона ликвидности'
          }
        }

        if (reason) {
          const rebuilt = rebuildPullbackSetup(w.setup, price, c15, c1h)
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
        }
      } else {
        snap = evaluateWatchSnapshot(
          working.setup,
          price,
          c1m,
          c1h,
          c4h
        )
      }

      const status = snap.status
      const updated: WatchedSetupRecord = {
        ...working,
        lastStatus: status,
        setup: {
          ...working.setup,
          status,
          preconditions: snap.preconditions,
        },
        updatedAt: Date.now(),
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

    alerts.push({
      chatId,
      title: `📡 Мониторинг · ${blocks.length}/${watches.length}`,
      text: [
        `Отчёт каждые 5 мин · ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
        `Сводка: READY ${ready} · ARMED ${armed} · HYPOTHESIS ${hyp} · всего ${watches.length}`,
        `Уровни зон пересчитываются каждые 10 мин при устаревании отката.`,
        '',
        ...blocks.flatMap((block, i) =>
          i < blocks.length - 1 ? [block, '────────'] : [block]
        ),
        '',
        'READY → лимит · ARMED → жди confirm · 🔄 зона обновлена · ⛔ INVALIDATED.',
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
