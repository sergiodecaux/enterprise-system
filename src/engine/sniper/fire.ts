import type { CoinSignal, TradeStyle } from '../types'
import { getSniperSignals, type SniperSignal } from '../sniperMode'
import { recordSniperFire } from '../journal'

const STORAGE_KEY = 'enterprise_sniper_fired'
const MAX_TTL_MS = 72 * 60 * 60 * 1000
/** «NEW» badge window after a fire */
export const SNIPER_NEW_BADGE_MS = 15 * 60 * 1000

export type SniperFiredMap = Record<string, number>

let cache: SniperFiredMap | null = null

export function sniperFireKey(signal: {
  internalSymbol: string
  direction: string | null
  tradeStyle?: TradeStyle | string | null
}): string {
  return `${signal.internalSymbol}:${signal.direction ?? 'NONE'}:${signal.tradeStyle ?? 'INTRADAY'}`
}

export function sniperFireTtlMs(style?: string | null): number {
  if (style === 'SCALP') return 4 * 60 * 60 * 1000
  if (style === 'SWING') return 72 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function prune(map: SniperFiredMap): SniperFiredMap {
  const now = Date.now()
  const next: SniperFiredMap = {}
  for (const [key, at] of Object.entries(map)) {
    if (typeof at === 'number' && now - at < MAX_TTL_MS) next[key] = at
  }
  return next
}

function loadMap(): SniperFiredMap {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      cache = {}
      return cache
    }
    const parsed = JSON.parse(raw) as SniperFiredMap
    cache = prune(parsed && typeof parsed === 'object' ? parsed : {})
    return cache
  } catch {
    cache = {}
    return cache
  }
}

function persist(map: SniperFiredMap): void {
  cache = map
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* quota / private mode */
  }
}

export function getSniperFiredAt(key: string): number | null {
  const at = loadMap()[key]
  return typeof at === 'number' ? at : null
}

export function isSniperFireFresh(
  key: string,
  style?: string | null
): boolean {
  const at = getSniperFiredAt(key)
  if (at == null) return false
  return Date.now() - at < sniperFireTtlMs(style)
}

export function isSniperFireNew(key: string): boolean {
  const at = getSniperFiredAt(key)
  if (at == null) return false
  return Date.now() - at < SNIPER_NEW_BADGE_MS
}

export function markSniperFired(key: string, at = Date.now()): number {
  const map = { ...loadMap(), [key]: at }
  persist(map)
  return at
}

export interface SniperEmitResult {
  /** First-time journal rows — Telegram / «выброшен» */
  newly: SniperSignal[]
  /** Keys stamped this pass (new or already in journal) */
  markedKeys: string[]
}

/**
 * Emit durable journal rows for coins that just became sniper-quality.
 * `newly` is only first-time fires (not refreshes / already-recorded).
 */
export function emitSniperFires(signals: CoinSignal[]): SniperEmitResult {
  const snipers = getSniperSignals(signals)
  const newly: SniperSignal[] = []
  const markedKeys: string[] = []

  for (const signal of snipers) {
    if (!signal.direction) continue
    const key = sniperFireKey(signal)
    if (isSniperFireFresh(key, signal.tradeStyle)) continue

    const confidence =
      signal.calibratedWinRate || signal.styleConfidence || signal.probabilityPct
    const result = recordSniperFire(signal, confidence)
    markSniperFired(key)
    markedKeys.push(key)
    if (result?.isNew) newly.push(signal)
  }

  return { newly, markedKeys }
}
