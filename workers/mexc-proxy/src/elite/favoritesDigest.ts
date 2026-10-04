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
import { DIGEST_FOOTER, formatFavoriteCoinHtml } from './narrative'

export function hasLiveSetupIdea(row: CoinBriefRow): boolean {
  if (row.story?.phase === 'TOUCH' && row.story.align === 'WITH') return true
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
  const blocks: string[] = [`⭐ <b>Избранное</b> · ${when} UTC`]
  let any = false
  for (const symbol of record.symbols) {
    const row = rows.get(symbol)
    if (!row) continue
    any = true
    const urgent = await wasUrgentRecent(chatId, symbol)
    blocks.push('', formatFavoriteCoinHtml(row, { urgentRecent: urgent }))
  }
  if (!any) return null
  blocks.push('', DIGEST_FOOTER)
  return blocks.join('\n')
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
