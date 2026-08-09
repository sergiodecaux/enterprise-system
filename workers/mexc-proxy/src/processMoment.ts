/**
 * Thin Remizov-style "МОМЕНТ" detector for watched Elite symbols.
 * Reuses orderBookReader (absorption / CVD / wall-release) — no full FrameBus in KV.
 * Runs on paper cron with a hard symbol budget (CF subrequests).
 */

import {
  readOrderBookEvent,
  type OrderBookSnapshot,
} from './orderBookReader'

const STATE_KEY = 'scanner:process_moment_book_v1'
const DEDUP_PREFIX = 'process:moment:dedup:'
const MAX_SYMBOLS = 3
const MIN_CONF = 78
const DEDUP_MS = 25 * 60_000

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>
}

type BookState = Record<
  string,
  { previous?: OrderBookSnapshot | null; older?: OrderBookSnapshot | null }
>

export interface ProcessMomentAlert {
  symbol: string
  displayName: string
  side: 'LONG' | 'SHORT'
  kind: string
  confidence: number
  title: string
  text: string
  dedupeKey: string
  chatId?: number
}

async function mexcJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://contract.mexc.com${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'EnterpriseProcessMoment/1.0',
      },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function loadState(kv?: KvLike): Promise<BookState> {
  if (!kv) return {}
  try {
    const raw = await kv.get(STATE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as BookState
  } catch {
    return {}
  }
}

async function saveState(kv: KvLike | undefined, state: BookState): Promise<void> {
  if (!kv) return
  try {
    await kv.put(STATE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function toMexc(sym: string): string {
  if (sym.includes('_')) return sym.toUpperCase()
  return `${sym.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_USDT`
}

function displayOf(sym: string): string {
  return sym.replace('_USDT', '/USDT')
}

/**
 * Scan up to MAX_SYMBOLS watched names for absorption / CVD / wall-release moments.
 */
export async function scanProcessMoments(opts: {
  kv?: KvLike
  /** Mexc symbols + optional chat routing */
  targets: Array<{ symbol: string; chatId?: number }>
}): Promise<ProcessMomentAlert[]> {
  const targets = opts.targets.slice(0, MAX_SYMBOLS)
  if (!targets.length) return []

  const state = await loadState(opts.kv)
  const out: ProcessMomentAlert[] = []

  for (const t of targets) {
    const symbol = toMexc(t.symbol)
    try {
      const dedupRaw = await opts.kv?.get(DEDUP_PREFIX + symbol)
      if (dedupRaw && Date.now() - Number(dedupRaw) < DEDUP_MS) continue

      const prev = state[symbol]?.previous ?? null
      const older = state[symbol]?.older ?? null
      const read = await readOrderBookEvent({
        symbol,
        previous: prev,
        older,
        allowLiveSequence: true,
        mexcJson,
      })
      if (read.snapshot) {
        state[symbol] = {
          older: prev,
          previous: read.snapshot,
        }
      }

      const ev = read.event
      if (!ev.ready || !ev.side) continue
      if (ev.kind === 'WASH_SKIP' || ev.kind === 'NO_EVENT' || ev.kind === 'CONFLICT') {
        continue
      }
      // Prefer fuel moments — skip toxic spoof (already filtered in reader)
      const usable =
        ev.kind === 'ABSORPTION_LONG' ||
        ev.kind === 'ABSORPTION_SHORT' ||
        ev.kind === 'CVD_DIVERGENCE' ||
        ev.kind === 'ASK_WALL_REMOVED' ||
        ev.kind === 'BID_WALL_REMOVED' ||
        ev.kind === 'BUY_FLOW_IMBALANCE' ||
        ev.kind === 'SELL_FLOW_IMBALANCE'
      if (!usable) continue
      if (ev.confidence < MIN_CONF) continue

      const side = ev.side
      const kind = ev.kind
      const title = `⚡ МОМЕНТ · ${displayOf(symbol)} · ${side}`
      const text = [
        `${kind} · conf ${ev.confidence}`,
        ev.notes.slice(0, 3).join('\n'),
        read.tape
          ? `Tape buy ${read.tape.buyFlowPct.toFixed(0)}% · move ${read.tape.priceMoveBps.toFixed(0)} bps`
          : null,
        '',
        'Источник: process moment (стакан+лента) · не meme PEAK/PUMP',
        'Открой Mini App → график для ProcessStrip / подтверждения.',
      ]
        .filter(Boolean)
        .join('\n')

      out.push({
        symbol,
        displayName: displayOf(symbol),
        side,
        kind,
        confidence: ev.confidence,
        title,
        text,
        dedupeKey: `process:moment:${symbol}:${kind}:${side}`,
        chatId: t.chatId,
      })

      try {
        await opts.kv?.put(DEDUP_PREFIX + symbol, String(Date.now()), {
          expirationTtl: Math.ceil(DEDUP_MS / 1000) + 60,
        })
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.error('[processMoment]', symbol, err)
    }
  }

  await saveState(opts.kv, state)
  return out
}
