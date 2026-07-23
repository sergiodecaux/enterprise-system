import type { LiquidityMap, OrderBookMetrics, OrderBookWall } from '../types'
import type { WeightedObiResult } from './obi'
import type { PriceProddingResult } from './priceProdding'
import type { SpoofAlert } from './spoofing'
import type { IcebergResult } from './iceberg'

export type MmDriveDirection = 'UP' | 'DOWN' | 'NEUTRAL'

export interface LiquidityHuntLeg {
  /** Near magnet (micro move) */
  microTarget: number | null
  microLabel: string
  /** Far magnet after sweep (macro move) */
  macroTarget: number | null
  macroLabel: string
  /** First move is often AGAINST the eventual macro (stop hunt) */
  microIsStopHunt: boolean
}

export interface MmIntentResult {
  /** Where MM is driving price now */
  drive: MmDriveDirection
  /** Confidence 0–100 in drive reading */
  confidence: number
  /** Preferred trade side after hunt completes */
  preferredSide: 'LONG' | 'SHORT' | null
  /** Score nudge for PE (−2…+2) when side aligns */
  scoreBoostForLong: number
  scoreBoostForShort: number
  hunt: LiquidityHuntLeg
  reasons: string[]
  label: string
  emoji: string
  updatedAt: number
}

export interface MmIntentInput {
  price: number
  book?: OrderBookMetrics | null
  weightedObi?: WeightedObiResult | null
  prodding?: PriceProddingResult | null
  spoofAlerts?: SpoofAlert[]
  /** Iceberg fills that confirm hidden liquidity */
  icebergAlerts?: IcebergResult[]
  liquidityMap?: LiquidityMap | null
  /** Tape: buy share 0–100 */
  buyerAggressionPct?: number | null
  /** Short momentum % */
  momentumPct?: number | null
}

/**
 * Читает намерение маркет-мейкера:
 * - куда «гонит» цену (проdding / OBI / стены)
 * - где ликвидность (BSL сверху / SSL снизу)
 * - типичный путь: микро-ход за стопами → макро к противоположному магниту
 */
