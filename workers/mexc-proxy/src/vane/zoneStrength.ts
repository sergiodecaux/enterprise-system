import { mexcJson } from './mexc'
import {
  WALL_PERSIST_MS,
  type Candle,
  type Side,
  type VaneKv,
  type ZoneGrade,
  VANE_WALL_PREFIX,
} from './types'

interface DepthLevel {
  price: number
  vol: number
}

export interface ZoneStrengthResult {
  grade: ZoneGrade
  bidAskRatio: number
  obiPct: number | null
  wallPersistMs: number
  absorption: boolean
  cvdConfirm: boolean
  greenDeltaWeak: boolean
  notes: string[]
}

function parseLevels(
  rows: [number, number, number][] | undefined,
  n = 15
): DepthLevel[] {
  if (!rows?.length) return []
  return rows.slice(0, n).map((r) => ({
    price: Number(r[0]),
    vol: Number(r[1] ?? 0),
  }))
}

function sumVol(levels: DepthLevel[]): number {
  return levels.reduce((s, l) => s + l.vol, 0)
}

function cvdFromDeals(
  deals: Array<{ p: number; v: number; T?: number }> | undefined
): { cvd: number; buyVol: number; sellVol: number } {
  let buyVol = 0
  let sellVol = 0
  for (const d of deals ?? []) {
    const v = Number(d.v ?? 0)
    // MEXC: T=1 buy, T=2 sell (common contract deals)
    if (d.T === 2) sellVol += v
    else buyVol += v
  }
  return { cvd: buyVol - sellVol, buyVol, sellVol }
}

interface WallSnap {
  side: 'BID' | 'ASK'
  price: number
  vol: number
  firstSeenAt: number
  lastSeenAt: number
}

async function loadWall(
  kv: VaneKv | undefined,
  symbol: string
): Promise<WallSnap | null> {
  if (!kv) return null
  const raw = await kv.get(VANE_WALL_PREFIX + symbol)
  if (!raw) return null
  try {
    return JSON.parse(raw) as WallSnap
  } catch {
    return null
  }
}

async function saveWall(
  kv: VaneKv | undefined,
  symbol: string,
  wall: WallSnap
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(VANE_WALL_PREFIX + symbol, JSON.stringify(wall))
  } catch {
    /* quota */
  }
}

function candleAbsorption(candles1m: Candle[], side: Side): boolean {
  const recent = candles1m.slice(-8)
  if (recent.length < 4) return false
  let avg = 0
  for (const c of recent.slice(0, -3)) avg += c[5]
  avg /= Math.max(1, recent.length - 3)
  if (!(avg > 0)) return false
  for (const c of recent.slice(-3)) {
    const [, o, h, l, close, v] = c
    const range = h - l
    if (!(range > 0) || v < avg * 2.2) continue
    const body = Math.abs(close - o) / range
    if (body > 0.4) continue
    if (side === 'LONG' && (Math.min(o, close) - l) / range >= 0.45) return true
    if (side === 'SHORT' && (h - Math.max(o, close)) / range >= 0.45) return true
  }
  return false
}

/**
 * Grade zone as STRONG (hold) vs WEAK (break/flip) using book + CVD + wall age.
 */
