import type { CoinSignal, MemeSignal } from '../../engine/types'
import type { SniperSignal } from '../../engine/sniperMode'
import type { ConditionalSetup } from '../../engine/setups/types'
import { sendTelegramAlert } from '../../api/telegram/alerts'
import { assertUsdtPerpetual } from '../../api/mexc/perpetualGuard'
import { toApiSymbol } from '../../api/mexc'

function fmt(price: number): string {
  if (!(price > 0)) return '—'
  if (price >= 1000) return price.toFixed(2)
  if (price >= 1) return price.toFixed(4)
  if (price >= 0.01) return price.toFixed(6)
  return price.toFixed(8)
}

function pct(from: number, to: number): string {
  if (!from) return '—'
  const p = ((to - from) / from) * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
}

function rrLabel(entry: number, sl: number, tp: number): string {
  const risk = Math.abs(entry - sl)
  if (risk <= 0) return '—'
  return `1:${(Math.abs(tp - entry) / risk).toFixed(1)}`
}

function mexcContract(symbol: string): string {
  // App uses BTCUSDT / BTC_USDT — normalize to MEXC futures form
  if (symbol.includes('_')) return symbol.toUpperCase()
  if (symbol.endsWith('USDT') && !symbol.includes('_')) {
    return symbol.replace(/USDT$/i, '_USDT').toUpperCase()
  }
  return symbol.toUpperCase()
}

function tradeBlock(opts: {
  side: 'LONG' | 'SHORT'
  contract: string
  entry: number
  sl: number
  tp: number
  winPct: number
  reason: string
  extras?: string[]
  /** Pullback-limit mode (memes / fast markets) */
  pullback?: {
    signalPrice: number
    zoneLow: number
    zoneHigh: number
    invalidate: number
  }
}): string {
  const lines = [
    `Биржа: MEXC Futures`,
    `Контракт: ${opts.contract}`,
  ]

  if (opts.pullback) {
    const chase =
      opts.side === 'LONG'
        ? `Не входить / не догонять выше ${fmt(opts.pullback.invalidate)}`
        : `Не входить / не догонять ниже ${fmt(opts.pullback.invalidate)}`
    lines.push(
      '',
      `Цена сигнала: ${fmt(opts.pullback.signalPrice)} (уже могла уйти)`,
      `Тип входа: ЛИМИТ на откат — не маркет-chase`,
      `Зона входа: ${fmt(opts.pullback.zoneLow)} – ${fmt(opts.pullback.zoneHigh)}`,
      `Лимитка (ориентир): ${fmt(opts.entry)}`,
      chase
    )
  } else {
    lines.push('', `Вход: ${fmt(opts.entry)}`)
  }

  lines.push(
    '',
    `Стоп: ${fmt(opts.sl)} (${pct(opts.entry, opts.sl)})`,
    `Цель: ${fmt(opts.tp)} (${pct(opts.entry, opts.tp)})`,
    `Победа: ${opts.winPct}%`,
    `R:R ${rrLabel(opts.entry, opts.sl, opts.tp)}`,
    '',
    `Причина: ${opts.reason}`
  )
  if (opts.extras?.length) {
    lines.push('', ...opts.extras)
  }
  if (opts.pullback) {
    lines.push(
      '',
      '⚠️ Мем/импульс: если цена уже вне зоны — пропуск, жди откат или следующий сигнал.'
    )
  }
  lines.push(
    '',
    'Ищи в MEXC → Фьючерсы → USDT-M → точное имя контракта выше.'
  )
  return lines.join('\n')
}

/** Формат снайперского сигнала для Telegram */
function scoreCardBlock(
  card: NonNullable<CoinSignal['scoreCard']>
): string[] {
  const gradeEmoji =
    card.grade === 'A+'
      ? '🏆'
      : card.grade === 'A'
        ? '⭐'
        : card.grade === 'B'
          ? '📊'
          : '❌'
  const lines = [
    `${gradeEmoji} ScoreCard ${card.grade} · ${card.totalScore}/${card.maxScore} (${card.percent}%)`,
  ]

  if (card.dataQuality) {
    const dq = card.dataQuality
    const emoji =
      dq.overall === 'EXCELLENT'
        ? '🟢'
        : dq.overall === 'GOOD'
          ? '🟡'
          : dq.overall === 'FAIR'
            ? '🟠'
            : '🔴'
    lines.push(
      `${emoji} Data Quality: ${dq.overall} (${dq.overallScore}/100) · CVD ${dq.cvdSource}`
    )
    if (dq.penalties.length > 0) {
      lines.push(...dq.penalties.slice(0, 2).map((p) => `• ${p}`))
    }
  }

  lines.push('CONFLUENCE:')
  for (const [, f] of Object.entries(card.factors)) {
    const filled = Math.round(f.score)
    const bar =
      '█'.repeat(Math.min(f.max, filled)) +
      '░'.repeat(Math.max(0, f.max - filled))
    lines.push(`${bar} ${f.reason}`)
  }
  if (!card.ready && card.missingFactors.length) {
    lines.push(`Missing: ${card.missingFactors.slice(0, 3).join('; ')}`)
  }
  return lines
}