export function computeMmIntent(input: MmIntentInput): MmIntentResult {
  const reasons: string[] = []
  let upScore = 0
  let downScore = 0
  const price = input.price

  const bsl = input.liquidityMap?.nearestBSL ?? null
  const ssl = input.liquidityMap?.nearestSSL ?? null

  // ── Order book near-touch OBI ──────────────────────────────────────────
  const obi = input.weightedObi
  if (obi?.nearTouchPressure === 'BUY') {
    upScore += 2.2
    reasons.push(`OBI 0.1%: Bids давят вверх (${obi.impulseProbPct}%)`)
  } else if (obi?.nearTouchPressure === 'SELL') {
    downScore += 2.2
    reasons.push(`OBI 0.1%: Asks давят вниз (${obi.impulseProbPct}%)`)
  }

  const imb = input.book?.imbalance
  if (imb != null) {
    if (imb >= 20) {
      upScore += Math.min(1.5, imb / 40)
      reasons.push(`Стакан Bids ${imb.toFixed(0)}%`)
    } else if (imb <= -20) {
      downScore += Math.min(1.5, Math.abs(imb) / 40)
      reasons.push(`Стакан Asks ${Math.abs(imb).toFixed(0)}%`)
    }
  }

  // Walls: resting ask above = fuel for long squeeze INTO asks; bid below supports
  const walls = input.book?.walls ?? []
  const askWallsAbove = walls.filter(
    (w) => w.side === 'ASK' && w.price > price
  )
  const bidWallsBelow = walls.filter(
    (w) => w.side === 'BID' && w.price < price
  )
  if (bidWallsBelow.length && (!askWallsAbove.length || sumVol(bidWallsBelow) > sumVol(askWallsAbove) * 1.4)) {
    upScore += 1.2
    reasons.push('Плотность Bids под ценой — ММ держит пол')
  }
  if (askWallsAbove.length && (!bidWallsBelow.length || sumVol(askWallsAbove) > sumVol(bidWallsBelow) * 1.4)) {
    downScore += 1.2
    reasons.push('Плотность Asks над ценой — потолок ММ')
  }

  // ── Price prodding (MM herding) ────────────────────────────────────────
  const prod = input.prodding
  if (prod?.detected && prod.chasing) {
    if (prod.direction === 'UP') {
      upScore += 2.5
      reasons.push(prod.label || 'Prodding UP')
    } else if (prod.direction === 'DOWN') {
      downScore += 2.5
      reasons.push(prod.label || 'Prodding DOWN')
    }
  }
  if (prod?.exitSignal) {
    // Density flipped — mean-revert risk
    if (upScore > downScore) downScore += 1.5
    else upScore += 1.5
    reasons.push('Prodding сломан — риск разворота')
  }

  // ── Spoof: fleeing asks → wants UP; fleeing bids → wants DOWN ──────────
  for (const s of input.spoofAlerts ?? []) {
    if (!s.detected) continue
    if (s.side === 'ASK') {
      upScore += 1.8
      reasons.push('Spoof ASK убран — ММ пускает вверх')
    } else if (s.side === 'BID') {
      downScore += 1.8
      reasons.push('Spoof BID убран — ММ пускает вниз')
    }
  }

  // ── Iceberg: hidden ask = resistance (DOWN); hidden bid = support (UP) ─
  for (const ice of input.icebergAlerts ?? []) {
    if (!ice.detected) continue
    if (ice.side === 'ASK') {
      downScore += 1.4
      reasons.push(ice.label || 'Iceberg ASK — скрытое сопротивление')
    } else if (ice.side === 'BID') {
      upScore += 1.4
      reasons.push(ice.label || 'Iceberg BID — скрытая поддержка')
    }
  }

  // ── Aggression without result already handled elsewhere; light nudge ───
  const buyPct = input.buyerAggressionPct
  if (buyPct != null) {
    if (buyPct >= 75 && (input.momentumPct ?? 0) < 0.3) {
      downScore += 1.5
      reasons.push('Абсорбция покупок — скрытый селл ММ')
    } else if (buyPct <= 25 && (input.momentumPct ?? 0) > -0.3) {
      upScore += 1.5
      reasons.push('Абсорбция продаж — скрытый бай ММ')
    }
  }

  // ── Liquidity magnets (where price WANTS to go) ───────────────────────
  // Classic MM: run stops on one side, then drive to opposite liquidity
  let hunt: LiquidityHuntLeg = {
    microTarget: null,
    microLabel: '',
    macroTarget: null,
    macroLabel: '',
    microIsStopHunt: false,
  }

  if (bsl && ssl && bsl.isActive && ssl.isActive) {
    const nearerIsBsl = bsl.distancePct <= ssl.distancePct
    if (nearerIsBsl) {
      // Closer liquidity above → often first poke BSL (stop hunt shorts) then dump to SSL
      // OR continue up if drive is strongly UP
      hunt = {
        microTarget: bsl.price,
        microLabel: `BSL ${bsl.strength} @ ${fmt(bsl.price)} (+${bsl.distancePct.toFixed(2)}%)`,
        macroTarget: ssl.price,
        macroLabel: `SSL ${ssl.strength} @ ${fmt(ssl.price)} (−${ssl.distancePct.toFixed(2)}%)`,
        microIsStopHunt: true,
      }
      // Magnets pull scores
      upScore += strengthWeight(bsl.strength) * 0.8
      downScore += strengthWeight(ssl.strength) * 0.6
      reasons.push(`Магнит рядом сверху: ${hunt.microLabel}`)
    } else {
      hunt = {
        microTarget: ssl.price,
        microLabel: `SSL ${ssl.strength} @ ${fmt(ssl.price)} (−${ssl.distancePct.toFixed(2)}%)`,
        macroTarget: bsl.price,
        macroLabel: `BSL ${bsl.strength} @ ${fmt(bsl.price)} (+${bsl.distancePct.toFixed(2)}%)`,
        microIsStopHunt: true,
      }
      downScore += strengthWeight(ssl.strength) * 0.8
      upScore += strengthWeight(bsl.strength) * 0.6
      reasons.push(`Магнит рядом снизу: ${hunt.microLabel}`)
    }
  } else if (bsl?.isActive) {
    hunt = {
      microTarget: bsl.price,
      microLabel: `BSL @ ${fmt(bsl.price)}`,
      macroTarget: bsl.price,
      macroLabel: `BSL @ ${fmt(bsl.price)}`,
      microIsStopHunt: false,
    }
    upScore += strengthWeight(bsl.strength)
    reasons.push(`Ликвидность сверху: ${hunt.microLabel}`)
  } else if (ssl?.isActive) {
    hunt = {
      microTarget: ssl.price,
      microLabel: `SSL @ ${fmt(ssl.price)}`,
      macroTarget: ssl.price,
      macroLabel: `SSL @ ${fmt(ssl.price)}`,
      microIsStopHunt: false,
    }
    downScore += strengthWeight(ssl.strength)
    reasons.push(`Ликвидность снизу: ${hunt.microLabel}`)
  }

  const delta = upScore - downScore
  let drive: MmDriveDirection = 'NEUTRAL'
  if (delta >= 1.2) drive = 'UP'
  else if (delta <= -1.2) drive = 'DOWN'

  const confidence = Math.min(
    95,
    Math.round(40 + Math.abs(delta) * 12 + reasons.length * 3)
  )

  // Preferred trade: after stop-hunt micro, fade into macro; else follow drive
  let preferredSide: 'LONG' | 'SHORT' | null = null
  if (hunt.microIsStopHunt && hunt.macroTarget != null && hunt.microTarget != null) {
    if (hunt.microTarget > price && hunt.macroTarget < price) {
      // Micro up to BSL then macro down to SSL → SHORT after/near BSL
      preferredSide = drive === 'UP' && confidence < 70 ? 'SHORT' : drive === 'DOWN' ? 'SHORT' : 'SHORT'
      // If MM strongly driving up (prodding), prefer LONG through BSL
      if (drive === 'UP' && upScore - downScore >= 3) preferredSide = 'LONG'
    } else if (hunt.microTarget < price && hunt.macroTarget > price) {
      preferredSide = drive === 'DOWN' && downScore - upScore >= 3 ? 'SHORT' : 'LONG'
      if (drive === 'DOWN' && downScore - upScore >= 3) preferredSide = 'SHORT'
    }
  } else if (drive === 'UP') preferredSide = 'LONG'
  else if (drive === 'DOWN') preferredSide = 'SHORT'

  const scoreBoostForLong =
    drive === 'UP' ? Math.min(2, delta * 0.45) : drive === 'DOWN' ? Math.max(-1.5, delta * 0.35) : 0
  const scoreBoostForShort =
    drive === 'DOWN'
      ? Math.min(2, -delta * 0.45)
      : drive === 'UP'
        ? Math.max(-1.5, -delta * 0.35)
        : 0

  const label =
    drive === 'NEUTRAL'
      ? 'MM NEUTRAL — нет ясного давления'
      : preferredSide === 'SHORT' && hunt.microIsStopHunt && drive === 'UP'
        ? `MM: сначала вверх к BSL → затем вниз к SSL (охота)`
        : preferredSide === 'LONG' && hunt.microIsStopHunt && drive === 'DOWN'
          ? `MM: сначала вниз к SSL → затем вверх к BSL (охота)`
          : `MM гонит ${drive === 'UP' ? 'ВВЕРХ' : 'ВНИЗ'} (${confidence}%)`

  return {
    drive,
    confidence,
    preferredSide,
    scoreBoostForLong,
    scoreBoostForShort,
    hunt,
    reasons: reasons.slice(0, 6),
    label,
    emoji: drive === 'UP' ? '👆' : drive === 'DOWN' ? '👇' : '↔️',
    updatedAt: Date.now(),
  }
}

