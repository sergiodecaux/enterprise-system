/**
 * Movement potential while price chops / fails to break a zone.
 * Combines compression, failed breaks, HTF, RS, book, magnet/ladder.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

export interface MovePotential {
  chopping: boolean
  failedBreaks: number
  compressionPct: number
  coilScore: number
  /** Preferred expansion side from chop context */
  bias: Side | 'NEUTRAL'
  /** Estimated move to primary magnet / 2R, % */
  potentialPct: number
  targetPrice: number
  targetLabel: string
  /** Cascade reach probs given expansion fires */
  pReach1: number
  pReach2: number
  pReach3: number
  summary: string
  lines: string[]
}

function atrPct(candles: Candle[], n = 14): number {
  if (candles.length < n + 1) return 0
  const slice = candles.slice(-(n + 1))
  let sum = 0
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]![4]
    const [, , h, l] = slice[i]!
    const tr = Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev))
    sum += tr
  }
  const atr = sum / n
  const px = slice[slice.length - 1]![4]
  return px > 0 ? (atr / px) * 100 : 0
}

function countFailedBreaks(
  candles: Candle[],
  zoneLow: number,
  zoneHigh: number,
  side: Side
): number {
  const closed = candles.slice(0, -1).slice(-24)
  let n = 0
  for (const c of closed) {
    const [, , high, low, close] = c
    if (side === 'SHORT') {
      // Tried above zone / mid, closed back below
      if (high > zoneHigh * 1.0008 && close < zoneHigh * 0.9995) n++
      else if (
        high > (zoneLow + zoneHigh) / 2 &&
        close < (zoneLow + zoneHigh) / 2 &&
        low <= zoneHigh
      ) {
        n++
      }
    } else {
      if (low < zoneLow * 0.9992 && close > zoneLow * 1.0005) n++
      else if (
        low < (zoneLow + zoneHigh) / 2 &&
        close > (zoneLow + zoneHigh) / 2 &&
        high >= zoneLow
      ) {
        n++
      }
    }
  }
  return Math.min(n, 8)
}

function nearZoneTouches(
  candles: Candle[],
  zoneLow: number,
  zoneHigh: number
): number {
  const closed = candles.slice(0, -1).slice(-30)
  let n = 0
  for (const c of closed) {
    const [, , high, low] = c
    if (low <= zoneHigh * 1.003 && high >= zoneLow * 0.997) n++
  }
  return n
}