export function formatSniperTelegramMessage(signal: SniperSignal): {
  title: string
  text: string
  dedupeKey: string
} {
  const direction = signal.direction === 'SHORT' ? 'SHORT' : 'LONG'
  const style =
    signal.tradeStyle === 'SCALP'
      ? 'SCALP'
      : signal.tradeStyle === 'SWING'
        ? 'SWING'
        : 'INTRADAY'
  const icon = direction === 'LONG' ? '🟢' : '🔴'
  const contract = mexcContract(signal.symbol)
  const grade = signal.scoreCard?.grade
  const title = `${icon} ${direction} ${signal.displayName} · ${style}${
    grade ? ` · ${grade}` : ''
  }`

  const reason =
    signal.sniperReasons.slice(0, 3).join('; ') ||
    `${style} setup · conf ${signal.calibratedWinRate}%`

  const extras = [
    `Risk ${signal.riskPercent.toFixed(2)}% · Reward ${signal.rewardPercent.toFixed(2)}%`,
    ...(signal.sniperReasons.slice(0, 5).map((r) => `• ${r}`)),
  ]
  if (signal.scoreCard) {
    extras.push(...scoreCardBlock(signal.scoreCard))
  }
  if (signal.marketRegime) {
    extras.push(`Regime: ${signal.marketRegime}`)
  }
  if (signal.sessionQuality) {
    extras.push(
      `Session: ${signal.sessionQuality.session} (${signal.sessionQuality.score})`
    )
  }

  const text = tradeBlock({
    side: direction,
    contract,
    entry: signal.entryPrice,
    sl: signal.sl!,
    tp: signal.tp1!,
    winPct: Math.round(signal.calibratedWinRate),
    reason,
    extras,
  })

  return {
    title,
    text,
    dedupeKey: `sniper:${signal.symbol}:${direction}:${signal.tradeStyle}`,
  }
}

function inferMemeSide(meme: MemeSignal): 'LONG' | 'SHORT' {
  if (meme.shortBlocked && !meme.longBlocked) return 'LONG'
  if (meme.longBlocked && !meme.shortBlocked) return 'SHORT'
  if (meme.backside?.detected) return 'SHORT'
  if (meme.bidVoid?.detected) return 'SHORT'
  if (meme.squeeze?.detected || meme.flatline?.detected) return 'LONG'
  if (meme.priceChange24h < -8 && meme.heatScore >= 60) return 'SHORT'
  return 'LONG'
}

function memeEntryPlan(
  side: 'LONG' | 'SHORT',
  signalPrice: number,
  volScore: number
): {
  entryIdeal: number
  zoneLow: number
  zoneHigh: number
  invalidate: number
  sl: number
  tp: number
} {
  const pullPct = Math.min(0.025, Math.max(0.008, 0.01 + volScore / 8000))
  const chasePct = pullPct * 0.45
  const riskPct = Math.min(0.035, Math.max(0.012, pullPct * 1.6))
  const rewardPct = riskPct * 2.2

  if (side === 'LONG') {
    const zoneLow = signalPrice * (1 - pullPct)
    const zoneHigh = signalPrice * (1 + chasePct * 0.25)
    const entryIdeal = (zoneLow + signalPrice) / 2
    return {
      entryIdeal,
      zoneLow,
      zoneHigh,
      invalidate: signalPrice * (1 + chasePct),
      sl: entryIdeal * (1 - riskPct),
      tp: entryIdeal * (1 + rewardPct),
    }
  }

  const zoneHigh = signalPrice * (1 + pullPct)
  const zoneLow = signalPrice * (1 - chasePct * 0.25)
  const entryIdeal = (zoneHigh + signalPrice) / 2
  return {
    entryIdeal,
    zoneLow,
    zoneHigh,
    invalidate: signalPrice * (1 - chasePct),
    sl: entryIdeal * (1 + riskPct),
    tp: entryIdeal * (1 - rewardPct),
  }
}

