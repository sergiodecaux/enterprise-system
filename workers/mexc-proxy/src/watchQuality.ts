/**
 * Live watch quality: acceptance (закреп), side strength/weakness,
 * opposing structure break, alt vs BTC relative strength,
 * HTF closes (1H / 4H / 1D) + zone rejection / failed breakout.
 */

type Candle = [number, number, number, number, number, number]
type Side = 'LONG' | 'SHORT'

export type HtfCloseColor = 'GREEN' | 'RED' | 'DOJI'

export interface HtfTfReading {
  tf: '1H' | '4H' | '1D'
  color: HtfCloseColor
  /** + for setup side, − against */
  score: number
  note: string
}

export interface HtfContext {
  readings: HtfTfReading[]
  /** Aggregate −6…+6 */
  score: number
  aligned: boolean
  /** Soft: don't READY if HTF strongly against */
  veto: boolean
  /** Hard: HTF rejection / failed break kills side */
  kill: boolean
  summary: string
}

export interface WatchQuality {
  acceptanceOk: boolean
  acceptanceNote: string
  structureOk: boolean
  structureNote: string
  /** Opposing BOS/CHoCH — hard fail */
  structureBroken: boolean
  btcRs: number | null
  strengthOk: boolean
  strengthNote: string
  /** Soft veto: do not READY yet */
  strengthVeto: boolean
  /** Hard veto: invalidate */
  strengthKill: boolean
  isBtc: boolean
  htf: HtfContext
}

function lastSwing(candles: Candle[], kind: 'high' | 'low'): number | null {
  if (candles.length < 10) return null
  const slice = candles.slice(0, -1)
  for (let i = slice.length - 3; i >= 2; i--) {
    const h = slice[i][2]
    const l = slice[i][3]
    if (
      kind === 'high' &&
      h > slice[i - 1][2] &&
      h > slice[i - 2][2] &&
      h > slice[i + 1][2] &&
      h >= (slice[i + 2]?.[2] ?? h)
    ) {
      return h
    }
    if (
      kind === 'low' &&
      l < slice[i - 1][3] &&
      l < slice[i - 2][3] &&
      l < slice[i + 1][3] &&
      l <= (slice[i + 2]?.[3] ?? l)
    ) {
      return l
    }
  }
  return kind === 'high'
    ? Math.max(...slice.slice(-20).map((c) => c[2]))
    : Math.min(...slice.slice(-20).map((c) => c[3]))
}

/** Alt relative strength vs BTC over ~24×1h bars (pct points) */
export function relStrengthVsBtc(
  alt1h: Candle[],
  btc1h: Candle[],
  lookback = 24
): number | null {
  if (alt1h.length < lookback + 1 || btc1h.length < lookback + 1) return null
  const a = alt1h.slice(-(lookback + 1))
  const b = btc1h.slice(-(lookback + 1))
  const a0 = a[0][4]
  const b0 = b[0][4]
  if (!(a0 > 0) || !(b0 > 0)) return null
  const altChg = ((a[a.length - 1][4] - a0) / a0) * 100
  const btcChg = ((b[b.length - 1][4] - b0) / b0) * 100
  return altChg - btcChg
}

/**
 * Закреп: ≥2 of last 3 closed 1m bars close on the correct side of zone mid
 * after price has been in/near the zone.
 */
export function detectAcceptance(opts: {
  side: Side
  zoneLow: number
  zoneHigh: number
  candles1m: Candle[]
  inZone: boolean
  reactionOk: boolean
}): { ok: boolean; note: string } {
  const mid = (opts.zoneLow + opts.zoneHigh) / 2
  const closed = opts.candles1m.slice(0, -1).slice(-6)
  if (closed.length < 3) {
    return { ok: false, note: 'закреп: мало 1m свечей' }
  }

  // Touched zone recently?
  const touched = closed.some((c) => {
    const [, , high, low] = c
    return low <= opts.zoneHigh * 1.002 && high >= opts.zoneLow * 0.998
  })
  if (!touched && !opts.inZone && !opts.reactionOk) {
    return { ok: false, note: 'закреп: зона ещё не тестировалась' }
  }

  const last3 = closed.slice(-3)
  let holds = 0
  for (const c of last3) {
    const close = c[4]
    if (opts.side === 'LONG' && close > mid) holds++
    if (opts.side === 'SHORT' && close < mid) holds++
  }

  if (holds >= 2) {
    return {
      ok: true,
      note:
        opts.side === 'LONG'
          ? `закреп LONG: ${holds}/3 закрытий выше mid зоны`
          : `закреп SHORT: ${holds}/3 закрытий ниже mid зоны`,
    }
  }

  // Explicit failure: was in zone / reaction but closes flip against side
  const against = last3.filter((c) =>
    opts.side === 'LONG' ? c[4] < mid * 0.999 : c[4] > mid * 1.001
  ).length
  if ((opts.inZone || opts.reactionOk) && against >= 2) {
    return {
      ok: false,
      note:
        opts.side === 'LONG'
          ? `нет закрепления — слабость: ${against}/3 закрытий ниже mid`
          : `нет закрепления — сила против шорта: ${against}/3 закрытий выше mid`,
    }
  }

  return {
    ok: false,
    note: `ждём закрепление (${holds}/3 за сторону)`,
  }
}