export function estimateMovePotential(opts: {
  side: Side
  price: number
  zoneLow: number
  zoneHigh: number
  invalidation: number
  target?: number
  ladder?: {
    r1: number
    r2: number
    r3: number
    pReach1: number
    pReach2: number
    pReach3: number
  } | null
  magnet?: { price: number; label: string } | null
  candles1m: Candle[]
  candles15m: Candle[]
  candles1h: Candle[]
  htfScore?: number
  btcRs?: number | null
  bookImb?: number | null
  bookOk?: boolean
  acceptanceOk?: boolean
  structureOk?: boolean
}): MovePotential {
  const {
    side,
    price,
    zoneLow,
    zoneHigh,
    ladder,
    magnet,
  } = opts
  const lines: string[] = []

  const atr1h = atrPct(opts.candles1h, 14)
  const atr15 = atrPct(opts.candles15m, 14)
  const atr1m = atrPct(opts.candles1m, 20)
  // Compression: recent 15m ATR small vs 1h ATR
  const compressionPct =
    atr1h > 0 ? Math.max(0, Math.min(100, (1 - atr15 / atr1h) * 100)) : 0
  const tightChop = atr15 > 0 && atr15 < Math.max(0.35, atr1h * 0.55)

  const failedBreaks = countFailedBreaks(
    opts.candles15m.length >= 20 ? opts.candles15m : opts.candles1m,
    zoneLow,
    zoneHigh,
    side
  )
  const touches = nearZoneTouches(
    opts.candles15m.length >= 20 ? opts.candles15m : opts.candles1m,
    zoneLow,
    zoneHigh
  )
  const mid = (zoneLow + zoneHigh) / 2
  const distToZone = Math.abs((price - mid) / Math.max(price, 1e-9)) * 100
  const near = distToZone < 1.2 || opts.acceptanceOk === true

  const chopping =
    near && (tightChop || compressionPct >= 25 || (touches >= 4 && atr1m < 0.45))

  let coilScore = 0
  if (chopping) coilScore += 3
  if (compressionPct >= 35) coilScore += 2
  if (failedBreaks >= 2) coilScore += 3
  else if (failedBreaks === 1) coilScore += 1
  if (touches >= 5) coilScore += 2
  if (opts.acceptanceOk) coilScore += 1
  if (opts.bookOk) coilScore += 1
  if ((opts.htfScore ?? 0) >= 1) coilScore += 2
  if ((opts.htfScore ?? 0) <= -3) coilScore -= 2
  if (opts.structureOk === false) coilScore -= 3

  // RS alignment
  const rs = opts.btcRs
  if (rs != null) {
    if (side === 'SHORT' && rs <= -2) coilScore += 1
    if (side === 'SHORT' && rs >= 4) coilScore -= 2
    if (side === 'LONG' && rs >= 2) coilScore += 1
    if (side === 'LONG' && rs <= -4) coilScore -= 2
  }

  // Book
  const imb = opts.bookImb
  if (imb != null) {
    if (side === 'SHORT' && imb <= -12) coilScore += 1
    if (side === 'SHORT' && imb >= 18) coilScore -= 1
    if (side === 'LONG' && imb >= 12) coilScore += 1
    if (side === 'LONG' && imb <= -18) coilScore -= 1
  }

  // Target selection: magnet → ladder r2 → setup target → ATR flight
  let targetPrice =
    magnet?.price && magnet.price > 0
      ? magnet.price
      : ladder?.r2 ?? opts.target ?? 0
  let targetLabel = magnet?.label
    ? `магнит ${magnet.label}`
    : ladder
      ? '2R лестницы'
      : 'цель сетапа'

  if (!(targetPrice > 0) || (side === 'LONG' && targetPrice <= price) || (side === 'SHORT' && targetPrice >= price)) {
    const flight = price * (atr1h > 0 ? atr1h * 0.01 * 2.2 : 0.012)
    targetPrice = side === 'LONG' ? price + flight : price - flight
    targetLabel = '~2.2×ATR(1H)'
  }

  // If ladder r3 / magnet farther and coil high — prefer farther magnet
  if (ladder && magnet?.price) {
    const magAligned =
      (side === 'LONG' && magnet.price > price) ||
      (side === 'SHORT' && magnet.price < price)
    if (magAligned && coilScore >= 5) {
      targetPrice = magnet.price
      targetLabel = `магнит ${magnet.label}`
    }
  }

  const potentialPct = Math.abs(((targetPrice - price) / price) * 100)

  // Reach probs: base from ladder, boost when coiled failed-break
  let p1 = ladder?.pReach1 ?? 55
  let p2 = ladder?.pReach2 ?? 38
  let p3 = ladder?.pReach3 ?? 22
  if (chopping && failedBreaks >= 2) {
    p1 = Math.min(88, p1 + 8)
    p2 = Math.min(72, p2 + 10)
    p3 = Math.min(55, p3 + 8)
    lines.push(
      `топчется у зоны · ${failedBreaks}× неудачный пробой — сжатие, потенциал разжатия`
    )
  } else if (chopping) {
    p1 = Math.min(82, p1 + 4)
    p2 = Math.min(65, p2 + 5)
    lines.push('цена в сжатии у зоны — ждём выбор стороны')
  }
  if ((opts.htfScore ?? 0) >= 2) {
    p2 = Math.min(75, p2 + 4)
    lines.push('HTF за сторону — потенциал полёта выше')
  } else if ((opts.htfScore ?? 0) <= -3) {
    p1 = Math.max(20, p1 - 8)
    p2 = Math.max(12, p2 - 10)
    lines.push('HTF против — потенциал урезан')
  }
  if (opts.bookOk) {
    p1 = Math.min(90, p1 + 3)
    lines.push('стакан подпитывает сторону')
  }

  let bias: Side | 'NEUTRAL' = 'NEUTRAL'
  if (coilScore >= 4 && (opts.htfScore ?? 0) >= 0) bias = side
  else if (failedBreaks >= 2 && chopping) bias = side
  else if ((opts.htfScore ?? 0) <= -3) bias = side === 'LONG' ? 'SHORT' : 'LONG'

  const summary = chopping
    ? `Сжатие: ${failedBreaks}× fail-break · coil ${coilScore}/12 · потенциал ~${potentialPct.toFixed(2)}% → ${targetLabel} @ ${targetPrice > 1000 ? targetPrice.toFixed(2) : targetPrice.toPrecision(6)} (1R~${Math.round(p1)}% 2R~${Math.round(p2)}% 3R~${Math.round(p3)}%)`
    : `Потенциал хода ~${potentialPct.toFixed(2)}% → ${targetLabel} · coil ${coilScore}/12`

  if (touches >= 3) {
    lines.push(`${touches} касаний зоны за ~30 баров`)
  }
  if (compressionPct >= 25) {
    lines.push(`волатильность сжата (~${compressionPct.toFixed(0)}% vs ATR 1H)`)
  }

  return {
    chopping,
    failedBreaks,
    compressionPct,
    coilScore: Math.max(0, Math.min(12, coilScore)),
    bias,
    potentialPct,
    targetPrice,
    targetLabel,
    pReach1: Math.round(p1),
    pReach2: Math.round(p2),
    pReach3: Math.round(p3),
    summary,
    lines: lines.slice(0, 5),
  }
}