export function formatMemeTelegramMessage(meme: MemeSignal): {
  title: string
  text: string
  dedupeKey: string
} {
  const setup = meme.setupTag ?? meme.quality
  const side = inferMemeSide(meme)
  const icon = side === 'LONG' ? '🟢' : '🔴'
  const contract = mexcContract(meme.symbol)
  const title = `${icon} ${side} ${meme.displayName} · ${setup}`

  const plan = memeEntryPlan(side, meme.price, meme.volatility?.gauge ?? 40)
  const winPct = Math.round(
    Math.min(82, Math.max(55, 50 + meme.heatScore * 0.28))
  )

  const reasons: string[] = []
  if (meme.criticalAlert) reasons.push(meme.criticalAlert)
  if (meme.lifecycle) reasons.push(`Фаза: ${meme.lifecycle.badge}`)
  if (meme.squeeze?.detected) reasons.push('Short squeeze / funding fuel')
  if (meme.flatline?.detected) reasons.push('Flatline ignition')
  if (meme.backside?.detected) reasons.push('Backside short')
  if (meme.volumeSpike?.detected)
    reasons.push(`Vol spike ×${meme.volumeSpike.volumeMultiplier.toFixed(1)}`)
  if (!reasons.length) {
    reasons.push(`Heat ${meme.heatScore}/100 · ${meme.quality}`)
  }

  const text = tradeBlock({
    side,
    contract,
    entry: plan.entryIdeal,
    sl: plan.sl,
    tp: plan.tp,
    winPct,
    reason: reasons.slice(0, 3).join('; '),
    pullback: {
      signalPrice: meme.price,
      zoneLow: plan.zoneLow,
      zoneHigh: plan.zoneHigh,
      invalidate: plan.invalidate,
    },
    extras: [
      `Heat/Fuel: ${meme.heatScore}/100`,
      `24h: ${meme.priceChange24h >= 0 ? '+' : ''}${meme.priceChange24h.toFixed(2)}%`,
      meme.longBlocked ? '🔒 LONG LOCKED' : '',
      meme.shortBlocked ? '🔒 SHORT LOCKED' : '',
    ].filter(Boolean),
  })

  return {
    title,
    text,
    dedupeKey: `meme:${meme.symbol}:${meme.setupTag ?? meme.quality}`,
  }
}

export async function pushSniperAlert(signal: SniperSignal): Promise<void> {
  const check = await assertUsdtPerpetual(signal.symbol)
  if (!check.ok) return
  const msg = formatSniperTelegramMessage(signal)
  await sendTelegramAlert({
    type: 'SNIPER',
    title: msg.title,
    text: msg.text,
    dedupeKey: msg.dedupeKey,
  })
}

export async function pushMemeAlert(
  meme: MemeSignal,
  chatId?: number
): Promise<void> {
  const check = await assertUsdtPerpetual(meme.symbol)
  if (!check.ok) return
  const msg = formatMemeTelegramMessage(meme)
  await sendTelegramAlert({
    type: 'MEME',
    title: msg.title,
    text: msg.text,
    dedupeKey: msg.dedupeKey,
    chatId,
  })
}

/** Soft signal (triggered setup) → sniper-quality check done by caller */
export async function pushCoinSignalAlert(
  signal: CoinSignal & { calibratedWinRate?: number }
): Promise<void> {
  if (!signal.direction || signal.sl == null || signal.tp1 == null) return

  const check = await assertUsdtPerpetual(signal.symbol)
  if (!check.ok) return

  const direction = signal.direction
  const entry = signal.ltfChoCH?.surgicalEntryPrice ?? signal.price
  const winPct = Math.round(
    signal.styleConfidence ??
      signal.calibratedWinRate ??
      signal.probabilityPct ??
      60
  )
  const contract = check.apiSymbol
  const icon = direction === 'LONG' ? '🟢' : '🔴'
  const style =
    signal.tradeStyle === 'SCALP'
      ? 'SCALP'
      : signal.tradeStyle === 'SWING'
        ? 'SWING'
        : 'INTRADAY'

  await sendTelegramAlert({
    type: 'SNIPER',
    title: `${icon} ${direction} ${signal.displayName} · ${style}`,
    text: tradeBlock({
      side: direction,
      contract,
      entry,
      sl: signal.sl,
      tp: signal.tp1,
      winPct,
      reason:
        signal.zones.slice(0, 3).join('; ') ||
        `Score ${signal.score}/10 · Prob ${signal.probabilityPct}%`,
      extras: signal.zones.slice(0, 4).map((z) => `• ${z}`),
    }),
    dedupeKey: `coin:${signal.symbol}:${direction}:${Math.round(entry * 1000)}`,
  })
}

