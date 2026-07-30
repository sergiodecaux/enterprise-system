/**
 * Hard gate checklist before calling a setup READY to trade / watch.
 */

import type { CoinSignal } from '../types'
import type { AssetType } from '../composite/assetClassifier'
import { classifyAsset } from '../composite/assetClassifier'

export type GateStatus = 'PASS' | 'PENDING' | 'FAIL'

export interface GateItem {
  id: string
  label: string
  status: GateStatus
  detail: string
}

export interface ReadyGateResult {
  ready: boolean
  passCount: number
  needCount: number
  items: GateItem[]
  summary: string
  assetType: AssetType
}

function assetOf(signal: CoinSignal): AssetType {
  return classifyAsset(signal.internalSymbol, signal.priceChange24h, signal.memePulse?.spreadPressure, {
    hasMemePulse: !!signal.memePulse,
  })
}

/**
 * Require ≥ needCount PASS (and zero FAIL on hard items) before READY.
 */
export function evaluateReadyGate(signal: CoinSignal): ReadyGateResult {
  const assetType = assetOf(signal)
  const items: GateItem[] = []
  const side = signal.direction

  // 1. ScoreCard
  const sc = signal.scoreCard
  if (!sc || sc.grade === 'SKIP') {
    items.push({
      id: 'score',
      label: 'ScoreCard',
      status: 'FAIL',
      detail: sc?.missingFactors?.[0] ?? 'SKIP / нет карты',
    })
  } else if (sc.ready) {
    items.push({
      id: 'score',
      label: 'ScoreCard',
      status: 'PASS',
      detail: `${sc.grade} · ${sc.totalScore}/${sc.maxScore}`,
    })
  } else {
    items.push({
      id: 'score',
      label: 'ScoreCard',
      status: 'PENDING',
      detail: (sc.missingFactors ?? []).slice(0, 2).join(' · ') || sc.grade,
    })
  }

  // 2. HTF not against
  const htf = signal.htfTrend?.bias
  if (!side) {
    items.push({
      id: 'htf',
      label: 'HTF тренд',
      status: 'PENDING',
      detail: 'Нет направления сигнала',
    })
  } else if (!htf || htf === 'RANGING') {
    items.push({
      id: 'htf',
      label: 'HTF тренд',
      status: 'PENDING',
      detail: htf ?? 'нет данных',
    })
  } else if (
    (side === 'LONG' && htf === 'BULLISH') ||
    (side === 'SHORT' && htf === 'BEARISH')
  ) {
    items.push({
      id: 'htf',
      label: 'HTF тренд',
      status: 'PASS',
      detail: String(htf),
    })
  } else {
    items.push({
      id: 'htf',
      label: 'HTF тренд',
      status: 'FAIL',
      detail: `${htf} против ${side}`,
    })
  }

  // 3. Zone / surgical / raid (structure touch)
  const surg = signal.surgicalEntry?.status
  const inOte = !!signal.ote?.priceInZone
  const raidFresh = !!signal.raid?.isFresh
  if (surg === 'READY' || inOte || raidFresh || signal.hasActiveSetup) {
    items.push({
      id: 'zone',
      label: 'Зона / вход',
      status: 'PASS',
      detail:
        surg === 'READY'
          ? 'Surgical READY'
          : inOte
            ? 'Цена в OTE'
            : raidFresh
              ? 'Свежий raid'
              : 'Активный сетап',
    })
  } else if (
    surg === 'WAITING_SWEEP' ||
    surg === 'WAITING_CONFIRM' ||
    surg === 'IDLE'
  ) {
    items.push({
      id: 'zone',
      label: 'Зона / вход',
      status: 'PENDING',
      detail: surg ?? 'ждём зону',
    })
  } else if (surg === 'INVALIDATED' || surg === 'MISSED') {
    items.push({
      id: 'zone',
      label: 'Зона / вход',
      status: 'FAIL',
      detail: surg,
    })
  } else {
    items.push({
      id: 'zone',
      label: 'Зона / вход',
      status: 'PENDING',
      detail: 'Нет подтверждённого касания зоны',
    })
  }

  // 4. Micro confirmation (absorption / aggression / MM with side)
  const absorb = signal.absorption?.detected
  const aggr = signal.buyerAggression
  const mmOk =
    !!signal.mmIntent?.preferredSide &&
    signal.mmIntent.preferredSide === side &&
    signal.mmIntent.confidence >= 45

  let microPass = false
  let microDetail = 'нет ленты / поглощения'
  if (absorb) {
    microPass = true
    microDetail = signal.absorption?.label || 'Absorption'
  } else if (
    aggr?.detected &&
    ((side === 'LONG' &&
      (aggr.color === 'GREEN' || aggr.buyToSellRatio >= aggr.threshold)) ||
      (side === 'SHORT' && aggr.buyToSellRatio <= 1 / Math.max(aggr.threshold, 1.1)))
  ) {
    microPass = true
    microDetail = aggr.label || `Aggression ${aggr.buyToSellRatio.toFixed(2)}`
  } else if (mmOk) {
    microPass = true
    microDetail = `MM ${signal.mmIntent!.preferredSide} ${Math.round(signal.mmIntent!.confidence)}%`
  } else if (assetType === 'MEME' && signal.memePulse) {
    const heat = signal.memePulse.heatScore
    if (heat >= 60) {
      microPass = true
      microDetail = `Meme heat ${heat}`
    } else {
      microDetail = `Meme heat ${heat} < 60`
    }
  }

  items.push({
    id: 'micro',
    label: 'Микро-подтверждение',
    status: microPass ? 'PASS' : 'PENDING',
    detail: microDetail,
  })

  // Hard FAIL blocks ready
  const hardFail = items.some(
    (i) => i.status === 'FAIL' && (i.id === 'score' || i.id === 'htf' || i.id === 'zone')
  )
  const passCount = items.filter((i) => i.status === 'PASS').length
  const needCount = assetType === 'MEME' ? 2 : 3
  const ready = !hardFail && passCount >= needCount

  const summary = ready
    ? `Готово · ${passCount}/${items.length} условий`
    : hardFail
      ? `Блок · ${items.find((i) => i.status === 'FAIL')?.detail ?? 'фильтр'}`
      : `Ждать · ${passCount}/${needCount} (нужно ≥${needCount})`

  return { ready, passCount, needCount, items, summary, assetType }
}
