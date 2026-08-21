/**
 * Meme order-book forecast — score whether the book supports the next move
 * or looks like manipulation (spoof / wash / one-sided tape without depth).
 *
 * Used to gate PUMP/PEAK Quality A: structure alone is not enough on memes.
 */

import type {
  OrderBookEvent,
  OrderBookSnapshot,
} from './orderBookReader'

export type MemeBookSide = 'LONG' | 'SHORT'

export interface CoherenceCheck {
  /** Seconds the supportive wall has been observed */
  wallAgeSec?: number | null
  /** Tape did not flip side more than twice in ~60s */
  tapeDirectionConsistent?: boolean
  /** Price responds as tape implies (|move| not against >15 bps) */
  priceResponseLogical?: boolean
  /** Tape side flips in window */
  tapeFlips?: number | null
}

/** Memes: walls live seconds. Alts: longer persist. */
export const COHERENCE_THRESHOLDS = {
  meme: { wallAge: 20, maxTapeFlips: 3, priceVsTape: 20, flashSpoofAge: 8 },
  alt: { wallAge: 60, maxTapeFlips: 2, priceVsTape: 15, flashSpoofAge: 30 },
} as const

export interface MemeBookForecastInput {
  side: MemeBookSide
  bookSeen: boolean
  snapshot?: OrderBookSnapshot | null
  previous?: OrderBookSnapshot | null
  event?: OrderBookEvent | null
  tapeBuy?: number | null
  tapeMoveBps?: number | null
  mmPattern?: string | null
  eventKind?: string
  eventReady?: boolean
  eventSide?: MemeBookSide | null
  /** Temporal coherence — meme vs alt thresholds differ */
  coherence?: CoherenceCheck | null
  /** Default meme — alt path can pass 'alt' */
  market?: 'meme' | 'alt'
}

export interface MemeBookForecast {
  /** 0–100 aligned with intended side */
  score: number
  /** True absorb / CVD / persistent OBI / wall support — NOT tape alone */
  realBook: boolean
  /** Tape from book without depth confirmation */
  strongTape: boolean
  /** Wash / spoof / conflict / against-side wall yank */
  toxic: boolean
  /** OBI aligned with side */
  obiAligned: boolean
  /** Forecast: NEXT_UP | NEXT_DOWN | CHOP | TRAP */
  bias: 'NEXT_UP' | 'NEXT_DOWN' | 'CHOP' | 'TRAP'
  reasons: string[]
}

const OBI_ALIGN_LONG = 12
const OBI_ALIGN_SHORT = -12
const OBI_BUILD = 4