/**
 * Opposing structure: LTF (15m preferred, else 1m) BOS against setup side.
 * LONG killed by close below swing low; SHORT by close above swing high.
 */
export function detectOpposingStructure(opts: {
  side: Side
  candlesLtf: Candle[]
  invalidation: number
}): { broken: boolean; ok: boolean; note: string } {
  const c = opts.candlesLtf
  if (c.length < 16) {
    return { broken: false, ok: true, note: 'структура: мало LTF свечей' }
  }

  const closed = c[c.length - 2]
  const close = closed[4]
  const prev = c[c.length - 3]

  if (opts.side === 'LONG') {
    const swingLow = lastSwing(c, 'low')
    if (swingLow != null && close < swingLow && prev[4] >= swingLow * 0.999) {
      return {
        broken: true,
        ok: false,
        note: `слом структуры ↓: close ${close} < swing low ${swingLow} — слабость, не лонг`,
      }
    }
    // Soft: close through invalidation already handled elsewhere; here early BOS
    if (close < opts.invalidation && closed[3] < opts.invalidation) {
      return {
        broken: true,
        ok: false,
        note: `структура рушится в шорт — цена под inv ${opts.invalidation}`,
      }
    }
    return {
      broken: false,
      ok: true,
      note: swingLow != null
        ? `структура LONG жива (swing low ${swingLow})`
        : 'структура LONG ок',
    }
  }

  const swingHigh = lastSwing(c, 'high')
  if (swingHigh != null && close > swingHigh && prev[4] <= swingHigh * 1.001) {
    return {
      broken: true,
      ok: false,
      note: `слом структуры ↑: close ${close} > swing high ${swingHigh} — сила против шорта`,
    }
  }
  if (close > opts.invalidation && closed[2] > opts.invalidation) {
    return {
      broken: true,
      ok: false,
      note: `структура рушится в лонг — цена над inv ${opts.invalidation}`,
    }
  }
  return {
    broken: false,
    ok: true,
    note: swingHigh != null
      ? `структура SHORT жива (swing high ${swingHigh})`
      : 'структура SHORT ок',
  }
}

export function assessBtcRelativeStrength(opts: {
  side: Side
  symbol: string
  alt1h: Candle[]
  btc1h: Candle[] | null
}): {
  rs: number | null
  isBtc: boolean
  strengthOk: boolean
  strengthVeto: boolean
  strengthKill: boolean
  note: string
} {
  const sym = opts.symbol.toUpperCase()
  const isBtc =
    sym.includes('BTC_USDT') ||
    sym === 'BTCUSDT' ||
    sym.endsWith('/BTC') ||
    /(^|[^A-Z])BTC(_USDT|USDT)?$/.test(sym.replace('/', ''))

  if (isBtc) {
    return {
      rs: null,
      isBtc: true,
      strengthOk: true,
      strengthVeto: false,
      strengthKill: false,
      note: 'BTC — якорь рынка (RS не применяется)',
    }
  }

  const rs =
    opts.btc1h && opts.btc1h.length
      ? relStrengthVsBtc(opts.alt1h, opts.btc1h)
      : null

  if (rs == null) {
    return {
      rs: null,
      isBtc: false,
      strengthOk: true,
      strengthVeto: false,
      strengthKill: false,
      note: 'RS vs BTC: н/д',
    }
  }

  if (opts.side === 'LONG') {
    if (rs <= -10) {
      return {
        rs,
        isBtc: false,
        strengthOk: false,
        strengthVeto: true,
        strengthKill: true,
        note: `слабость альта vs BTC (${rs.toFixed(1)}%) — лонг снят`,
      }
    }
    if (rs <= -6) {
      return {
        rs,
        isBtc: false,
        strengthOk: false,
        strengthVeto: true,
        strengthKill: false,
        note: `слабость vs BTC (${rs.toFixed(1)}%) — не READY, ждём силу`,
      }
    }
    if (rs >= 3) {
      return {
        rs,
        isBtc: false,
        strengthOk: true,
        strengthVeto: false,
        strengthKill: false,
        note: `сила vs BTC (+${rs.toFixed(1)}%) — лонг поддержан`,
      }
    }
    return {
      rs,
      isBtc: false,
      strengthOk: true,
      strengthVeto: false,
      strengthKill: false,
      note: `RS vs BTC ${rs >= 0 ? '+' : ''}${rs.toFixed(1)}% — нейтрально`,
    }
  }

  // SHORT
  if (rs >= 10) {
    return {
      rs,
      isBtc: false,
      strengthOk: false,
      strengthVeto: true,
      strengthKill: true,
      note: `сила альта vs BTC (+${rs.toFixed(1)}%) — шорт снят`,
    }
  }
  if (rs >= 6) {
    return {
      rs,
      isBtc: false,
      strengthOk: false,
      strengthVeto: true,
      strengthKill: false,
      note: `сила vs BTC (+${rs.toFixed(1)}%) — не READY для шорта`,
    }
  }
  if (rs <= -3) {
    return {
      rs,
      isBtc: false,
      strengthOk: true,
      strengthVeto: false,
      strengthKill: false,
      note: `слабость vs BTC (${rs.toFixed(1)}%) — шорт поддержан`,
    }
  }
  return {
    rs,
    isBtc: false,
    strengthOk: true,
    strengthVeto: false,
    strengthKill: false,
    note: `RS vs BTC ${rs >= 0 ? '+' : ''}${rs.toFixed(1)}% — нейтрально`,
  }
}

