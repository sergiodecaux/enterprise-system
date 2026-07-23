/**
 * Lightweight spoof / iceberg heuristics for the Worker scanner.
 * Portable (no imports from frontend src).
 */

type Side = 'LONG' | 'SHORT'

export interface ToxicityResult {
  /** Hard veto — skip signal */
  toxic: boolean
  /** Soft warning lines for alert extras */
  notes: string[]
  scorePenalty: number
}

interface DepthLevel {
  price: number
  vol: number
}

function parseLevels(
  rows: [number, number, number][] | undefined,
  n = 12
): DepthLevel[] {
  if (!rows?.length) return []
  return rows.slice(0, n).map((r) => ({
    price: Number(r[0]),
    vol: Number(r[1] ?? 0),
  }))
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * Two depth snapshots ~350ms apart + recent deals.
 * Spoof: fat wall shrinks hard without being traded through.
 * Iceberg: heavy tape at a price while book barely shrinks.
 */
export async function assessBookToxicity(opts: {
  symbol: string
  side: Side
  mid: number
  mexcJson: <T>(path: string) => Promise<T | null>
}): Promise<ToxicityResult> {
  const notes: string[] = []
  let scorePenalty = 0
  let toxic = false

  const path = `/api/v1/contract/depth/${opts.symbol}?limit=20`
  const snap1 = await opts.mexcJson<{
    data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
  }>(path)
  await new Promise((r) => setTimeout(r, 350))
  const [snap2, deals] = await Promise.all([
    opts.mexcJson<{
      data?: { asks?: [number, number, number][]; bids?: [number, number, number][] }
    }>(path),
    opts.mexcJson<{
      data?: Array<{ p: number; v: number; T?: number }>
    }>(`/api/v1/contract/deals/${opts.symbol}?limit=40`),
  ])

  const asks1 = parseLevels(snap1?.data?.asks)
  const bids1 = parseLevels(snap1?.data?.bids)
  const asks2 = parseLevels(snap2?.data?.asks)
  const bids2 = parseLevels(snap2?.data?.bids)
  if (!asks1.length || !bids1.length || !asks2.length || !bids2.length) {
    return { toxic: false, notes: ['Стакан: нет данных для spoof/iceberg'], scorePenalty: 0 }
  }

  const mid = opts.mid
  const askVols = asks1.map((l) => l.vol)
  const bidVols = bids1.map((l) => l.vol)
  const medAsk = median(askVols) || 1
  const medBid = median(bidVols) || 1

  // Spoof: large wall disappears (>65% vol) within 350ms near mid
  const checkSpoof = (
    before: DepthLevel[],
    after: DepthLevel[],
    wallSide: 'ASK' | 'BID',
    med: number
  ) => {
    for (const b of before) {
      if (b.vol < med * 3.5) continue
      const distPct = (Math.abs(b.price - mid) / mid) * 100
      if (distPct > 0.35) continue
      const a = after.find((x) => Math.abs(x.price - b.price) / mid < 0.0004)
      const left = a?.vol ?? 0
      const dropped = b.vol > 0 ? (b.vol - left) / b.vol : 0
      if (dropped >= 0.65) {
        // Wall vanished — spoof if our side would lean on it
        const spoofAgainstLong = wallSide === 'BID' // fake support
        const spoofAgainstShort = wallSide === 'ASK' // fake resistance
        if (
          (opts.side === 'LONG' && spoofAgainstLong) ||
          (opts.side === 'SHORT' && spoofAgainstShort)
        ) {
          toxic = true
          notes.push(
            `👻 SPOOF: ${wallSide} wall @ ${b.price} исчезла ${(dropped * 100).toFixed(0)}% за ~0.3с`
          )
          scorePenalty += 18
        } else {
          notes.push(
            `👻 Стена ${wallSide} исчезла (${(dropped * 100).toFixed(0)}%) — осторожно`
          )
          scorePenalty += 6
        }
      }
    }
  }

  checkSpoof(asks1, asks2, 'ASK', medAsk)
  checkSpoof(bids1, bids2, 'BID', medBid)

  // Iceberg: tape volume at price >> book decrease
  const rows = deals?.data ?? []
  if (rows.length >= 8) {
    let buyVol = 0
    let sellVol = 0
    const pxBuckets = new Map<string, number>()
    for (const d of rows) {
      const px = Number(d.p)
      const vol = Number(d.v ?? 0)
      if (!(px > 0) || !(vol > 0)) continue
      const key = px.toPrecision(6)
      pxBuckets.set(key, (pxBuckets.get(key) ?? 0) + vol)
      const t = d.T
      if (t === 1) buyVol += vol
      else if (t === 2) sellVol += vol
    }
    let topPx = mid
    let topVol = 0
    for (const [k, v] of pxBuckets) {
      if (v > topVol) {
        topVol = v
        topPx = Number(k)
      }
    }
    const nearAsk1 = asks1.find((l) => Math.abs(l.price - topPx) / mid < 0.0008)
    const nearAsk2 = asks2.find((l) => Math.abs(l.price - topPx) / mid < 0.0008)
    const nearBid1 = bids1.find((l) => Math.abs(l.price - topPx) / mid < 0.0008)
    const nearBid2 = bids2.find((l) => Math.abs(l.price - topPx) / mid < 0.0008)

    if (buyVol > sellVol * 1.4 && nearAsk1 && topVol > medAsk * 2) {
      const bookDrop = Math.max(0, nearAsk1.vol - (nearAsk2?.vol ?? nearAsk1.vol))
      if (topVol > bookDrop * 2.2 && bookDrop / topVol < 0.45) {
        notes.push(
          `🧊 ICEBERG ASK @ ${topPx.toPrecision(6)} — лента ест, стакан почти не тает`
        )
        if (opts.side === 'LONG') {
          scorePenalty += 10
          // Hitting hidden ask supply into long pump — soft veto if also spoofy
          if (toxic) scorePenalty += 4
        }
      }
    }
    if (sellVol > buyVol * 1.4 && nearBid1 && topVol > medBid * 2) {
      const bookDrop = Math.max(0, nearBid1.vol - (nearBid2?.vol ?? nearBid1.vol))
      if (topVol > bookDrop * 2.2 && bookDrop / topVol < 0.45) {
        notes.push(
          `🧊 ICEBERG BID @ ${topPx.toPrecision(6)} — скрытая поддержка/раздача`
        )
        if (opts.side === 'SHORT') {
          scorePenalty += 10
        }
      }
    }
  }

  return { toxic, notes: notes.slice(0, 3), scorePenalty }
}
