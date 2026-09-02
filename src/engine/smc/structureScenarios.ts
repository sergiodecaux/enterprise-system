/**
 * Live structure scenarios: 2–4 paths with probabilities, not a single
 * “reclaim = long” line. Texture (bleed / compression / displacement)
 * decides which MM script is actually running.
 */

import type { OhlcvCandle } from '../../api/mexc'
import type { PathPoint } from '../prediction/types'
import type { MmTrapThesis } from './mmTrapThesis'
import { readCloseQuality } from './mmTrapThesis'
import type { Fib141Reaction, TfStructure } from './structureRead'

export const SCENARIO_COLORS = ['#22d3ee', '#f472b6', '#a78bfa', '#fbbf24'] as const

export type StructureScenarioKind =
  | 'BLEED_FLUSH'
  | 'HUNT_REVERSE'
  | 'RECLAIM_CONTINUE'
  | 'FAILED_RECLAIM'
  | 'RANGE_CHOP'
  | 'IMPULSE'
  | 'FADE_WICK'
  | 'HTF_CONTINUE'
  | 'BREAKOUT'
  | 'SNAP_BACK'
  | 'FIB_MAGNET'
  | 'DISTRIBUTION'
  | 'ACCUMULATION'

export interface StructureScenario {
  id: 'A' | 'B' | 'C' | 'D'
  kind: StructureScenarioKind
  color: string
  probability: number
  title: string
  why: string
  invalidation: string
  side: 'LONG' | 'SHORT' | 'BOTH'
  path: PathPoint[]
  target: number | null
}

export interface StructureScenarioBoard {
  now: string
  leadId: 'A' | 'B' | 'C' | 'D'
  leadTitle: string
  scenarios: StructureScenario[]
}

const H = 3600