function sumVol(walls: OrderBookWall[]): number {
  return walls.reduce((s, w) => s + w.volume, 0)
}

function strengthWeight(s: 'WEAK' | 'MEDIUM' | 'STRONG'): number {
  return s === 'STRONG' ? 1.6 : s === 'MEDIUM' ? 1.0 : 0.5
}

function fmt(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

/**
 * Build micro→macro path points for chart overlay / scenarios.
 */
export function buildLiquidityHuntPath(
  price: number,
  intent: MmIntentResult,
  candleSec: number
): Array<{ timeOffsetSeconds: number; price: number; label: string }> {
  const pts: Array<{ timeOffsetSeconds: number; price: number; label: string }> = [
    { timeOffsetSeconds: 0, price, label: 'Now' },
  ]
  const { hunt } = intent
  if (hunt.microTarget != null) {
    pts.push({
      timeOffsetSeconds: candleSec * 2,
      price: hunt.microTarget,
      label: hunt.microIsStopHunt ? `Sweep ${hunt.microLabel}` : hunt.microLabel,
    })
  }
  if (
    hunt.macroTarget != null &&
    hunt.macroTarget !== hunt.microTarget
  ) {
    pts.push({
      timeOffsetSeconds: candleSec * 6,
      price: hunt.macroTarget,
      label: `Magnet ${hunt.macroLabel}`,
    })
  }
  return pts
}