function candleColor(c: Candle): HtfCloseColor {
  const [, o, , , close] = c
  const body = Math.abs(close - o)
  const range = Math.max(c[2] - c[3], 1e-12)
  if (body / range < 0.12) return 'DOJI'
  return close >= o ? 'GREEN' : 'RED'
}

function lastClosed(candles: Candle[]): Candle | null {
  if (candles.length < 2) return null
  return candles[candles.length - 2]!
}

/**
 * Zone story on a TF: touch → close back = rejection;
 * wick beyond zone then fail = failed breakout.
 */
function zoneStoryOnTf(opts: {
  tf: '1H' | '4H' | '1D'
  side: Side
  zoneLow: number
  zoneHigh: number
  candles: Candle[]
}): HtfTfReading | null {
  const closed = lastClosed(opts.candles)
  if (!closed) return null
  const [, open, high, low, close] = closed
  const color = candleColor(closed)
  const mid = (opts.zoneLow + opts.zoneHigh) / 2
  const weight = opts.tf === '1D' ? 3 : opts.tf === '4H' ? 2 : 1

  const touched =
    low <= opts.zoneHigh * 1.002 && high >= opts.zoneLow * 0.998

  // Failed upside break (good for SHORT): pierced above zone, closed back below
  const failedBreakUp =
    high > opts.zoneHigh * 1.001 && close < opts.zoneHigh * 0.9995
  // Failed downside break (good for LONG): pierced below zone, closed back above
  const failedBreakDown =
    low < opts.zoneLow * 0.999 && close > opts.zoneLow * 1.0005

  // Rejection: into zone then close on opposite side of mid
  const rejectForShort =
    touched && close < mid && (color === 'RED' || failedBreakUp)
  const rejectForLong =
    touched && close > mid && (color === 'GREEN' || failedBreakDown)

  let score = 0
  let note = ''

  if (opts.side === 'LONG') {
    if (color === 'GREEN') {
      score += weight
      note = `${opts.tf} закрыли зелёным — плюс к лонгу`
    } else if (color === 'RED') {
      score -= weight
      note = `${opts.tf} закрыли красным — минус к лонгу`
    } else {
      note = `${opts.tf} дожи — нейтрально`
    }
    if (failedBreakDown || rejectForLong) {
      score += weight
      note = `${opts.tf}: отбой от зоны / неудачный пробой вниз — сила для лонга`
    }
    if (failedBreakUp && close < mid) {
      score -= weight + 1
      note = `${opts.tf}: пришли в зону, отскочили и закрылись ниже — слабость, намёк на шорт`
    }
  } else {
    if (color === 'RED') {
      score += weight
      note = `${opts.tf} закрыли красным — плюс к шорту`
    } else if (color === 'GREEN') {
      score -= weight
      note = `${opts.tf} закрыли зелёным — минус к шорту`
    } else {
      note = `${opts.tf} дожи — нейтрально`
    }
    if (failedBreakUp || rejectForShort) {
      score += weight
      note = `${opts.tf}: отбой от зоны / неудачный пробой вверх — сила для шорта`
    }
    if (failedBreakDown && close > mid) {
      score -= weight + 1
      note = `${opts.tf}: зона удержалась снизу — слабость шорта`
    }
  }

  return { tf: opts.tf, color, score, note }
}

