import { kvPutThrottled } from '../kvWrite'
import { resolveMexcSymbol } from '../userZoneWatch'

export const FAV_LIMIT = 6
export const FAV_KEY_PREFIX = 'telegram:fav:'
export const URGENT_COOLDOWN_MS = 10 * 60_000

export interface FavoriteRecord {
  symbols: string[]
  digestOn: boolean
  urgentOn: boolean
  updatedAt: number
}

export interface FavKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

const memoryFav = new Map<string, FavoriteRecord>()
const memoryStamp = new Map<string, number>()

function favKey(chatId: number): string {
  return `${FAV_KEY_PREFIX}${chatId}`
}

function stampReq(key: string): Request {
  return new Request(
    `https://enterprise-system-runtime.invalid/fav/${encodeURIComponent(key)}`
  )
}

export function normalizeFavSymbol(raw: string): string | null {
  return resolveMexcSymbol(raw)
}

export function normalizeFavSymbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const sym = normalizeFavSymbol(item)
    if (!sym || seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
    if (out.length >= FAV_LIMIT) break
  }
  return out
}

export function sameFavList(a: FavoriteRecord, b: FavoriteRecord): boolean {
  if (a.digestOn !== b.digestOn || a.urgentOn !== b.urgentOn) return false
  if (a.symbols.length !== b.symbols.length) return false
  return a.symbols.every((s, i) => s === b.symbols[i])
}

function parseRecord(raw: string | null): FavoriteRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<FavoriteRecord>
    if (!parsed || !Array.isArray(parsed.symbols)) return null
    return {
      symbols: normalizeFavSymbols(parsed.symbols),
      digestOn: parsed.digestOn !== false,
      urgentOn: parsed.urgentOn !== false,
      updatedAt: Number(parsed.updatedAt) || 0,
    }
  } catch {
    return null
  }
}

export async function loadFavorites(
  kv: FavKv | undefined,
  chatId: number
): Promise<FavoriteRecord | null> {
  const key = favKey(chatId)
  const mem = memoryFav.get(key)
  if (kv) {
    try {
      const fromKv = parseRecord(await kv.get(key))
      if (fromKv) {
        memoryFav.set(key, fromKv)
        return fromKv
      }
    } catch {
      /* quota */
    }
  }
  return mem ?? null
}

export async function saveFavorites(
  kv: FavKv | undefined,
  chatId: number,
  next: FavoriteRecord
): Promise<{ written: boolean; record: FavoriteRecord }> {
  const record: FavoriteRecord = {
    symbols: normalizeFavSymbols(next.symbols),
    digestOn: next.digestOn !== false,
    urgentOn: next.urgentOn !== false,
    updatedAt: next.updatedAt || Date.now(),
  }
  const prev = await loadFavorites(kv, chatId)
  if (prev && sameFavList(prev, record)) {
    return { written: false, record: prev }
  }
  if (
    !prev &&
    record.symbols.length === 0 &&
    record.digestOn &&
    record.urgentOn
  ) {
    memoryFav.set(favKey(chatId), record)
    return { written: false, record }
  }
  const key = favKey(chatId)
  memoryFav.set(key, record)
  const body = JSON.stringify(record)
  if (kv) {
    const result = await kvPutThrottled(kv as never, key, body, 0, { force: true })
    return { written: result === 'written', record }
  }
  return { written: false, record }
}

export async function listFavoriteRecords(
  kv: FavKv | undefined,
  chatIds: number[]
): Promise<Array<{ chatId: number; record: FavoriteRecord }>> {
  const out: Array<{ chatId: number; record: FavoriteRecord }> = []
  for (const chatId of chatIds) {
    const record = await loadFavorites(kv, chatId)
    if (record && record.symbols.length) out.push({ chatId, record })
  }
  return out
}

export function unionFavoriteSymbols(
  rows: Array<{ record: FavoriteRecord }>
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    for (const s of row.record.symbols) {
      if (seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

export function recordHasSymbol(record: FavoriteRecord | null, symbol: string): boolean {
  if (!record) return false
  const norm = normalizeFavSymbol(symbol)
  if (!norm) return false
  return record.symbols.includes(norm)
}

export async function chatMonitorsSymbol(
  kv: FavKv | undefined,
  chatId: number,
  symbol: string,
  opts?: { requireFav?: boolean }
): Promise<boolean> {
  const record = await loadFavorites(kv, chatId)
  if (!record || record.symbols.length === 0) {
    return opts?.requireFav === true ? false : true
  }
  return recordHasSymbol(record, symbol)
}

export async function chatsWatchingSymbol(
  kv: FavKv | undefined,
  chatIds: number[],
  symbol: string,
  opts?: { urgentOnly?: boolean }
): Promise<number[]> {
  const norm = normalizeFavSymbol(symbol)
  if (!norm) return []
  const out: number[] = []
  for (const chatId of chatIds) {
    const record = await loadFavorites(kv, chatId)
    if (!record || !record.symbols.includes(norm)) continue
    if (opts?.urgentOnly && record.urgentOn === false) continue
    out.push(chatId)
  }
  return out
}

function urgentKey(chatId: number, symbol: string): string {
  return `telegram:urgent:${chatId}:${symbol}`
}

export async function markUrgentFired(
  kv: FavKv | undefined,
  chatId: number,
  symbol: string
): Promise<void> {
  const norm = normalizeFavSymbol(symbol) ?? symbol
  const key = urgentKey(chatId, norm)
  const at = Date.now()
  memoryStamp.set(key, at)
  try {
    await caches.default.put(
      stampReq(key),
      new Response(String(at), {
        headers: { 'Cache-Control': 'public, max-age=1800' },
      })
    )
  } catch {
    /* memory */
  }
  void kv
}

export async function wasUrgentRecent(
  chatId: number,
  symbol: string,
  windowMs = URGENT_COOLDOWN_MS
): Promise<boolean> {
  const norm = normalizeFavSymbol(symbol) ?? symbol
  const key = urgentKey(chatId, norm)
  const mem = memoryStamp.get(key)
  if (mem && Date.now() - mem < windowMs) return true
  try {
    const hit = await caches.default.match(stampReq(key))
    if (!hit) return false
    const at = Number(await hit.text())
    if (Number.isFinite(at) && Date.now() - at < windowMs) {
      memoryStamp.set(key, at)
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export function digestSlot(now = Date.now()): string {
  const d = new Date(now)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(Math.floor(d.getUTCMinutes() / 15) * 15).padStart(2, '0')
  const day = d.toISOString().slice(0, 10)
  return `${day}T${hh}${mm}`
}

export function formatFavListHtml(record: FavoriteRecord | null): string {
  if (!record || record.symbols.length === 0) {
    return [
      '<b>⭐ Избранное пусто</b>',
      'Поставь звезду в Mini App (макс. 6 монет).',
      'Это список, который Elite мониторит.',
      '',
      '/digest — сводка сейчас',
      '/digest_off — выключить 15-мин дайджест',
    ].join('\n')
  }
  const coins = record.symbols.map((s) => `• <code>${s.replace('_USDT', '')}</code>`).join('\n')
  return [
    `<b>⭐ Избранное (${record.symbols.length}/${FAV_LIMIT})</b>`,
    coins,
    '',
    `Дайджест 15 мин: <b>${record.digestOn ? 'вкл' : 'выкл'}</b>`,
    `Срочные алерты: <b>${record.urgentOn ? 'вкл' : 'выкл'}</b>`,
    '',
    '/digest · /digest_off · /fav BTC',
  ].join('\n')
}
