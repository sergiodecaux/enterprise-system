import type { CoinSignal, LiquidityMap, MmIntentSnapshot } from '../types'
import type { PriceForecast, PriceScenario } from '../prediction/types'
import type { HtfTrendSnapshot } from '../trend/htfTrendStrength'
import { htfOpposesSide } from '../trend/htfTrendStrength'
import type {
  ConditionalSetup,
  ConditionalSetupStatus,
  SetupPrecondition,
} from './types'

export interface BuildConditionalSetupsInput {
  signal: CoinSignal
  forecast: PriceForecast | null
  liquidityMap?: LiquidityMap | null
  mmIntent?: MmIntentSnapshot | null
  htfTrend?: HtfTrendSnapshot | null
  price: number
}

function uid(kind: string, side: string): string {
  return `${kind}_${side}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function statusFromPreconditions(
  pre: SetupPrecondition[]
): ConditionalSetupStatus {
  if (pre.some((p) => p.status === 'FAILED')) return 'INVALIDATED'
  if (pre.length > 0 && pre.every((p) => p.status === 'MET')) return 'READY'
  if (pre.some((p) => p.status === 'MET')) return 'ARMED'
  return 'HYPOTHESIS'
}

function fromForecastScenario(
  sc: PriceScenario,
  signal: CoinSignal,
  price: number,
  htf: HtfTrendSnapshot | null | undefined
): ConditionalSetup | null {
  if (sc.type === 'RANGE') return null
  const side = sc.type
  const pad = Math.abs(sc.entry - sc.invalidation) * 0.15 || price * 0.001
  const zone =
    side === 'LONG'
      ? {
          top: Math.max(sc.entry, sc.entry + pad),
          bottom: Math.min(sc.entry, sc.invalidation + pad),
        }
      : {
          top: Math.max(sc.entry, sc.invalidation - pad),
          bottom: Math.min(sc.entry, sc.entry - pad),
        }

  const preconditions: SetupPrecondition[] = [
    {
      id: 'trigger',
      label: sc.triggerCondition || 'Условие сценария',
      status: 'PENDING',
    },
    {
      id: 'zone',
      label: `Цена в зоне входа ${zone.bottom.toPrecision(5)}–${zone.top.toPrecision(5)}`,
      status:
        price >= zone.bottom * 0.998 && price <= zone.top * 1.002
          ? 'MET'
          : 'PENDING',
    },
  ]

  if (htfOpposesSide(htf, side)) {
    preconditions.push({
      id: 'htf',
      label: 'HTF не против стороны',
      status: 'FAILED',
    })
  } else if (htf && htf.label !== 'WEAK') {
    preconditions.push({
      id: 'htf',
      label: `HTF ${htf.bias} ${htf.label}`,
      status: htf.bias === 'RANGING' ||
        (side === 'LONG' && htf.bias === 'BULLISH') ||
        (side === 'SHORT' && htf.bias === 'BEARISH')
        ? 'MET'
        : 'PENDING',
    })
  }

  const kind =
    sc.id === 'A' ? 'FORECAST_A' : sc.id === 'B' ? 'FORECAST_B' : 'FORECAST_C'

  return {
    id: uid(kind, side),
    kind,
    side,
    title: sc.label,
    probability: sc.probability,
    preconditions,
    entryZone: zone,
    limitEntry: sc.entry,
    target: sc.target,
    invalidation: sc.invalidation,
    triggerSummary: sc.triggerCondition,
    reasoning: sc.reasoning,
    chartPath: sc.path,
    status: statusFromPreconditions(preconditions),
    symbol: signal.symbol,
    internalSymbol: signal.internalSymbol,
    createdAt: Date.now(),
  }
}

function fromMmHunt(
  signal: CoinSignal,
  mm: MmIntentSnapshot,
  price: number,
  htf: HtfTrendSnapshot | null | undefined
): ConditionalSetup | null {
  const side = mm.preferredSide
  if (!side || !mm.hunt.microTarget || !mm.hunt.macroTarget) return null

  const micro = mm.hunt.microTarget
  const macro = mm.hunt.macroTarget
  const sweptApprox =
    side === 'LONG'
      ? price <= micro * 1.002 || (mm.hunt.microIsStopHunt && price > micro)
      : price >= micro * 0.998 || (mm.hunt.microIsStopHunt && price < micro)

  // Better: pending until wick through micro
  const preconditions: SetupPrecondition[] = [
    {
      id: 'sweep',
      label: `Sweep micro ${mm.hunt.microLabel || micro}`,
      status: signal.surgicalEntry?.sweepPrice != null ? 'MET' : 'PENDING',
    },
    {
      id: 'confirm',
      label: 'Confirm (CHoCH / MSS / absorption / reclaim)',
      status:
        (signal.surgicalEntry?.confirmations?.length ?? 0) > 0
          ? 'MET'
          : 'PENDING',
    },
    {
      id: 'limit',
      label: 'Лимит в зоне после reclaim',
      status: signal.surgicalEntry?.status === 'READY' ? 'MET' : 'PENDING',
    },
  ]

  if (htfOpposesSide(htf, side)) {
    preconditions.push({
      id: 'htf',
      label: 'Сильный встречный HTF',
      status: 'FAILED',
    })
  }

  const limit =
    signal.surgicalEntry?.limitEntry ??
    (side === 'LONG'
      ? Math.min(price, micro) * 1.001
      : Math.max(price, micro) * 0.999)
  const inv =
    signal.surgicalEntry?.invalidation ??
    (side === 'LONG' ? micro * 0.992 : micro * 1.008)

  void sweptApprox

  return {
    id: uid('MM_HUNT', side),
    kind: 'MM_HUNT',
    side,
    title: `MM Hunt: ${mm.label}`,
    probability: Math.min(85, 40 + mm.confidence * 0.4),
    preconditions,
    entryZone: {
      top: signal.surgicalEntry?.zoneTop ?? limit * 1.002,
      bottom: signal.surgicalEntry?.zoneBottom ?? limit * 0.998,
    },
    limitEntry: limit,
    target: macro,
    invalidation: inv,
    triggerSummary: 'Микро-sweep → confirm → лимит → магнит',
    reasoning: mm.reasons.slice(0, 4),
    chartPath:
      mm.hunt.microTarget && mm.hunt.macroTarget
        ? [
            { timeOffsetSeconds: 0, price, label: 'Now', isKeyLevel: true },
            {
              timeOffsetSeconds: 1800,
              price: mm.hunt.microTarget,
              label: 'Sweep',
              isKeyLevel: true,
            },
            {
              timeOffsetSeconds: 7200,
              price: mm.hunt.macroTarget,
              label: 'Macro',
              isKeyLevel: true,
            },
          ]
        : undefined,
    status:
      signal.surgicalEntry?.status === 'READY'
        ? 'READY'
        : signal.surgicalEntry?.status === 'INVALIDATED'
          ? 'INVALIDATED'
          : statusFromPreconditions(preconditions),
    symbol: signal.symbol,
    internalSymbol: signal.internalSymbol,
    createdAt: Date.now(),
  }
}

function fromSurgical(signal: CoinSignal): ConditionalSetup | null {
  const s = signal.surgicalEntry
  if (!s || s.status === 'IDLE' || !signal.direction) return null
  if (s.limitEntry == null) return null

  const statusMap: Record<string, ConditionalSetupStatus> = {
    WAITING_SWEEP: 'HYPOTHESIS',
    WAITING_CONFIRM: 'ARMED',
    READY: 'READY',
    INVALIDATED: 'INVALIDATED',
    MISSED: 'EXPIRED',
  }

  return {
    id: uid('SURGICAL', s.side),
    kind: 'SURGICAL',
    side: s.side,
    title: `Surgical ${s.status}`,
    probability: s.status === 'READY' ? 78 : s.status.startsWith('WAITING') ? 55 : 20,
    preconditions: [
      {
        id: 'sweep',
        label: 'Sweep micro',
        status:
          s.sweepPrice != null
            ? 'MET'
            : s.status === 'WAITING_SWEEP'
              ? 'PENDING'
              : 'MET',
      },
      {
        id: 'confirm',
        label: s.confirmations.join(', ') || 'LTF confirm',
        status:
          s.confirmations.length > 0
            ? 'MET'
            : s.status === 'READY'
              ? 'MET'
              : 'PENDING',
      },
    ],
    entryZone: {
      top: s.zoneTop ?? s.limitEntry * 1.002,
      bottom: s.zoneBottom ?? s.limitEntry * 0.998,
    },
    limitEntry: s.limitEntry,
    target: s.macroTarget ?? signal.tp1 ?? s.limitEntry,
    invalidation: s.invalidation ?? signal.sl ?? s.limitEntry,
    triggerSummary: s.reason,
    reasoning: s.confirmations.length
      ? s.confirmations
      : [s.reason],
    status: statusMap[s.status] ?? 'HYPOTHESIS',
    symbol: signal.symbol,
    internalSymbol: signal.internalSymbol,
    createdAt: Date.now(),
  }
}

function bounceSetups(
  signal: CoinSignal,
  map: LiquidityMap | null | undefined,
  price: number,
  htf: HtfTrendSnapshot | null | undefined
): ConditionalSetup[] {
  if (!map) return []
  const out: ConditionalSetup[] = []

  const ssl = map.nearestSSL
  if (ssl?.isActive && ssl.price > 0) {
    const side = 'LONG' as const
    const pre: SetupPrecondition[] = [
      {
        id: 'touch',
        label: `Касание SSL @ ${ssl.price.toPrecision(6)}`,
        status: price <= ssl.price * 1.003 ? 'MET' : 'PENDING',
      },
      {
        id: 'reject',
        label: 'Отскок / absorption / reclaim выше SSL',
        status:
          signal.absorption?.detected || signal.ltfChoCH?.detected
            ? 'MET'
            : 'PENDING',
      },
    ]
    if (htfOpposesSide(htf, side)) {
      pre.push({ id: 'htf', label: 'HTF против', status: 'FAILED' })
    }
    const limit = ssl.price * 1.0015
    out.push({
      id: uid('BOUNCE_SSL', side),
      kind: 'BOUNCE_SSL',
      side,
      title: `Отскок от SSL (${ssl.strength})`,
      probability: Math.min(
        72,
        35 + (ssl.strength === 'STRONG' ? 20 : ssl.strength === 'MEDIUM' ? 12 : 6)
      ),
      preconditions: pre,
      entryZone: { top: ssl.price * 1.004, bottom: ssl.price * 0.997 },
      limitEntry: limit,
      target: map.nearestBSL?.price ?? price * 1.015,
      invalidation: ssl.price * 0.992,
      triggerSummary:
        'Если цена дойдёт до SSL, остановится и покажет силу вверх → LONG',
      reasoning: [
        'Условный сетап: не вход сейчас',
        'Ждём касание + отскок с подтверждением',
      ],
      status: statusFromPreconditions(pre),
      symbol: signal.symbol,
      internalSymbol: signal.internalSymbol,
      createdAt: Date.now(),
    })
  }

  const bsl = map.nearestBSL
  if (bsl?.isActive && bsl.price > 0) {
    const side = 'SHORT' as const
    const pre: SetupPrecondition[] = [
      {
        id: 'touch',
        label: `Касание BSL @ ${bsl.price.toPrecision(6)}`,
        status: price >= bsl.price * 0.997 ? 'MET' : 'PENDING',
      },
      {
        id: 'reject',
        label: 'Отскок вниз / MSS short / upper absorption',
        status:
          signal.mss?.direction === 'BEARISH' ||
          (signal.raid?.type === 'BEAR_SWEEP' && signal.raid.isFresh)
            ? 'MET'
            : 'PENDING',
      },
    ]
    if (htfOpposesSide(htf, side)) {
      pre.push({ id: 'htf', label: 'HTF против', status: 'FAILED' })
    }
    const limit = bsl.price * 0.9985
    out.push({
      id: uid('BOUNCE_BSL', side),
      kind: 'BOUNCE_BSL',
      side,
      title: `Отскок от BSL (${bsl.strength})`,
      probability: Math.min(
        72,
        35 + (bsl.strength === 'STRONG' ? 20 : bsl.strength === 'MEDIUM' ? 12 : 6)
      ),
      preconditions: pre,
      entryZone: { top: bsl.price * 1.003, bottom: bsl.price * 0.996 },
      limitEntry: limit,
      target: map.nearestSSL?.price ?? price * 0.985,
      invalidation: bsl.price * 1.008,
      triggerSummary:
        'Если цена дойдёт до BSL, остановится и покажет слабость → SHORT',
      reasoning: [
        'Условный сетап: не вход сейчас',
        'Ждём касание + rejection',
      ],
      status: statusFromPreconditions(pre),
      symbol: signal.symbol,
      internalSymbol: signal.internalSymbol,
      createdAt: Date.now(),
    })
  }

  return out
}

function stopThenReverse(
  signal: CoinSignal,
  mm: MmIntentSnapshot | null | undefined,
  price: number
): ConditionalSetup | null {
  if (!mm?.hunt.microTarget || !mm.hunt.microIsStopHunt || !mm.preferredSide) {
    return null
  }
  const side = mm.preferredSide
  const micro = mm.hunt.microTarget
  const macro = mm.hunt.macroTarget ?? (side === 'LONG' ? price * 1.02 : price * 0.98)

  const pre: SetupPrecondition[] = [
    {
      id: 'stop_hunt',
      label: `Стоп-хант через ${mm.hunt.microLabel}`,
      status: signal.surgicalEntry?.sweepPrice != null ? 'MET' : 'PENDING',
    },
    {
      id: 'flip',
      label: 'Разворот / reclaim структуры',
      status:
        (signal.surgicalEntry?.confirmations.length ?? 0) > 0
          ? 'MET'
          : 'PENDING',
    },
    {
      id: 'entry',
      label: 'Лимит после reclaim',
      status: signal.surgicalEntry?.status === 'READY' ? 'MET' : 'PENDING',
    },
  ]

  return {
    id: uid('STOP_THEN_REVERSE', side),
    kind: 'STOP_THEN_REVERSE',
    side,
    title: `Stop-hunt → ${side}`,
    probability: Math.min(80, 42 + mm.confidence * 0.35),
    preconditions: pre,
    entryZone: {
      top: (signal.surgicalEntry?.zoneTop ?? micro) * (side === 'LONG' ? 1.003 : 1.001),
      bottom:
        (signal.surgicalEntry?.zoneBottom ?? micro) *
        (side === 'LONG' ? 0.997 : 0.999),
    },
    limitEntry: signal.surgicalEntry?.limitEntry ?? micro,
    target: macro,
    invalidation:
      signal.surgicalEntry?.invalidation ??
      (side === 'LONG' ? micro * 0.99 : micro * 1.01),
    triggerSummary: 'Свип стопов → confirm → вход против первой ноги',
    reasoning: [
      'Классика ММ: сначала забирает ближние стопы',
      'Потом гонит к противоположной ликвидности',
    ],
    status: statusFromPreconditions(pre),
    symbol: signal.symbol,
    internalSymbol: signal.internalSymbol,
    createdAt: Date.now(),
  }
}

/**
 * Полный каталог условных сетапов для «Подобрать сетап».
 */
export function buildConditionalSetups(
  input: BuildConditionalSetupsInput
): ConditionalSetup[] {
  const {
    signal,
    forecast,
    liquidityMap,
    mmIntent,
    htfTrend,
    price,
  } = input
  const mm = mmIntent ?? signal.mmIntent ?? null
  const htf = htfTrend ?? signal.htfTrend ?? null
  const setups: ConditionalSetup[] = []

  if (forecast?.scenarios?.length) {
    for (const sc of forecast.scenarios) {
      const s = fromForecastScenario(sc, signal, price, htf)
      if (s) setups.push(s)
    }
  }

  const mmSetup = mm ? fromMmHunt(signal, mm, price, htf) : null
  if (mmSetup) setups.push(mmSetup)

  const surgical = fromSurgical(signal)
  if (surgical) setups.push(surgical)

  setups.push(...bounceSetups(signal, liquidityMap, price, htf))

  const str = stopThenReverse(signal, mm, price)
  if (str) setups.push(str)

  // Dedupe similar kinds keeping higher probability
  const byKind = new Map<string, ConditionalSetup>()
  for (const s of setups) {
    const key = `${s.kind}_${s.side}`
    const prev = byKind.get(key)
    if (!prev || s.probability > prev.probability) byKind.set(key, s)
  }

  return [...byKind.values()].sort((a, b) => b.probability - a.probability)
}