/**
 * Global HTF stack: 1H + 4H + 1D closes and zone rejection stories.
 */
export function analyzeHtfContext(opts: {
  side: Side
  zoneLow: number
  zoneHigh: number
  candles1h: Candle[]
  candles4h: Candle[]
  candles1d: Candle[]
}): HtfContext {
  const readings: HtfTfReading[] = []
  const r1 = zoneStoryOnTf({
    tf: '1H',
    side: opts.side,
    zoneLow: opts.zoneLow,
    zoneHigh: opts.zoneHigh,
    candles: opts.candles1h,
  })
  const r4 = zoneStoryOnTf({
    tf: '4H',
    side: opts.side,
    zoneLow: opts.zoneLow,
    zoneHigh: opts.zoneHigh,
    candles: opts.candles4h,
  })
  const rD = zoneStoryOnTf({
    tf: '1D',
    side: opts.side,
    zoneLow: opts.zoneLow,
    zoneHigh: opts.zoneHigh,
    candles: opts.candles1d,
  })
  if (r1) readings.push(r1)
  if (r4) readings.push(r4)
  if (rD) readings.push(rD)

  const score = readings.reduce((a, r) => a + r.score, 0)
  const aligned = score >= 0
  // Soft: delay READY when HTF stack clearly against — never instant kill on color alone
  const veto = score <= -4
  // Hard kill only if HTF zone story is a clear failed-break against our side
  const againstBreak = readings.some(
    (r) =>
      (r.tf === '1D' || r.tf === '4H') &&
      r.score <= -3 &&
      (r.note.includes('намёк на шорт') ||
        r.note.includes('слабость шорта') ||
        r.note.includes('слабость, намёк'))
  )
  const kill = score <= -7 && againstBreak

  const parts = readings.map((r) => {
    const icon = r.color === 'GREEN' ? '🟢' : r.color === 'RED' ? '🔴' : '⚪'
    return `${icon}${r.tf}`
  })
  const topNotes = readings
    .slice()
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 2)
    .map((r) => r.note)

  const summary =
    readings.length === 0
      ? 'HTF: нет данных 1H/4H/1D'
      : `HTF ${parts.join(' ')} · score ${score >= 0 ? '+' : ''}${score}${
          topNotes.length ? ` · ${topNotes[0]}` : ''
        }`

  return { readings, score, aligned, veto, kill, summary }
}

export function assessWatchQuality(opts: {
  side: Side
  symbol: string
  zoneLow: number
  zoneHigh: number
  invalidation: number
  inZone: boolean
  reactionOk: boolean
  candles1m: Candle[]
  candles15m: Candle[]
  candles1h: Candle[]
  candles4h?: Candle[]
  candles1d?: Candle[]
  btc1h: Candle[] | null
}): WatchQuality {
  const acceptance = detectAcceptance({
    side: opts.side,
    zoneLow: opts.zoneLow,
    zoneHigh: opts.zoneHigh,
    candles1m: opts.candles1m,
    inZone: opts.inZone,
    reactionOk: opts.reactionOk,
  })

  const ltf = opts.candles15m.length >= 16 ? opts.candles15m : opts.candles1m
  const structure = detectOpposingStructure({
    side: opts.side,
    candlesLtf: ltf,
    invalidation: opts.invalidation,
  })

  const strength = assessBtcRelativeStrength({
    side: opts.side,
    symbol: opts.symbol,
    alt1h: opts.candles1h,
    btc1h: opts.btc1h,
  })

  const htf = analyzeHtfContext({
    side: opts.side,
    zoneLow: opts.zoneLow,
    zoneHigh: opts.zoneHigh,
    candles1h: opts.candles1h,
    candles4h: opts.candles4h ?? [],
    candles1d: opts.candles1d ?? [],
  })

  return {
    acceptanceOk: acceptance.ok,
    acceptanceNote: acceptance.note,
    structureOk: structure.ok,
    structureNote: structure.note,
    structureBroken: structure.broken,
    btcRs: strength.rs,
    strengthOk: strength.strengthOk,
    strengthNote: strength.note,
    strengthVeto: strength.strengthVeto || htf.veto,
    strengthKill: strength.strengthKill || htf.kill,
    isBtc: strength.isBtc,
    htf,
  }
}