export async function assessZoneStrength(opts: {
  symbol: string
  side: Side
  mid: number
  candles1m: Candle[]
  kv?: VaneKv
}): Promise<ZoneStrengthResult> {
  const notes: string[] = []
  const path = `/api/v1/contract/depth/${opts.symbol}?limit=20`
  const [depth, dealsJson] = await Promise.all([
    mexcJson<{
      data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
    }>(path),
    mexcJson<{
      data?: Array<{ p: number; v: number; T?: number }>
    }>(`/api/v1/contract/deals/${opts.symbol}?limit=50`),
  ])

  const asks = parseLevels(depth?.data?.asks)
  const bids = parseLevels(depth?.data?.bids)
  if (!asks.length || !bids.length) {
    return {
      grade: 'NEUTRAL',
      bidAskRatio: 1,
      obiPct: null,
      wallPersistMs: 0,
      absorption: false,
      cvdConfirm: false,
      greenDeltaWeak: true,
      notes: ['Стакан: нет данных'],
    }
  }

  const bidVol = sumVol(bids)
  const askVol = sumVol(asks)
  const total = bidVol + askVol
  const obiPct = total > 0 ? ((bidVol - askVol) / total) * 100 : null
  const bidAskRatio =
    opts.side === 'LONG'
      ? askVol > 0
        ? bidVol / askVol
        : 99
      : bidVol > 0
        ? askVol / bidVol
        : 99

  // Track dominant wall near mid for persistence
  const now = Date.now()
  const wallSide: 'BID' | 'ASK' = opts.side === 'LONG' ? 'BID' : 'ASK'
  const wallLevels = wallSide === 'BID' ? bids : asks
  const fat = [...wallLevels].sort((a, b) => b.vol - a.vol)[0]
  let wallPersistMs = 0
  if (fat && opts.mid > 0) {
    const near = Math.abs(fat.price - opts.mid) / opts.mid < 0.004
    if (near) {
      const prev = await loadWall(opts.kv, opts.symbol)
      if (
        prev &&
        prev.side === wallSide &&
        Math.abs(prev.price - fat.price) / fat.price < 0.0015 &&
        fat.vol >= prev.vol * 0.55
      ) {
        wallPersistMs = now - prev.firstSeenAt
        await saveWall(opts.kv, opts.symbol, {
          ...prev,
          vol: fat.vol,
          lastSeenAt: now,
        })
      } else {
        await saveWall(opts.kv, opts.symbol, {
          side: wallSide,
          price: fat.price,
          vol: fat.vol,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        wallPersistMs = 0
      }
    }
  }

  const { cvd, buyVol, sellVol } = cvdFromDeals(dealsJson?.data)
  const absorption = candleAbsorption(opts.candles1m, opts.side)
  const cvdConfirm =
    opts.side === 'LONG'
      ? cvd > 0 && sellVol > buyVol * 0.35 // selling into bids but CVD holds/up
      : cvd < 0 && buyVol > sellVol * 0.35
  const greenDeltaWeak = buyVol < sellVol * 0.35

  // Spoof: wall vanished vs previous snapshot
  const prevWall = await loadWall(opts.kv, opts.symbol)
  let spoofed = false
  if (prevWall && now - prevWall.lastSeenAt < 5_000) {
    const still =
      wallLevels.find(
        (l) => Math.abs(l.price - prevWall.price) / prevWall.price < 0.0012
      )?.vol ?? 0
    if (still < prevWall.vol * 0.35 && prevWall.vol > 0) {
      spoofed = true
      notes.push('Spoof: стенка снята (<35% объёма) — не доверяем плотности')
    }
  }

  const persistOk = wallPersistMs >= WALL_PERSIST_MS
  const densityOk = bidAskRatio >= 1.8
  const obiOk =
    (opts.side === 'LONG' && (obiPct ?? 0) >= 8) ||
    (opts.side === 'SHORT' && (obiPct ?? 0) <= -8)

  let grade: ZoneGrade = 'NEUTRAL'
  // STRONG: density + (persist OR tape confirm) + OBI — not all-and-persist-12s
  if (
    !spoofed &&
    densityOk &&
    obiOk &&
    (persistOk || absorption || cvdConfirm)
  ) {
    grade = 'STRONG'
    notes.push(
      `STRONG: density×${bidAskRatio.toFixed(1)} · wall ${Math.round(wallPersistMs / 1000)}с · abs=${absorption} cvd=${cvdConfirm}`
    )
  } else if (
    spoofed ||
    bidAskRatio < 1.05 ||
    (opts.side === 'LONG' && greenDeltaWeak && (obiPct ?? 0) < -8) ||
    (opts.side === 'SHORT' && buyVol > sellVol * 2.5 && (obiPct ?? 0) > 8)
  ) {
    grade = 'WEAK'
    notes.push(
      `WEAK: density×${bidAskRatio.toFixed(1)} · bids разъедены/спуф · CVD ${cvd.toFixed(0)}`
    )
  } else {
    notes.push(
      `NEUTRAL: density×${bidAskRatio.toFixed(1)} · wall ${Math.round(wallPersistMs / 1000)}с · OBI ${obiPct?.toFixed(0) ?? 'n/a'}`
    )
  }

  return {
    grade,
    bidAskRatio,
    obiPct,
    wallPersistMs,
    absorption,
    cvdConfirm,
    greenDeltaWeak,
    notes,
  }
}