function fmt(p: number): string {
  if (!Number.isFinite(p) || !(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  if (p >= 0.01) return p.toFixed(5)
  return p.toFixed(6)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 99
  return (Math.abs(a - b) / b) * 100
}

function atr(candles: OhlcvCandle[], n = 14): number {
  if (candles.length < 3) return 0
  const k = Math.min(n, candles.length - 1)
  let sum = 0
  let c = 0
  for (let i = candles.length - k; i < candles.length; i++) {
    const prev = candles[i - 1]
    const cur = candles[i]
    if (!prev || !cur) continue
    const tr = Math.max(
      cur[2] - cur[3],
      Math.abs(cur[2] - prev[4]),
      Math.abs(cur[3] - prev[4])
    )
    sum += tr
    c++
  }
  return c ? sum / c : 0
}

interface TapeTexture {
  grind: 'DOWN' | 'UP' | 'NONE'
  grindBars: number
  compression: number
  lowerHighs: boolean
  higherLows: boolean
  avgBodyPct: number
  displacement: 'UP' | 'DOWN' | 'NONE'
  closePos: number
  overlapping: boolean
}

function readTape(candles: OhlcvCandle[]): TapeTexture {
  const empty: TapeTexture = {
    grind: 'NONE',
    grindBars: 0,
    compression: 0,
    lowerHighs: false,
    higherLows: false,
    avgBodyPct: 0.5,
    displacement: 'NONE',
    closePos: 0.5,
    overlapping: false,
  }
  if (candles.length < 6) return empty
  const last = candles.slice(-8)
  const q = readCloseQuality(last[last.length - 1])
  const displacement =
    q === 'DISPLACEMENT_UP' ? 'UP' : q === 'DISPLACEMENT_DOWN' ? 'DOWN' : 'NONE'

  let bodySum = 0
  let overlap = 0
  let lowerHighs = 0
  let higherLows = 0
  let downCloses = 0
  let upCloses = 0
  let closePos = 0.5
  for (let i = 0; i < last.length; i++) {
    const [, o, h, l, c] = last[i]
    const range = h - l
    const body = Math.abs(c - o)
    bodySum += range > 0 ? body / range : 0
    if (range > 0) closePos = (c - l) / range
    if (c < o) downCloses++
    else if (c > o) upCloses++
    if (i > 0) {
      const prev = last[i - 1]
      if (h < prev[2] - (prev[2] - prev[3]) * 0.05) lowerHighs++
      if (l > prev[3] + (prev[2] - prev[3]) * 0.05) higherLows++
      const ov = Math.min(h, prev[2]) - Math.max(l, prev[3])
      if (ov > 0) overlap++
    }
  }
  const steps = last.length - 1
  const avgBodyPct = bodySum / last.length
  const overlapping = steps > 0 && overlap / steps >= 0.6
  const lh = steps > 0 && lowerHighs / steps >= 0.55
  const hl = steps > 0 && higherLows / steps >= 0.55

  const recent = atr(last, 5)
  const prior = atr(candles.slice(-20), 14)
  const compression =
    prior > 0 ? Math.max(0, Math.min(1, 1 - recent / prior)) : 0

  let grind: TapeTexture['grind'] = 'NONE'
  let grindBars = 0
  const small = avgBodyPct <= 0.42
  if (lh && downCloses >= upCloses && small && displacement !== 'UP') {
    grind = 'DOWN'
    grindBars = lowerHighs + 1
  } else if (hl && upCloses >= downCloses && small && displacement !== 'DOWN') {
    grind = 'UP'
    grindBars = higherLows + 1
  }

  return {
    grind,
    grindBars,
    compression,
    lowerHighs: lh,
    higherLows: hl,
    avgBodyPct,
    displacement,
    closePos,
    overlapping,
  }
}

function mag(
  price: number,
  side: 'LONG' | 'SHORT',
  trap: MmTrapThesis | null,
  h1: TfStructure | null,
  h4: TfStructure | null
): { price: number; label: string } | null {
  if (side === 'SHORT') {
    const p =
      trap?.crowdLongs ??
      h1?.lastSwingLow?.price ??
      h1?.nextSsl ??
      h4?.nextSsl ??
      h1?.dealingLow ??
      null
    if (p != null && p > 0 && p < price) return { price: p, label: 'лонги' }
  } else {
    const p =
      trap?.crowdShorts ??
      h1?.lastSwingHigh?.price ??
      h1?.nextBsl ??
      h4?.nextBsl ??
      h1?.dealingHigh ??
      null
    if (p != null && p > 0 && p > price) return { price: p, label: 'шорты' }
  }
  return null
}

function path(points: Array<[number, number, string?]>): PathPoint[] {
  const out: PathPoint[] = []
  let tPrev = -1
  for (const [t, price, label] of points) {
    if (!(price > 0) || !Number.isFinite(price)) continue
    const time = t <= tPrev ? tPrev + 60 : t
    tPrev = time
    out.push({
      timeOffsetSeconds: Math.round(time),
      price,
      label,
      isKeyLevel: Boolean(label),
    })
  }
  return out
}

function reclaimHeld(
  price: number,
  trap: MmTrapThesis | null,
  last: OhlcvCandle | undefined
): boolean {
  if (!trap?.swept || !last) return false
  if (trap.swept.kind === 'SSL') {
    return (
      last[4] > trap.swept.price &&
      price > trap.swept.price &&
      trap.closeQuality === 'DISPLACEMENT_UP'
    )
  }
  return (
    last[4] < trap.swept.price &&
    price < trap.swept.price &&
    trap.closeQuality === 'DISPLACEMENT_DOWN'
  )
}

function reclaimLost(
  price: number,
  trap: MmTrapThesis | null,
  last: OhlcvCandle | undefined,
  tape: TapeTexture
): boolean {
  if (!trap?.swept) return false
  if (trap.swept.kind === 'SSL') {
    if (price < trap.swept.price || (last && last[4] < trap.swept.price)) return true
    return tape.grind === 'DOWN' || tape.lowerHighs
  }
  if (price > trap.swept.price || (last && last[4] > trap.swept.price)) return true
  return tape.grind === 'UP' || tape.higherLows
}

function nowCopy(
  tape: TapeTexture,
  trap: MmTrapThesis | null,
  price: number,
  h4: TfStructure | null,
  d1: TfStructure | null
): string {
  const bits: string[] = []
  if (tape.grind === 'DOWN') {
    bits.push(
      tape.compression > 0.35
        ? 'Поджимают вниз: хаи ниже, тела мелкие, диапазон сжимается. Это не лонг и не закреп — так готовят пролив.'
        : 'Час режет хаи мелкими телами. Поджим, не смещение: цену могут спустить ещё и выбросить лонги рывком.'
    )
  } else if (tape.grind === 'UP') {
    bits.push(
      tape.compression > 0.35
        ? 'Поджимают вверх мелкими телами. Часто это охота на шорты, не тренд.'
        : 'Час поднимает лои без широкого тела. Могут добрать шорты и развернуть.'
    )
  } else if (tape.displacement === 'UP') {
    bits.push('Последний час закрылся телом вверх — смещение настоящее, не фитиль.')
  } else if (tape.displacement === 'DOWN') {
    bits.push('Последний час закрылся телом вниз — смещение настоящее, не фитиль.')
  } else if (trap?.closeQuality === 'REJECT_HIGH') {
    bits.push('Фитиль сверху: хаи не приняли. Покупать BOS рано.')
  } else if (trap?.closeQuality === 'REJECT_LOW') {
    bits.push('Фитиль снизу: лои сняли и вернули. Это пружина, не сигнал лонг.')
  } else {
    bits.push('Час без смещения телом. BOS сам по себе сделкой не является.')
  }

  if (trap?.swept?.kind === 'SSL' && trap.reclaimLevel != null) {
    const held = price > trap.reclaimLevel
    bits.push(
      held
        ? `Цена над снятым лоем ${fmt(trap.reclaimLevel)}, но закреп — только тело, которое держат следующие часы.`
        : `Лои сняли у ${fmt(trap.swept.price)}, цена не держит уровень — лонг с закрепа сейчас не читается.`
    )
  } else if (trap?.swept?.kind === 'BSL' && trap.reclaimLevel != null) {
    const held = price < trap.reclaimLevel
    bits.push(
      held
        ? `Цена под снятым хаем ${fmt(trap.reclaimLevel)}.`
        : `Хаи сняли у ${fmt(trap.swept.price)}, шорт с закрепа ещё не факт.`
    )
  }

  const htf =
    h4?.trend === 'BEARISH' || d1?.trend === 'BEARISH'
      ? '4ч/день смотрят вниз — любые лонги с часа проверять дважды.'
      : h4?.trend === 'BULLISH' || d1?.trend === 'BULLISH'
        ? '4ч/день смотрят вверх — сливы с часа часто охота, не разворот дня.'
        : null
  if (htf) bits.push(htf)
  return bits.slice(0, 3).join(' ')
}

interface RawScenario {
  kind: StructureScenarioKind
  weight: number
  title: string
  why: string
  invalidation: string
  side: 'LONG' | 'SHORT' | 'BOTH'
  path: PathPoint[]
  target: number | null
}

export function buildStructureScenarios(input: {
  price: number
  candlesTape?: OhlcvCandle[]
  candles1h?: OhlcvCandle[]
  h1: TfStructure | null
  h4: TfStructure | null
  d1: TfStructure | null
  fib?: Fib141Reaction | null
  trap: MmTrapThesis | null
  bookImbalance?: number | null
  mmDrive?: 'UP' | 'DOWN' | 'NEUTRAL' | null
}): StructureScenarioBoard {
  const price = input.price
  const tapeSrc =
    input.candlesTape && input.candlesTape.length >= 8
      ? input.candlesTape
      : input.candles1h ?? []
  const tape = readTape(tapeSrc)
  const last = tapeSrc[tapeSrc.length - 1] ?? input.candles1h?.[input.candles1h.length - 1]
  const origin =
    last && Number.isFinite(last[4]) && last[4] > 0 ? last[4] : price
  const trap = input.trap
  const h1 = input.h1
  const h4 = input.h4
  const d1 = input.d1
  const book = input.bookImbalance ?? 0
  const drive = input.mmDrive ?? 'NEUTRAL'
  const atr1 = atr(tapeSrc.length >= 8 ? tapeSrc : input.candles1h ?? [], 14) || price * 0.008
  const longs = mag(price, 'SHORT', trap, h1, h4)
  const shorts = mag(price, 'LONG', trap, h1, h4)
  const distL = longs ? pct(longs.price, price) : 99
  const distS = shorts ? pct(shorts.price, price) : 99
  const htfDown = h4?.trend === 'BEARISH' || d1?.trend === 'BEARISH'
  const htfUp = h4?.trend === 'BULLISH' || d1?.trend === 'BULLISH'
  const premium = Boolean(h1?.inPremium || d1?.inPremium)
  const discount = Boolean(h1?.inDiscount || d1?.inDiscount)
  const fibTrapLong = input.fib?.state === 'INSIDE' && premium
  const held = reclaimHeld(price, trap, last)
  const lost = reclaimLost(price, trap, last, tape)
  const raw: RawScenario[] = []

  // 1) Slow squeeze then flush — the script the old HUD ignored
  {
    const down =
      tape.grind === 'DOWN' ||
      (tape.lowerHighs && tape.displacement !== 'UP' && tape.avgBodyPct < 0.45)
    const up =
      tape.grind === 'UP' ||
      (tape.higherLows && tape.displacement !== 'DOWN' && tape.avgBodyPct < 0.45)
    if (down) {
      let w = 22 + tape.grindBars * 4 + tape.compression * 18
      if (htfDown) w += 12
      if (htfUp) w -= 10
      if (book < -0.12) w += 8
      if (drive === 'DOWN') w += 10
      if (drive === 'UP') w -= 6
      if (longs && distL <= 2.2) w += 10
      if (tape.displacement === 'DOWN') w += 8
      if (held && trap?.swept?.kind === 'SSL') w -= 16
      if (fibTrapLong) w += 6
      const target = longs?.price ?? (h1?.dealingLow ?? price - atr1 * 2.4)
      const mid = lerp(price, target, 0.28)
      const squeeze = lerp(price, target, 0.48)
      raw.push({
        kind: 'BLEED_FLUSH',
        weight: w,
        title: 'Поджим вниз → пролив',
        why: `Хаи ниже, тела ~${Math.round(tape.avgBodyPct * 100)}% диапазона${
          tape.compression > 0.3 ? ', волатильность сжалась' : ''
        }. Так не «лонг с другой зоны» — так выжимают заявки и потом срывают лонги${
          longs ? ` к ${fmt(longs.price)}` : ''
        }.`,
        invalidation: `Слом варианта: час закроется телом выше ${fmt(
          h1?.lastSwingHigh?.price ?? price + atr1 * 0.9
        )}, не фитилём.`,
        side: 'SHORT',
        target,
        path: path([
          [0, origin, 'сейчас'],
          [H * 0.9, lerp(price, mid, 0.7), 'поджим'],
          [H * 1.8, mid, 'ещё ниже'],
          [H * 2.7, squeeze, 'сжатие'],
          [H * 4.4, target, longs ? 'пролив в лонги' : 'пролив'],
        ]),
      })
    } else if (up) {
      let w = 20 + tape.grindBars * 4 + tape.compression * 16
      if (htfUp) w += 10
      if (htfDown) w -= 10
      if (book > 0.12) w += 8
      if (drive === 'UP') w += 10
      if (shorts && distS <= 2.2) w += 10
      if (held && trap?.swept?.kind === 'BSL') w -= 16
      const target = shorts?.price ?? (h1?.dealingHigh ?? price + atr1 * 2.4)
      raw.push({
        kind: 'BLEED_FLUSH',
        weight: w,
        title: 'Поджим вверх → вынос шортов',
        why: `Лои выше без широкого тела. Могут дотянуть до шортов${
          shorts ? ` ${fmt(shorts.price)}` : ''
        } и там решить — закреп или слив.`,
        invalidation: `Слом: час телом ниже ${fmt(
          h1?.lastSwingLow?.price ?? price - atr1 * 0.9
        )}.`,
        side: 'LONG',
        target,
        path: path([
          [0, origin, 'сейчас'],
          [H * 0.9, lerp(price, target, 0.25), 'поджим'],
          [H * 1.8, lerp(price, target, 0.5), 'ещё выше'],
          [H * 3.6, target, shorts ? 'шорты' : 'вынос'],
        ]),
      })
    }
  }

  // 2) Hunt nearer crowd, then reverse — classic MM
  if (longs || shorts) {
    const huntShorts = shorts && distS <= distL
    const nearer = huntShorts ? shorts : longs
    const later = huntShorts ? longs : shorts
    if (nearer) {
      let w = 18
      if (pct(nearer.price, price) <= 1.4) w += 12
      else if (pct(nearer.price, price) <= 2.4) w += 6
      if (trap?.phase === 'HUNTING' || trap?.phase === 'TRAP') w += 8
      if (premium && huntShorts) w += 8
      if (discount && !huntShorts) w += 8
      if (tape.displacement !== 'NONE') w -= 6
      const laterPx =
        later?.price ??
        (huntShorts ? price - atr1 * 2.1 : price + atr1 * 2.1)
      raw.push({
        kind: 'HUNT_REVERSE',
        weight: w,
        title: huntShorts
          ? 'Сначала шорты, потом вниз'
          : 'Сначала лонги, потом вверх',
        why: huntShorts
          ? `Ближе висят шорты ${fmt(nearer.price)} (${pct(nearer.price, price).toFixed(2)}%). Их снимают раньше, чем «лонг с закрепа». После снятия без тела над уровнем — возврат${later ? ` в лонги ${fmt(later.price)}` : ''}.`
          : `Ближе висят лонги ${fmt(nearer.price)}. Сначала снятие, не шорт в рынок. Если уровень не удержали телом — разворот вверх${later ? ` к ${fmt(later.price)}` : ''}.`,
        invalidation: huntShorts
          ? `Слом: закреп телом над ${fmt(nearer.price)} и удержание следующего часа.`
          : `Слом: закреп телом под ${fmt(nearer.price)} и удержание следующего часа.`,
        side: 'BOTH',
        target: laterPx,
        path: path([
          [0, origin, 'сейчас'],
          [H * 1.1, lerp(price, nearer.price, 0.7), 'охота'],
          [H * 2.0, nearer.price, huntShorts ? 'снятие шортов' : 'снятие лонгов'],
          [H * 3.2, lerp(nearer.price, laterPx, 0.35), 'возврат'],
          [H * 5.2, laterPx, later ? later.label : 'разворот'],
        ]),
      })
    }
  }

  // 3) Genuine reclaim continuation — only if the close actually holds
  if (trap?.swept && held && !lost) {
    const isLong = trap.swept.kind === 'SSL'
    let w = 16
    if (tape.displacement === (isLong ? 'UP' : 'DOWN')) w += 16
    if (isLong && htfUp) w += 10
    if (!isLong && htfDown) w += 10
    if (isLong && htfDown) w -= 14
    if (!isLong && htfUp) w -= 14
    if (tape.grind === (isLong ? 'DOWN' : 'UP')) w -= 18
    const target = isLong
      ? shorts?.price ?? h4?.nextBsl ?? h1?.dealingHigh ?? price + atr1 * 2
      : longs?.price ?? h4?.nextSsl ?? h1?.dealingLow ?? price - atr1 * 2
    const rec = trap.reclaimLevel ?? trap.swept.price
    raw.push({
      kind: 'RECLAIM_CONTINUE',
      weight: w,
      title: isLong ? 'Закреп держит — вынос шортов' : 'Закреп держит — слив лонгов',
      why: isLong
        ? `Сняли лои и закрылись телом над ${fmt(rec)}. Это единственный лонг, который сейчас имеет право: не «если закреп», а факт закрытия. Цель — ${shorts ? `шорты ${fmt(shorts.price)}` : 'ликвидность сверху'}.`
        : `Сняли хаи и закрылись телом под ${fmt(rec)}. Шорт по факту, не по BOS. Цель — ${longs ? `лонги ${fmt(longs.price)}` : 'ликвидность снизу'}.`,
      invalidation: isLong
        ? `Слом: час закроется обратно под ${fmt(rec)}.`
        : `Слом: час закроется обратно над ${fmt(rec)}.`,
      side: isLong ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.3, lerp(price, rec, 0.45), 'ретест закрепа'],
        [H * 2.2, rec, 'держат'],
        [H * 5.0, target, isLong ? 'шорты' : 'лонги'],
      ]),
    })
  }

  // 4) Failed spring — they swept, then walked it back
  if (trap?.swept && (lost || !held)) {
    const springLong = trap.swept.kind === 'SSL'
    let w = 14
    if (lost) w += 12
    if (tape.grind === (springLong ? 'DOWN' : 'UP')) w += 14
    if (trap.closeQuality === 'REJECT_LOW' && springLong) w += 8
    if (trap.closeQuality === 'REJECT_HIGH' && !springLong) w += 8
    if (held) w -= 20
    if (springLong && htfDown) w += 10
    if (!springLong && htfUp) w += 10
    const target = springLong
      ? longs?.price ?? h1?.dealingLow ?? price - atr1 * 2.2
      : shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 2.2
    const rec = trap.reclaimLevel ?? trap.swept.price
    raw.push({
      kind: 'FAILED_RECLAIM',
      weight: w,
      title: springLong ? 'Пружина не удержалась — вниз' : 'Пружина не удержалась — вверх',
      why: springLong
        ? `Лои сняли у ${fmt(trap.swept.price)}, но тела над ${fmt(rec)} нет${
            tape.grind === 'DOWN' ? ', плюс час уже поджимает вниз' : ''
          }. Это не «лонг с другой зоны» — это срыв пружины в тех, кто купил фитиль.`
        : `Хаи сняли у ${fmt(trap.swept.price)}, закреп под ${fmt(rec)} не держится. Кто шортил фитиль — кормят обратно.`,
      invalidation: springLong
        ? `Слом: два часа подряд закрываются над ${fmt(rec)}.`
        : `Слом: два часа подряд закрываются под ${fmt(rec)}.`,
      side: springLong ? 'SHORT' : 'LONG',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.0, lerp(price, rec, 0.6), 'теряют уровень'],
        [H * 1.8, rec, 'срыв закрепа'],
        [H * 4.2, target, springLong ? 'лонги' : 'шорты'],
      ]),
    })
  }

  // 5) Chop in the 1H dealing range
  if (h1 && price <= h1.dealingHigh && price >= h1.dealingLow) {
    const span = h1.dealingHigh - h1.dealingLow
    if (span > 0 && pct(h1.dealingHigh, h1.dealingLow) >= 0.6) {
      let w = 10
      if (tape.grind === 'NONE' && tape.displacement === 'NONE') w += 10
      if (tape.overlapping) w += 6
      if (trap?.phase === 'NEUTRAL') w += 6
      if (tape.grind !== 'NONE') w -= 8
      raw.push({
        kind: 'RANGE_CHOP',
        weight: w,
        title: 'Пила в диапазоне часа',
        why: `Цена внутри ${fmt(h1.dealingLow)}–${fmt(h1.dealingHigh)}. Пока нет тела за край, оба направления — шум. Ждём выход и закреп за границей, не ловим середину.`,
        invalidation: `Слом пилы: закреп телом за ${fmt(h1.dealingHigh)} или за ${fmt(h1.dealingLow)}.`,
        side: 'BOTH',
        target: (h1.dealingHigh + h1.dealingLow) / 2,
        path: path([
          [0, origin, 'сейчас'],
          [H * 1.2, lerp(price, h1.dealingHigh, 0.55), 'к хаю диапазона'],
          [H * 2.6, lerp(price, h1.dealingLow, 0.55), 'к лою'],
          [H * 4.0, (h1.dealingHigh + h1.dealingLow) / 2, 'середина'],
        ]),
      })
    }
  }

  // Impulse already in play — follow the body, not the story
  if (tape.displacement === 'UP' || tape.displacement === 'DOWN') {
    const up = tape.displacement === 'UP'
    let w = 20
    if (up && htfUp) w += 12
    if (!up && htfDown) w += 12
    if (up && htfDown) w -= 8
    if (!up && htfUp) w -= 8
    if (drive === (up ? 'UP' : 'DOWN')) w += 8
    const target = up
      ? shorts?.price ?? h4?.nextBsl ?? price + atr1 * 1.8
      : longs?.price ?? h4?.nextSsl ?? price - atr1 * 1.8
    raw.push({
      kind: 'IMPULSE',
      weight: w,
      title: up ? 'Импульс вверх продолжают' : 'Импульс вниз продолжают',
      why: up
        ? `Час закрылся телом вверх. Пока следующее тело не развернёт, логика — добор ликвидности сверху${shorts ? ` (${fmt(shorts.price)})` : ''}, не поиск лонга «с закрепа».`
        : `Час закрылся телом вниз. Пока покупатель не вернул уровень телом, ждут продолжение к лонгам${longs ? ` ${fmt(longs.price)}` : ''}.`,
      invalidation: up
        ? `Слом: час закроется телом ниже ${fmt(last?.[3] ?? price - atr1)}.`
        : `Слом: час закроется телом выше ${fmt(last?.[2] ?? price + atr1)}.`,
      side: up ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, lerp(origin, target, 0.4), 'продолжение'],
        [H * 3.4, target, up ? 'ликвидность сверху' : 'ликвидность снизу'],
      ]),
    })
  }

  // Fade the wick — spike is the trap
  if (trap?.closeQuality === 'REJECT_HIGH' || trap?.closeQuality === 'REJECT_LOW') {
    const fadeDown = trap.closeQuality === 'REJECT_HIGH'
    let w = 18
    if (fadeDown && (premium || htfDown)) w += 10
    if (!fadeDown && (discount || htfUp)) w += 10
    if (tape.grind === (fadeDown ? 'DOWN' : 'UP')) w += 8
    const target = fadeDown
      ? longs?.price ?? h1?.dealingLow ?? price - atr1 * 1.6
      : shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 1.6
    raw.push({
      kind: 'FADE_WICK',
      weight: w,
      title: fadeDown ? 'Фитиль сверху — отдают' : 'Фитиль снизу — закрывают шорт',
      why: fadeDown
        ? `Хаи не приняли: длинный верхний фитиль, закрытие внутри. Это не пробой, это снятие. Часто цена идёт обратно к толпе лонгов${longs ? ` ${fmt(longs.price)}` : ''}.`
        : `Лои сняли фитилём и вернули. Покупать сам фитиль рано; если тело удержали — возможен вынос шортов${shorts ? ` к ${fmt(shorts.price)}` : ''}.`,
      invalidation: fadeDown
        ? `Слом: закреп телом над максимумом этого часа.`
        : `Слом: закреп телом под минимумом этого часа.`,
      side: fadeDown ? 'SHORT' : 'LONG',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.4, lerp(origin, target, 0.45), 'откат фитиля'],
        [H * 3.6, target, fadeDown ? 'к лонгам' : 'к шортам'],
      ]),
    })
  }

  // HTF continuation vs 1H noise
  if (h4 && h4.trend !== 'RANGING') {
    const up = h4.trend === 'BULLISH'
    let w = 12
    if (d1 && d1.trend === h4.trend) w += 10
    if (tape.grind === (up ? 'DOWN' : 'UP')) w += 6
    if (tape.displacement === (up ? 'DOWN' : 'UP')) w -= 6
    const target = up
      ? h4.nextBsl ?? shorts?.price ?? price + atr1 * 2.2
      : h4.nextSsl ?? longs?.price ?? price - atr1 * 2.2
    raw.push({
      kind: 'HTF_CONTINUE',
      weight: w,
      title: up ? '4ч бычий — час могут крутить вниз' : '4ч медвежий — час могут крутить вверх',
      why: up
        ? `Старший ТФ вверх. Сливы часа часто охота на лонги, не смена дня. Истинный ход — к ${fmt(target)}, если час не закроет телом ниже 4ч структуры.`
        : `Старший ТФ вниз. Отскоки часа часто корм шортам. Истинный ход — к ${fmt(target)}, пока 4ч не закрепит обратно.`,
      invalidation: up
        ? `Слом: 4ч закроется телом ниже ${fmt(h4.lastSwingLow?.price ?? h4.dealingLow)}.`
        : `Слом: 4ч закроется телом выше ${fmt(h4.lastSwingHigh?.price ?? h4.dealingHigh)}.`,
      side: up ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.6, lerp(origin, up ? price - atr1 * 0.5 : price + atr1 * 0.5, 0.8), 'шум часа'],
        [H * 5.5, target, 'ход 4ч'],
      ]),
    })
  }

  // Compression: both breakouts are live until a body chooses
  if (tape.compression > 0.28 && tape.displacement === 'NONE') {
    const upT = shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 1.5
    const dnT = longs?.price ?? h1?.dealingLow ?? price - atr1 * 1.5
    let wUp = 11 + tape.compression * 10
    let wDn = 11 + tape.compression * 10
    if (htfUp) wUp += 8
    if (htfDown) wDn += 8
    if (book > 0.1) wUp += 5
    if (book < -0.1) wDn += 5
    raw.push({
      kind: 'BREAKOUT',
      weight: wUp,
      title: 'Сжатие → вынос вверх',
      why: `Диапазон сжался. Пока нет тела, направление не выбрано — это не «лонг если закреп». Если снимут шорты${shorts ? ` ${fmt(shorts.price)}` : ''} и закроют выше, сжатие отработает вверх.`,
      invalidation: `Слом: час закрывается телом вниз и держит ниже ${fmt(origin - atr1 * 0.4)}.`,
      side: 'LONG',
      target: upT,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.1, lerp(origin, upT, 0.2), 'ещё сжатие'],
        [H * 3.2, upT, 'вынос'],
      ]),
    })
    raw.push({
      kind: 'BREAKOUT',
      weight: wDn,
      title: 'Сжатие → пролив вниз',
      why: `То же сжатие может разрешиться вниз: поджим, срыв лонгов${longs ? ` к ${fmt(longs.price)}` : ''}. Оба выхода живы, пока нет тела за край.`,
      invalidation: `Слом: час закрывается телом вверх и держит выше ${fmt(origin + atr1 * 0.4)}.`,
      side: 'SHORT',
      target: dnT,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.1, lerp(origin, dnT, 0.2), 'поджим'],
        [H * 3.2, dnT, 'пролив'],
      ]),
    })
  }

  // Snap-back after a run (dead cat / bull trap)
  if (tape.displacement !== 'NONE' && tape.compression < 0.25) {
    const afterDump = tape.displacement === 'DOWN'
    let w = 11
    if (afterDump && htfDown) w += 6
    if (!afterDump && htfUp) w += 6
    if (trap?.closeQuality === 'INDECISION') w += 5
    const mid = h1 ? (h1.dealingHigh + h1.dealingLow) / 2 : origin
    const target = afterDump
      ? lerp(origin, shorts?.price ?? h1?.dealingHigh ?? origin + atr1, 0.55)
      : lerp(origin, longs?.price ?? h1?.dealingLow ?? origin - atr1, 0.55)
    raw.push({
      kind: 'SNAP_BACK',
      weight: w,
      title: afterDump ? 'Отскок после слива — не разворот' : 'Откат после выноса — не смена тренда',
      why: afterDump
        ? `После смещения вниз часто дают мёртвого кота к ${fmt(target)} / середине ${fmt(mid)}. Это закрытие шортов, не лонг, пока нет закрепа над сломом.`
        : `После выноса вверх часто возвращают к ${fmt(target)}. Кормят опоздавших лонгов, если час не удержал хаи телом.`,
      invalidation: afterDump
        ? `Слом отскока как «только шорт»: закреп телом над ${fmt(h1?.lastSwingHigh?.price ?? origin + atr1)}.`
        : `Слом отката как «только лонг»: закреп телом под ${fmt(h1?.lastSwingLow?.price ?? origin - atr1)}.`,
      side: afterDump ? 'LONG' : 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.5, lerp(origin, target, 0.6), 'откат'],
        [H * 3.0, target, afterDump ? 'мёртвый кот' : 'сброс'],
      ]),
    })
  }

  // Fib 141 magnet
  if (input.fib && (input.fib.state === 'APPROACHING' || input.fib.state === 'INSIDE') && input.fib.bias) {
    const mid = (input.fib.zoneTop + input.fib.zoneBottom) / 2
    let w = 13
    if (input.fib.state === 'INSIDE') w += 6
    if (premium && input.fib.bias === 'SHORT') w += 8
    if (discount && input.fib.bias === 'LONG') w += 8
    const then =
      input.fib.bias === 'SHORT'
        ? longs?.price ?? price - atr1 * 1.8
        : shorts?.price ?? price + atr1 * 1.8
    raw.push({
      kind: 'FIB_MAGNET',
      weight: w,
      title:
        input.fib.bias === 'SHORT'
          ? 'Тянет в 141, оттуда часто слив'
          : 'Тянет в 141, оттуда часто вынос',
      why: `Цена ${input.fib.state === 'INSIDE' ? 'уже в' : 'идёт в'} зону 141 (${fmt(input.fib.zoneBottom)}–${fmt(input.fib.zoneTop)}). Это магнит, не сигнал. Реакция — после тела от границы, не внутри зоны.`,
      invalidation: `Слом магнита: закреп телом за 161 (${fmt(input.fib.zoneTop > input.fib.zoneBottom ? input.fib.zoneTop : input.fib.zoneBottom)}).`,
      side: input.fib.bias === 'SHORT' ? 'SHORT' : 'LONG',
      target: then,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.8, mid, 'зона 141'],
        [H * 4.0, then, input.fib.bias === 'SHORT' ? 'реакция вниз' : 'реакция вверх'],
      ]),
    })
  }

  // Distribution / accumulation
  if (premium && tape.lowerHighs && tape.displacement !== 'UP') {
    const target = longs?.price ?? h1?.dealingLow ?? price - atr1 * 2
    raw.push({
      kind: 'DISTRIBUTION',
      weight: 14 + (htfDown ? 8 : 0) + (book < 0 ? 5 : 0),
      title: 'Раздача в премиуме',
      why: `Цена в верхней половине, хаи ниже, смещения вверх нет. Типичная раздача: ещё чуть вверх в шорты, потом слив в лонги${longs ? ` ${fmt(longs.price)}` : ''}.`,
      invalidation: `Слом: закреп телом над последним хаем ${fmt(h1?.lastSwingHigh?.price ?? price + atr1)}.`,
      side: 'SHORT',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, lerp(origin, shorts?.price ?? origin + atr1 * 0.5, 0.5), 'ещё в шорты'],
        [H * 3.8, target, 'слив'],
      ]),
    })
  }
  if (discount && tape.higherLows && tape.displacement !== 'DOWN') {
    const target = shorts?.price ?? h1?.dealingHigh ?? price + atr1 * 2
    raw.push({
      kind: 'ACCUMULATION',
      weight: 14 + (htfUp ? 8 : 0) + (book > 0 ? 5 : 0),
      title: 'Набор в дисконте',
      why: `Цена в нижней половине, лои выше, смещения вниз нет. Могут ещё раз сходить в лонги и потом вынести шорты${shorts ? ` ${fmt(shorts.price)}` : ''}.`,
      invalidation: `Слом: закреп телом под последним лоем ${fmt(h1?.lastSwingLow?.price ?? price - atr1)}.`,
      side: 'LONG',
      target,
      path: path([
        [0, origin, 'сейчас'],
        [H * 1.2, lerp(origin, longs?.price ?? origin - atr1 * 0.5, 0.5), 'ещё в лонги'],
        [H * 3.8, target, 'вынос'],
      ]),
    })
  }

  const sorted = raw
    .filter((s) => s.weight >= 6 && s.path.length >= 2)
    .sort((a, b) => b.weight - a.weight)

  const picked: RawScenario[] = []
  for (const s of sorted) {
    if (picked.length >= 4) break
    const dup = picked.some(
      (o) =>
        o.kind === s.kind &&
        o.side === s.side &&
        o.target != null &&
        s.target != null &&
        pct(o.target, s.target) < 0.4
    )
    if (dup) continue
    picked.push(s)
  }
  const hasUp = picked.some((s) => s.side === 'LONG' || s.side === 'BOTH')
  const hasDown = picked.some((s) => s.side === 'SHORT' || s.side === 'BOTH')
  if (!hasUp) {
    const up = sorted.find((s) => s.side === 'LONG' && !picked.includes(s))
    if (up) {
      if (picked.length >= 4) picked[3] = up
      else picked.push(up)
    }
  }
  if (!hasDown) {
    const dn = sorted.find((s) => s.side === 'SHORT' && !picked.includes(s))
    if (dn) {
      if (picked.length >= 4) picked[picked.length - 1] = dn
      else picked.push(dn)
    }
  }

  if (!picked.length) {
    return {
      now: nowCopy(tape, trap, price, h4, d1),
      leadId: 'A',
      leadTitle: 'Ждём факт на ленте',
      scenarios: [],
    }
  }

  const weights = picked.map((s) => Math.max(1, s.weight))
  const sumW = weights.reduce((a, b) => a + b, 0) || 1
  const rounded = weights.map((w) => Math.max(1, Math.round((w / sumW) * 100)))
  const drift = rounded.reduce((a, b) => a + b, 0) - 100
  rounded[0] = Math.max(1, rounded[0] - drift)
  const scenarios: StructureScenario[] = picked
    .map((s, i) => ({
      id: 'A' as StructureScenario['id'],
      kind: s.kind,
      color: SCENARIO_COLORS[0],
      probability: rounded[i],
      title: s.title,
      why: s.why,
      invalidation: s.invalidation,
      side: s.side,
      path: s.path,
      target: s.target,
    }))
    .sort((a, b) => b.probability - a.probability)
    .map((s, i) => ({
      ...s,
      id: (['A', 'B', 'C', 'D'] as const)[i],
      color: SCENARIO_COLORS[i],
    }))

  const lead = scenarios[0]
  return {
    now: nowCopy(tape, trap, price, h4, d1),
    leadId: lead?.id ?? 'A',
    leadTitle: lead?.title ?? 'Ждём факт',
    scenarios,
  }
}
