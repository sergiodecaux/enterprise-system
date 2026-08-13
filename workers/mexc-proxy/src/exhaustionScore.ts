/**
 * Participant exhaustion for memes — replaces MM intention on meme path.
 * High at highs → PEAK SHORT; low at highs → PUMP CONTINUE.
 */

import type { Candle } from './peakFuelFail'
import type { MemeVolumeProfile } from './memeVolumeProfile'

export interface ExhaustionScore {
  total: number
  components: {
    volume_decay: number
    wick_growth: number
    tape_slowing: number
    spread_widening: number
    repeat_levels: number
  }
  reasons: string[]
}

export interface ExhaustionInput {
  candles1m: Candle[]
  profile: MemeVolumeProfile
  buyFlowPct?: number | null
  priceMoveBps?: number | null
  /** deals/min proxy: use tape move abs as activity if no deal count */
  tapeActivity?: number | null
  prevTapeActivity?: number | null
  spreadBps?: number | null
  baselineSpreadBps?: number | null
}

function avg(xs: number[]): number {
  if (!xs.length) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function repeatLevelScore(candles: Candle[]): number {
  const closed = candles.length >= 2 ? candles.slice(0, -1) : candles
  const w = closed.slice(-12)
  if (w.length < 6) return 0
  const highs = w.map((c) => c[2])
  const peak = Math.max(...highs)
  if (!(peak > 0)) return 0
  let touches = 0
  for (const h of highs) {
    if (Math.abs(h - peak) / peak <= 0.0035) touches++
  }
  return Math.min(1, Math.max(0, (touches - 1) / 3))
}

export function calcExhaustion(input: ExhaustionInput): ExhaustionScore {
  const reasons: string[] = []
  const closed =
    input.candles1m.length >= 2
      ? input.candles1m.slice(0, -1)
      : input.candles1m

  const volume_decay = Math.min(1, Math.max(0, input.profile.post_spike_decay))

  const recent = closed.slice(-3)
  const wickRatios = recent.map((c) => {
    const range = c[2] - c[3]
    if (!(range > 0)) return 0
    return (c[2] - Math.max(c[1], c[4])) / range
  })
  const wick_growth = Math.min(1, Math.max(0, avg(wickRatios)))

  let tape_slowing = 0.35
  const act = input.tapeActivity
  const prevAct = input.prevTapeActivity
  if (act != null && prevAct != null && prevAct > 0) {
    const pace = act / prevAct
    tape_slowing = Math.min(1, Math.max(0, 1 - pace))
  } else if (
    input.buyFlowPct != null &&
    input.priceMoveBps != null &&
    input.buyFlowPct >= 52 &&
    Math.abs(input.priceMoveBps) <= 10
  ) {
    // Buy tape not moving price = exhausting buyers
    tape_slowing = 0.7
    reasons.push('tape_buy_exhausting')
  } else if (input.buyFlowPct != null && input.buyFlowPct <= 42) {
    tape_slowing = 0.55
  }

  let spread_widening = 0.2
  if (
    input.spreadBps != null &&
    input.baselineSpreadBps != null &&
    input.baselineSpreadBps > 0
  ) {
    const norm = input.spreadBps / input.baselineSpreadBps
    spread_widening = Math.min(1, Math.max(0, (norm - 1) / 2))
  }

  const repeat_levels = repeatLevelScore(input.candles1m)

  const total = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        volume_decay * 30 +
          wick_growth * 25 +
          tape_slowing * 25 +
          spread_widening * 10 +
          repeat_levels * 10
      )
    )
  )

  reasons.push(`exh:${total}`)
  reasons.push(`vd:${volume_decay.toFixed(2)}`)
  reasons.push(`wick:${wick_growth.toFixed(2)}`)

  return {
    total,
    components: {
      volume_decay,
      wick_growth,
      tape_slowing,
      spread_widening,
      repeat_levels,
    },
    reasons,
  }
}

/** Buy tape was strong but fading — PEAK helper */
export function tapeBuyExhausting(
  buyFlowPct: number | null | undefined,
  priceMoveBps: number | null | undefined,
  prevBuyFlow?: number | null
): boolean {
  if (buyFlowPct == null || priceMoveBps == null) return false
  const fading =
    prevBuyFlow != null && prevBuyFlow >= 58 && buyFlowPct < prevBuyFlow - 6
  const stuck = buyFlowPct >= 52 && Math.abs(priceMoveBps) <= 12
  return fading || stuck
}
