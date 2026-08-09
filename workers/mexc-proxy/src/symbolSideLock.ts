/**
 * Prevent Predator SHORT and Elite LONG on the same meme within a window.
 * Autopsy: LIGHT/COOKIE/BTW fired opposite sides → user sees «same deal» on both bots,
 * and one side is usually the toxic tip-chase.
 */

const LOCK_PREFIX = 'telegram:symbol_side_lock_v1:'
const LOCK_MS = 75 * 60_000

export type LockSide = 'LONG' | 'SHORT'

interface LockRec {
  side: LockSide
  setup: string
  at: number
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

export async function isSymbolSideBlocked(
  kv: KvLike | undefined,
  symbol: string,
  side: LockSide
): Promise<{ blocked: boolean; reason?: string }> {
  if (!kv) return { blocked: false }
  try {
    const raw = await kv.get(LOCK_PREFIX + symbol)
    if (!raw) return { blocked: false }
    const rec = JSON.parse(raw) as LockRec
    if (!rec?.side || !rec.at) return { blocked: false }
    if (Date.now() - rec.at > LOCK_MS) return { blocked: false }
    if (rec.side === side) return { blocked: false }
    return {
      blocked: true,
      reason: `conflict_${rec.side}_${rec.setup}`,
    }
  } catch {
    return { blocked: false }
  }
}

export async function markSymbolSideLock(
  kv: KvLike | undefined,
  symbol: string,
  side: LockSide,
  setup: string
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(
      LOCK_PREFIX + symbol,
      JSON.stringify({ side, setup, at: Date.now() } satisfies LockRec)
    )
  } catch {
    /* ignore */
  }
}
