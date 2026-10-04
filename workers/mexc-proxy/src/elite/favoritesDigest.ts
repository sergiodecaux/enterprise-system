import { getMarketContext } from '../marketContext'
import { fetchTickers } from '../vane/mexc'
import type { VaneKv } from '../vane/types'
import { loadCoinRow, type CoinBriefRow } from './briefing'
import {
  digestSlot,
  type FavoriteRecord,
  type FavKv,
  listFavoriteRecords,
  unionFavoriteSymbols,
  wasUrgentRecent,
} from './favorites'

function fmtPx(n: number): string {
  if (!(n > 0)) return '—'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toPrecision(4)
}

function fmtChg(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function ideaHint(row: CoinBriefRow): string | null {
  const idea = row.scalpIdea ?? row.intraIdea
  if (!idea) return null
  if (idea.includes('TOUCH')) return 'зона TOUCH'
  if (idea.includes('APPROACH')) return 'подход к зоне'
  return null
}

export function hasLiveSetupIdea(row: CoinBriefRow): boolean {
  const idea = row.scalpIdea ?? row.intraIdea
  if (!idea) return false
  return idea.includes('TOUCH') || idea.includes('READY')
}

export async function loadFavoriteMarketRows(
  symbols: string[],
  kv?: VaneKv
): Promise<Map<string, CoinBriefRow>> {
  const map = new Map<string, CoinBriefRow>()
  if (!symbols.length) return map
  const [mctx, tickers] = await Promise.all([getMarketContext(), fetchTickers()])
  const bySym = new Map(tickers.map((t) => [t.symbol, t]))
  for (const symbol of symbols) {
    try {
      const row = await loadCoinRow(symbol, bySym.get(symbol), kv, mctx, 'hourly')
      if (row) map.set(symbol, row)
    } catch (err) {
      console.error('[favdigest] row failed', symbol, err)
    }
  }
  return map
}

export async function formatChatDigestHtml(
  record: FavoriteRecord,
  rows: Map<string, CoinBriefRow>,
  chatId: number,
  now = Date.now()
): Promise<string | null> {
  if (!record.digestOn || record.symbols.length === 0) return null
  const when = new Date(now).toISOString().replace('T', ' ').slice(11, 16)
  const lines: string[] = [`⭐ <b>Избранное · ${when} UTC</b>`]
  let any = false
  for (const symbol of record.symbols) {
    const row = rows.get(symbol)
    if (!row) continue
    any = true
    const urgent = await wasUrgentRecent(chatId, symbol)
    const hint = urgent ? 'см. алерт' : ideaHint(row)
    const px = `${fmtPx(row.price)} · Δ15м ${fmtChg(row.chg15)} · Δ24ч ${fmtChg(row.chg24)}`
    const bias = `4H ${row.bias4h}`
    lines.push(
      `<b>${row.base}</b> ${px} · ${bias}${hint ? ` · ${hint}` : ''}`
    )
  }
  if (!any) return null
  lines.push('', '/digest_off · /fav')
  return lines.join('\n')
}

export async function runFavoritesDigest(opts: {
  kv?: FavKv & VaneKv
  chatIds: number[]
  now?: number
  send: (chatId: number, html: string) => Promise<boolean>
  alreadySent?: (chatId: number, slot: string) => Promise<boolean>
  markSent?: (chatId: number, slot: string) => Promise<void>
}): Promise<{ sent: number; skipped: number; symbols: number }> {
  const now = opts.now ?? Date.now()
  const slot = digestSlot(now)
  const rows = await listFavoriteRecords(opts.kv, opts.chatIds)
  const digestRows = rows.filter((r) => r.record.digestOn)
  if (!digestRows.length) return { sent: 0, skipped: 0, symbols: 0 }

  const symbols = unionFavoriteSymbols(digestRows)
  const market = await loadFavoriteMarketRows(symbols, opts.kv)
  let sent = 0
  let skipped = 0

  for (const { chatId, record } of digestRows) {
    if (opts.alreadySent && (await opts.alreadySent(chatId, slot))) {
      skipped++
      continue
    }
    const html = await formatChatDigestHtml(record, market, chatId, now)
    if (!html) {
      skipped++
      continue
    }
    const ok = await opts.send(chatId, html)
    if (ok) {
      sent++
      if (opts.markSent) await opts.markSent(chatId, slot)
    } else {
      skipped++
    }
  }

  return { sent, skipped, symbols: symbols.length }
}
