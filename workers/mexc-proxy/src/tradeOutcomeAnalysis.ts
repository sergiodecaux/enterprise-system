/**
 * Immediate win/loss reason analysis for bot journal closes.
 * Pure classifier — no KV / network.
 */

export type OutcomeTone = 'win' | 'loss' | 'neutral' | 'skip'

export interface OutcomeAnalysisInput {
  status: 'OPEN' | 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT' | 'INVALIDATED'
  side: 'LONG' | 'SHORT'
  setup: string
  alertType: 'SNIPER' | 'MEME'
  pnlPercent: number | null
  rMultiple: number | null
  mfePercent: number
  maePercent: number
  closeReason?: string | null
  resolveSource?: 'AUTO' | 'TIMEOUT' | null
  /** Optional historical WR for this setup (0–100), if enough samples */
  setupWinRate?: number | null
  setupSampleN?: number | null
  /** Entry autopsy codes from peak / scanner */
  entryReasons?: string[] | null
  qualityTier?: 'A' | 'B' | null
}

export interface TradeOutcomeAnalysis {
  closeReason: string | null
  primaryTag: string
  tags: string[]
  headline: string
  detail: string
  lesson: string
  tone: OutcomeTone
}

function reasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case 'tp':
      return 'тейк-профит'
    case 'sl':
      return 'стоп-лосс'
    case 'trail':
      return 'трейлинг'
    case 'dead_entry':
      return 'мёртвый вход'
    case 'time_stop':
      return 'тайм-стоп'
    case 'invalidate':
      return 'инвалидация'
    case 'timeout_waiting':
      return 'зона не взята'
    case 'timeout_open':
      return 'таймаут в позиции'
    default:
      return reason || 'авто'
  }
}

function captureQuality(mfe: number, mae: number): 'clean' | 'messy' | 'dead' {
  if (mfe < 0.2 && mae >= 0.15) return 'dead'
  if (mfe > 0 && mae > mfe * 1.4) return 'messy'
  if (mfe >= 0.4 && mae <= mfe * 0.7) return 'clean'
  return mfe < 0.25 ? 'dead' : 'messy'
}

/**
 * Classify why a resolved bot trade won / lost / timed out.
 */