/** Ack: бот начал следить за зонами — ждите ювелирный сигнал */
export async function pushZoneWatchAck(opts: {
  symbol: string
  displayName?: string
  price: number
  zones: {
    side: 'LONG' | 'SHORT'
    label: string
    mid: number
    limitEntry: number
    target: number
    invalidation: number
  }[]
  setupsCount: number
  chatId?: number
}): Promise<{ ok: boolean; reason?: string }> {
  // Soft symbol normalize — don't block ack on live funding/OI checks
  const apiSymbol = toApiSymbol(opts.symbol)
  if (!apiSymbol.endsWith('_USDT') || apiSymbol.length < 7) {
    return { ok: false, reason: `bad_symbol:${opts.symbol}→${apiSymbol}` }
  }
  if (opts.chatId == null) {
    return { ok: false, reason: 'no_chat_id' }
  }

  const name = opts.displayName ?? opts.symbol.replace('_USDT', '/USDT')
  const lines = opts.zones.slice(0, 6).map((z) => {
    const icon = z.side === 'LONG' ? '🟢' : '🔴'
    return `${icon} ${z.side} · ${z.label}\n   зона @ ${fmt(z.mid)} · лимит ${fmt(z.limitEntry)}\n   SL ${fmt(z.invalidation)} · TP ${fmt(z.target)}`
  })

  const result = await sendTelegramAlert({
    type: 'SETUP_WATCH',
    title: `👁 Слежу за зонами · ${name}`,
    text: [
      `Монета: ${name} (${apiSymbol})`,
      `Цена сейчас: ${fmt(opts.price)}`,
      `Вариантов сделок: ${opts.setupsCount}`,
      '',
      'Зоны под наблюдением:',
      ...(lines.length ? lines : ['(зоны будут уточнены при касании)']),
      '',
      'Жди сигнал «💎 Ювелирный LONG/SHORT» когда:',
      '• цена войдёт в зону',
      '• стакан подтвердит сторону',
      '• будет реакция / reclaim',
      '',
      'Не входи заранее — только по READY.',
    ].join('\n'),
    dedupeKey: `zone_watch:${apiSymbol}:${opts.chatId}:${Math.floor(Date.now() / 30_000)}`,
    chatId: opts.chatId,
  })

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason ?? 'send_failed',
    }
  }
  return { ok: true }
}

/** Ювелирный вход из найденной зоны ликвидности */
export async function pushJewelEntryAlert(opts: {
  setup: ConditionalSetup
  symbol: string
  displayName?: string
  price: number
  chatId?: number
}): Promise<void> {
  const { setup, symbol, price } = opts
  const check = await assertUsdtPerpetual(symbol)
  if (!check.ok) return

  const contract = check.apiSymbol
  const name = opts.displayName ?? symbol.replace('_USDT', '/USDT')
  const icon = setup.side === 'LONG' ? '🟢' : '🔴'
  const winPct = Math.round(Math.min(88, Math.max(55, setup.probability)))
  const title = `💎 ${icon} Ювелирный ${setup.side} · ${name}`

  await sendTelegramAlert({
    type: 'SETUP_WATCH',
    title,
    text: [
      tradeBlock({
        side: setup.side,
        contract,
        entry: setup.limitEntry,
        sl: setup.invalidation,
        tp: setup.target,
        winPct,
        reason: setup.triggerSummary,
        extras: [
          `Зона: ${fmt(setup.entryZone.bottom)} – ${fmt(setup.entryZone.top)}`,
          `Сетап: ${setup.title}`,
          `Статус: ${setup.status}`,
          `Цена сейчас: ${fmt(price)}`,
          ...setup.preconditions.map(
            (p) => `${p.status === 'MET' ? '✓' : p.status === 'FAILED' ? '✗' : '·'} ${p.label}`
          ),
          ...setup.reasoning.slice(0, 3),
        ],
        pullback: {
          signalPrice: price,
          zoneLow: setup.entryZone.bottom,
          zoneHigh: setup.entryZone.top,
          invalidate:
            setup.side === 'LONG'
              ? setup.entryZone.top * 1.004
              : setup.entryZone.bottom * 0.996,
        },
      }),
    ].join('\n'),
    dedupeKey: `jewel:${contract}:${setup.side}:${setup.limitEntry.toPrecision(6)}`,
    chatId: opts.chatId,
  })
}