export function memeBookForecast(
  input: MemeBookForecastInput
): MemeBookForecast {
  const reasons: string[] = []
  const side = input.side
  const obi = input.snapshot?.obi ?? input.event?.obi ?? null
  const prevObi = input.previous?.obi ?? null
  const obiDelta =
    obi != null && prevObi != null ? obi - prevObi : input.event?.obiChange ?? 0
  const kind = input.eventKind || input.event?.kind || 'NO_EVENT'
  const mm = (input.mmPattern || input.event?.mmPattern || '').toUpperCase()
  const evSide = input.eventSide ?? input.event?.side ?? null
  const evReady = Boolean(input.eventReady ?? input.event?.ready)
  const trap = Boolean(input.event?.trap)
  const wallPersist = Boolean(input.event?.wallPersisted)
  const relocated = Boolean(input.event?.relocated)

  let toxic = false
  if (!input.bookSeen) {
    reasons.push('book_missing')
    return {
      score: 0,
      realBook: false,
      strongTape: false,
      toxic: false,
      obiAligned: false,
      bias: 'CHOP',
      reasons,
    }
  }

  if (kind === 'WASH_SKIP' || mm.includes('WASH')) {
    toxic = true
    reasons.push('toxic:wash')
  }
  if (
    kind.startsWith('SPOOF') ||
    mm.includes('SPOOF') ||
    kind === 'CONFLICT'
  ) {
    toxic = true
    reasons.push('toxic:spoof_or_conflict')
  }
  if (trap) {
    toxic = true
    reasons.push('toxic:trap_flip')
  }
  // Wall yanked against our side = classic meme spoof
  if (
    relocated &&
    ((side === 'LONG' && kind === 'BID_WALL_REMOVED') ||
      (side === 'SHORT' && kind === 'ASK_WALL_REMOVED'))
  ) {
    toxic = true
    reasons.push('toxic:wall_yank')
  }

  // Temporal coherence — memes: don't kill on 5–20s walls (normal); only flash spoof
  const coh = input.coherence
  const th =
    COHERENCE_THRESHOLDS[input.market === 'alt' ? 'alt' : 'meme']
  let wallTooYoung = false
  if (coh) {
    const wallAge = coh.wallAgeSec
    // Flash spoof only (<8s meme / <30s alt). Mid-age walls: soft penalty, not toxic.
    if (
      wallAge != null &&
      wallAge > 0 &&
      wallAge < th.flashSpoofAge &&
      wallPersist
    ) {
      toxic = true
      reasons.push('toxic:wall_flash_spoof')
    } else if (
      wallAge != null &&
      wallAge > 0 &&
      wallAge < th.wallAge &&
      wallPersist
    ) {
      wallTooYoung = true
      reasons.push(`wall_young_soft:${wallAge.toFixed(0)}<${th.wallAge}`)
    }
    const flips = coh.tapeFlips ?? 0
    if (flips > th.maxTapeFlips) {
      toxic = true
      reasons.push(`toxic:tape_wash_flips:${flips}`)
    }
    if (coh.tapeDirectionConsistent === false && flips > th.maxTapeFlips) {
      toxic = true
      reasons.push('toxic:tape_incoherent')
    }
    if (coh.priceResponseLogical === false) {
      // Soft on memes — often chop; only hard-toxic via bps check below
      if (input.market === 'alt') {
        toxic = true
        reasons.push('toxic:price_vs_tape')
      } else {
        reasons.push('price_vs_tape_soft')
      }
    }
    const buy = input.tapeBuy
    const move = input.tapeMoveBps
    const vs = th.priceVsTape
    if (
      buy != null &&
      move != null &&
      ((buy >= 58 && move <= -vs) || (buy <= 42 && move >= vs))
    ) {
      toxic = true
      reasons.push('toxic:manip_price_against_tape')
    }
  }

  const absLong =
    kind === 'ABSORPTION_LONG' || (mm.includes('ABSORPTION') && evSide === 'LONG')
  const absShort =
    kind === 'ABSORPTION_SHORT' ||
    (mm.includes('ABSORPTION') && evSide === 'SHORT')
  const cvdLong = kind === 'CVD_DIVERGENCE' && evSide === 'LONG'
  const cvdShort = kind === 'CVD_DIVERGENCE' && evSide === 'SHORT'
  const wallSupport =
    (side === 'LONG' &&
      (kind === 'BID_WALL_SUPPORT' || kind === 'ASK_WALL_REMOVED')) ||
    (side === 'SHORT' &&
      (kind === 'ASK_WALL_RESISTANCE' || kind === 'BID_WALL_REMOVED'))

  const obiAligned =
    obi != null &&
    (side === 'LONG' ? obi >= OBI_ALIGN_LONG : obi <= OBI_ALIGN_SHORT)
  const obiBuilding =
    obiAligned &&
    (side === 'LONG' ? obiDelta >= OBI_BUILD : obiDelta <= -OBI_BUILD)

  const tapeBuy = input.tapeBuy
  const tapeMove = input.tapeMoveBps
  const strongTape =
    tapeBuy != null &&
    tapeMove != null &&
    (side === 'LONG'
      ? tapeBuy >= 55 && tapeMove >= 3
      : tapeBuy <= 45 && tapeMove <= -3)

  // Young meme walls can support absorb/CVD, but not wall-only realBook
  const realBook =
    !toxic &&
    ((side === 'LONG' && (absLong || cvdLong)) ||
      (side === 'SHORT' && (absShort || cvdShort)) ||
      (obiBuilding && strongTape) ||
      (obiAligned && (absLong || absShort || cvdLong || cvdShort)) ||
      (!wallTooYoung &&
        ((obiBuilding && wallPersist) ||
          (obiAligned && wallSupport) ||
          (wallSupport && wallPersist && obiAligned))))

  let score = 40
  if (realBook) {
    score += 28
    reasons.push('real_book')
  }
  if (wallTooYoung) score -= 8
  if (obiAligned) {
    score += 12
    reasons.push(side === 'LONG' ? `obi_bid:${obi!.toFixed(0)}` : `obi_ask:${obi!.toFixed(0)}`)
  }
  if (obiBuilding) {
    score += 10
    reasons.push(`obi_build:${obiDelta.toFixed(0)}`)
  }
  if (side === 'LONG' ? absLong : absShort) {
    score += 14
    reasons.push('absorb')
  }
  if (side === 'LONG' ? cvdLong : cvdShort) {
    score += 10
    reasons.push('cvd')
  }
  if (wallSupport) {
    score += 8
    reasons.push('wall_align')
  }
  if (wallPersist) {
    score += 6
    reasons.push('wall_persist')
  }
  if (strongTape) {
    score += 8
    reasons.push(
      side === 'LONG'
        ? `tape_up:${tapeBuy!.toFixed(0)}`
        : `tape_dn:${tapeBuy!.toFixed(0)}`
    )
  }
  if (evReady && evSide === side) {
    score += 6
    reasons.push(`ev_ready:${kind}`)
  }

  // Against-side pressure
  if (obi != null) {
    if (side === 'LONG' && obi <= -14) {
      score -= 22
      reasons.push('obi_against')
    }
    if (side === 'SHORT' && obi >= 14) {
      score -= 22
      reasons.push('obi_against')
    }
  }
  if (
    strongTape === false &&
    tapeBuy != null &&
    ((side === 'LONG' && tapeBuy <= 40) || (side === 'SHORT' && tapeBuy >= 60))
  ) {
    score -= 12
    reasons.push('tape_against')
  }
  if (toxic) score -= 35

  // Tape-only without depth = meme tip trap
  if (strongTape && !realBook && !obiAligned) {
    score -= 10
    reasons.push('tape_without_depth')
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  let bias: MemeBookForecast['bias'] = 'CHOP'
  if (toxic || score < 35) bias = 'TRAP'
  else if (score >= 62) bias = side === 'LONG' ? 'NEXT_UP' : 'NEXT_DOWN'
  else if (obiAligned && score >= 50)
    bias = side === 'LONG' ? 'NEXT_UP' : 'NEXT_DOWN'

  // Book magnet opposite to the intended fade — callers must skip, not score-down.
  if (side === 'SHORT' && obi != null && obi >= 10 && bias !== 'TRAP') {
    bias = 'NEXT_UP'
    reasons.push('forecast:next_up_against_short')
  }
  if (side === 'LONG' && obi != null && obi <= -10 && bias !== 'TRAP') {
    bias = 'NEXT_DOWN'
    reasons.push('forecast:next_down_against_long')
  }

  if (bias === 'TRAP') reasons.push('forecast:trap')
  else if (bias === 'NEXT_UP') reasons.push('forecast:next_up')
  else if (bias === 'NEXT_DOWN') reasons.push('forecast:next_down')
  else reasons.push('forecast:chop')

  return {
    score,
    realBook,
    strongTape,
    toxic,
    obiAligned,
    bias,
    reasons,
  }
}

/** A-tier book gate for meme entries */
export function memeBookAllowsA(
  forecast: MemeBookForecast,
  opts?: { minScore?: number }
): boolean {
  const minScore = opts?.minScore ?? 58
  if (forecast.toxic) return false
  if (!forecast.realBook) return false
  if (forecast.score < minScore) return false
  if (forecast.bias === 'TRAP' || forecast.bias === 'CHOP') return false
  return true
}