export function analyzeTradeOutcome(
  input: OutcomeAnalysisInput
): TradeOutcomeAnalysis | null {
  if (input.status === 'OPEN') return null

  const mfe = Math.max(0, input.mfePercent || 0)
  const mae = Math.max(0, input.maePercent || 0)
  const pnl = input.pnlPercent ?? 0
  const r = input.rMultiple ?? 0
  const reason = input.closeReason ?? null
  const tags: string[] = []
  const quality = captureQuality(mfe, mae)

  if (input.alertType === 'MEME') tags.push('MEME')
  else tags.push('ALTS')
  if (input.setup === 'PEAK_FUEL_FAIL') tags.push('PEAK')
  if (input.setup === 'DUMP_FUEL_FAIL') tags.push('DUMP_RECLAIM')
  if (input.setup === 'PUMP_CONTINUE') tags.push('PUMP_SQUEEZE')
  if (input.qualityTier) tags.push(`Q_${input.qualityTier}`)

  const entryBits = (input.entryReasons ?? []).filter(Boolean)
  const stallOnlyEntry =
    entryBits.includes('stall_at_high') &&
    !entryBits.includes('failed_break') &&
    !entryBits.includes('rejection_wick') &&
    !entryBits.includes('ask_absorption')

  let primaryTag = 'RESOLVED'
  let headline = 'Сделка закрыта'
  let detail = ''
  let lesson = ''
  let tone: OutcomeTone = 'neutral'

  if (input.status === 'INVALIDATED') {
    primaryTag = reason === 'timeout_waiting' ? 'ZONE_MISS' : 'NO_ENTRY'
    tags.push(primaryTag)
    tone = 'skip'
    headline =
      primaryTag === 'ZONE_MISS'
        ? 'Зона не взята'
        : 'Вход не состоялся'
    detail =
      primaryTag === 'ZONE_MISS'
        ? `Цена не дала лимит в зоне до TTL (${reasonLabel(reason)}).`
        : `Сетап снят до входа (${reasonLabel(reason)}). PnL не считаем.`
    lesson =
      'Не форсировать маркет вне зоны — ждать reclaim / следующий сетап.'
  } else if (input.status === 'BE') {
    primaryTag = 'BREAKEVEN'
    tags.push(primaryTag, 'PROTECTED')
    tone = 'neutral'
    headline = 'Безубыток'
    detail = `Закрытие около нуля (${reasonLabel(reason)}). MFE +${mfe.toFixed(2)}% · MAE −${mae.toFixed(2)}%.`
    lesson =
      mfe >= 0.5
        ? 'Был прогресс — можно раньше подтягивать BE / частичный TP.'
        : 'Защита отработала; вход был слабый по топливу.'
  } else if (input.status === 'TIMEOUT') {
    primaryTag =
      reason === 'dead_entry'
        ? 'DEAD_ENTRY'
        : reason === 'time_stop'
          ? 'TIME_STOP'
          : 'TIMEOUT'
    tags.push(primaryTag)
    if (quality === 'dead') tags.push('NO_FUEL')
    tone = pnl < -0.05 ? 'loss' : 'neutral'
    headline =
      primaryTag === 'DEAD_ENTRY'
        ? 'Мёртвый вход'
        : primaryTag === 'TIME_STOP'
          ? 'Время вышло'
          : 'Таймаут'
    detail =
      primaryTag === 'DEAD_ENTRY'
        ? `После входа не было прогресса (MFE +${mfe.toFixed(2)}%). Срезали раньше полного SL.`
        : `Позиция истекла без TP/SL (${reasonLabel(reason)}). PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% · MFE +${mfe.toFixed(2)}% · MAE −${mae.toFixed(2)}%.`
    lesson =
      primaryTag === 'DEAD_ENTRY'
        ? 'Требовать подтверждение импульса в первые минуты — иначе skip.'
        : mfe > Math.abs(pnl) + 0.3
          ? 'Импульс был, цель далеко — ужать TP или раньше трейлить.'
          : 'Слабое продолжение — ужесточить фильтр setup / score.'
  } else if (input.status === 'WIN') {
    tone = 'win'
    if (reason === 'tp') {
      primaryTag = quality === 'clean' ? 'CLEAN_TP' : 'TP_WITH_DRAWDOWN'
      tags.push('TP', primaryTag)
      headline = primaryTag === 'CLEAN_TP' ? 'Чистый тейк' : 'Тейк с просадкой'
      detail =
        primaryTag === 'CLEAN_TP'
          ? `Цель взята чисто. +${pnl.toFixed(2)}% (${r.toFixed(2)}R). MFE +${mfe.toFixed(2)}%.`
          : `TP взят, но путь был грязный (MAE −${mae.toFixed(2)}% vs MFE +${mfe.toFixed(2)}%). +${pnl.toFixed(2)}%.`
      lesson =
        primaryTag === 'CLEAN_TP'
          ? 'Паттерн рабочий — можно чуть раньше входить / держать runner.'
          : 'TP ок, но вход/стоп стоит ужесточить — глубокая MAE.'
    } else if (reason === 'trail') {
      const gaveBack = mfe > 0 && pnl < mfe * 0.55
      primaryTag = gaveBack ? 'TRAIL_GAVE_BACK' : 'TRAIL_WIN'
      tags.push('TRAIL', primaryTag)
      headline = gaveBack ? 'Трейл, отдали пик' : 'Трейлинг в плюс'
      detail = gaveBack
        ? `Пик MFE +${mfe.toFixed(2)}%, зафиксировали только +${pnl.toFixed(2)}%. Трейл сработал поздно/широко.`
        : `Трейлинг зафиксировал +${pnl.toFixed(2)}% (${r.toFixed(2)}R) при MFE +${mfe.toFixed(2)}%.`
      lesson = gaveBack
        ? 'Подтягивать трейл агрессивнее после +0.5–0.8R / частичный TP1.'
        : 'Трейл отработал — оставляем правило для этого setup.'
    } else {
      primaryTag = 'WIN_OTHER'
      tags.push(primaryTag)
      headline = 'Победа'
      detail = `+${pnl.toFixed(2)}% (${r.toFixed(2)}R) · выход через ${reasonLabel(reason)}. MFE +${mfe.toFixed(2)}%.`
      lesson = 'Зафиксировать условия входа — повторять при том же контексте.'
    }
    if (mfe >= 1.2 && pnl >= 0.6) tags.push('STRONG_IMPULSE')
  } else {
    // LOSS
    tone = 'loss'
    if (reason === 'dead_entry' || (quality === 'dead' && mfe < 0.25)) {
      primaryTag = 'DEAD_ENTRY'
      tags.push('DEAD_ENTRY', 'NO_FUEL')
      headline = 'Стоп без топлива'
      detail = `Цена сразу против: MFE всего +${mfe.toFixed(2)}%, MAE −${mae.toFixed(2)}%. ${reasonLabel(reason)} → ${pnl.toFixed(2)}%.`
      lesson =
        'Не входить без подтверждения давления/absorb в первые 1–4 мин.'
    } else if (reason === 'sl') {
      if (mfe >= 0.45) {
        primaryTag = 'REVERSAL_AFTER_MFE'
        tags.push('SL', primaryTag)
        headline = 'Разворот после прогресса'
        detail = `Был MFE +${mfe.toFixed(2)}%, затем полный SL (${pnl.toFixed(2)}%, ${r.toFixed(2)}R). Не защитили прибыль.`
        lesson =
          'После MFE ≥0.5% переводить в BE / частичный TP — не отдавать весь R.'
      } else {
        primaryTag = 'STOPPED_COLD'
        tags.push('SL', primaryTag)
        headline = 'Холодный стоп'
        detail = `SL без нормального прогресса. MFE +${mfe.toFixed(2)}% · MAE −${mae.toFixed(2)}% · ${pnl.toFixed(2)}%.`
        lesson =
          'Либо зона/направление ошибочны, либо вход против потока — резать такие setup.'
      }
    } else if (reason === 'trail') {
      primaryTag = 'TRAIL_LOSS'
      tags.push('TRAIL', primaryTag)
      headline = 'Трейл в минус'
      detail = `После пика MFE +${mfe.toFixed(2)}% трейл закрыл ${pnl.toFixed(2)}%.`
      lesson =
        'Трейл слишком близко к цене при шуме или вход был на исходе импульса.'
    } else if (reason === 'time_stop') {
      primaryTag = 'TIME_STOP_LOSS'
      tags.push('TIME_STOP', primaryTag)
      headline = 'Тайм-стоп в минус'
      detail = `Время вышло в минусе ${pnl.toFixed(2)}%. MFE +${mfe.toFixed(2)}% · MAE −${mae.toFixed(2)}%.`
      lesson = 'Идея не развилась — ужесточить фильтр «продолжения дня» / score.'
    } else {
      primaryTag = 'LOSS_OTHER'
      tags.push(primaryTag)
      headline = 'Поражение'
      detail = `${pnl.toFixed(2)}% (${r.toFixed(2)}R) · ${reasonLabel(reason)}. MFE +${mfe.toFixed(2)}% · MAE −${mae.toFixed(2)}%.`
      lesson = 'Сверить сторону с дневным bias и давлением стакана на входе.'
    }
    if (mae > mfe * 2 && mae >= 0.5) tags.push('DEEP_ADVERSE')
  }

  if (
    input.setupWinRate != null &&
    input.setupSampleN != null &&
    input.setupSampleN >= 5
  ) {
    const wr = input.setupWinRate
    if (input.status === 'LOSS' && wr < 40) {
      lesson += ` Исторически ${input.setup}: WR ${wr.toFixed(0)}% (n=${input.setupSampleN}) — слабый тег.`
      tags.push('WEAK_SETUP_HIST')
    } else if (input.status === 'WIN' && wr >= 60) {
      lesson += ` Тег ${input.setup} сильный в журнале (WR ${wr.toFixed(0)}%, n=${input.setupSampleN}).`
      tags.push('STRONG_SETUP_HIST')
    } else if (input.status === 'LOSS' && wr >= 60) {
      lesson += ` Редкий проигрыш сильного тега ${input.setup} (WR ${wr.toFixed(0)}%).`
    }
  }

  // PEAK/DUMP autopsy from entry reasons
  if (
    (input.setup === 'PEAK_FUEL_FAIL' ||
      input.setup === 'DUMP_FUEL_FAIL' ||
      input.setup === 'PUMP_CONTINUE') &&
    entryBits.length
  ) {
    tags.push('ENTRY_REASONS')
    if (input.status === 'LOSS') {
      if (stallOnlyEntry) {
        lesson +=
          ' PEAK: stall-only без failed/wick/absorb — ужесточить A-tier (не торговать).'
        tags.push('PEAK_STALL_WEAK')
      }
      if (!entryBits.includes('post_dump')) {
        lesson +=
          ' PEAK: шорт без слива с пика (tip-of-pump) — ждать dump + lower high как на UB.'
        tags.push('PEAK_NO_POST_DUMP')
      }
      const dump = entryBits.find((r) => r.startsWith('dump:'))
      if (dump) {
        const d = Number(dump.split(':')[1])
        if (Number.isFinite(d) && d < 5) {
          lesson += ` PEAK: слабый dump (${d.toFixed(1)}%) — паттерн ещё не как на скрине.`
          tags.push('PEAK_WEAK_DUMP')
        }
      }
      if (
        !entryBits.includes('ask_absorption') &&
        !entryBits.includes('cvd_bearish') &&
        !entryBits.includes('post_dump')
      ) {
        lesson += ' PEAK: без book/post_dump — ложный fade на продолжении пампa.'
        tags.push('PEAK_NO_BOOK')
      }
    } else if (input.status === 'WIN') {
      lesson += ` PEAK вход: ${entryBits.slice(0, 5).join(', ')}.`
    }
  }

  return {
    closeReason: reason,
    primaryTag,
    tags: [...new Set(tags)],
    headline,
    detail,
    lesson: lesson.trim(),
    tone,
  }
}

/** Format for Telegram / digest lines */
export function formatOutcomeAnalysisLines(
  analysis: TradeOutcomeAnalysis
): string[] {
  return [
    `Разбор: ${analysis.headline}`,
    analysis.detail,
    `Вывод: ${analysis.lesson}`,
    analysis.tags.length
      ? `Теги: ${analysis.tags.slice(0, 6).join(' · ')}`
      : '',
  ].filter(Boolean)
}
