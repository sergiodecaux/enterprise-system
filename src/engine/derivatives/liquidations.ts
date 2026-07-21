import type { OhlcvCandle } from '../../api/mexc'
import type { EqualLevel, LiquidityMap, LiquidityRaidResult } from '../types'

/**
 * Кластер потенциальных ликвидаций.
 * Без OI-фида используем прокси: equal highs/lows (BSL/SSL) + объёмные пики =
 * пулы стопов толпы, куда маркетмейкер тянет цену перед разворотом.
 */
export interface LiquidationCluster {
  price: number
  side: 'LONG_STOPS' | 'SHORT_STOPS'
  /** Относительная сила 0..100 */
  strength: number
  source: 'EQUAL_HIGHS' | 'EQUAL_LOWS' | 'VOLUME_POCKET' | 'SWING'
  touches: number
  distancePct: number
  swept: boolean
  label: string
}

export interface LiquidationContext {
  clusters: LiquidationCluster[]
  /** Ближайший пул против направления сделки (должен быть swept для элитного входа) */
  blockingCluster: LiquidationCluster | null
  /** Пул уже снят и цена вернулась */
  swept: boolean
  fresh: boolean
  /** Сигнал можно выпускать (для интрадея: ждём sweep) */
  gateOpen: boolean
  scoreBoost: number
  label: string
}

function levelToCluster(level: EqualLevel): LiquidationCluster {
  const side = level.type === 'HIGH' ? 'SHORT_STOPS' : 'LONG_STOPS'
  const strengthMap = { WEAK: 35, MEDIUM: 60, STRONG: 85 }
  return {
    price: level.price,
    side,
    strength: strengthMap[level.strength],
    source: level.type === 'HIGH' ? 'EQUAL_HIGHS' : 'EQUAL_LOWS',
    touches: level.touches,
    distancePct: level.distancePct,
    swept: !level.isActive,
    label:
      side === 'LONG_STOPS'
        ? `Long stops @ ${level.price.toFixed(4)}`
        : `Short stops @ ${level.price.toFixed(4)}`,
  }
}

/**
 * Строит карту ликвидационных кластеров из LiquidityMap + опционально swing extremes.
 */
export function buildLiquidationClusters(
  liquidityMap: LiquidityMap | null | undefined,
  currentPrice: number,
  ohlcv?: OhlcvCandle[]
): LiquidationCluster[] {
  const clusters: LiquidationCluster[] = []

  if (liquidityMap) {
    for (const h of liquidityMap.equalHighs) {
      if (h.distancePct <= 3.5) clusters.push(levelToCluster(h))
    }
    for (const l of liquidityMap.equalLows) {
      if (l.distancePct <= 3.5) clusters.push(levelToCluster(l))
    }
  }

  // Volume pockets: локальные swing high/low с аномальным объёмом
  if (ohlcv && ohlcv.length >= 30) {
    const recent = ohlcv.slice(-40)
    const avgVol =
      recent.reduce((s, c) => s + c[5], 0) / Math.max(recent.length, 1)

    for (let i = 2; i < recent.length - 2; i++) {
      const c = recent[i]
      if (c[5] < avgVol * 2.2) continue
      const isSwingHigh =
        c[2] >= recent[i - 1][2] &&
        c[2] >= recent[i - 2][2] &&
        c[2] >= recent[i + 1][2] &&
        c[2] >= recent[i + 2][2]
      const isSwingLow =
        c[3] <= recent[i - 1][3] &&
        c[3] <= recent[i - 2][3] &&
        c[3] <= recent[i + 1][3] &&
        c[3] <= recent[i + 2][3]

      if (isSwingHigh) {
        const price = c[2]
        const distancePct = Math.abs(price - currentPrice) / currentPrice * 100
        if (distancePct <= 3) {
          clusters.push({
            price,
            side: 'SHORT_STOPS',
            strength: Math.min(90, 50 + (c[5] / avgVol) * 10),
            source: 'VOLUME_POCKET',
            touches: 1,
            distancePct,
            swept: currentPrice > price,
            label: `Vol pocket shorts @ ${price.toFixed(4)}`,
          })
        }
      }
      if (isSwingLow) {
        const price = c[3]
        const distancePct = Math.abs(price - currentPrice) / currentPrice * 100
        if (distancePct <= 3) {
          clusters.push({
            price,
            side: 'LONG_STOPS',
            strength: Math.min(90, 50 + (c[5] / avgVol) * 10),
            source: 'VOLUME_POCKET',
            touches: 1,
            distancePct,
            swept: currentPrice < price,
            label: `Vol pocket longs @ ${price.toFixed(4)}`,
          })
        }
      }
    }
  }

  clusters.sort((a, b) => a.distancePct - b.distancePct)
  return clusters.slice(0, 8)
}

/**
 * Фильтр элитного входа: для LONG не выдаём сигнал, пока не сняли SSL (long stops) ниже;
 * для SHORT — пока не сняли BSL выше. После sweep + возврата — gate open + boost.
 */
export function evaluateLiquidationGate(
  clusters: LiquidationCluster[],
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  raid: LiquidityRaidResult | null | undefined
): LiquidationContext {
  const empty: LiquidationContext = {
    clusters,
    blockingCluster: null,
    swept: false,
    fresh: false,
    gateOpen: true,
    scoreBoost: 0,
    label: '',
  }

  if (clusters.length === 0) return empty

  // Блокирующий пул: стопы, которые MM должен выбить перед разворотом в нашу сторону
  const blocking =
    direction === 'LONG'
      ? clusters
          .filter((c) => c.side === 'LONG_STOPS' && c.price < currentPrice)
          .sort((a, b) => b.price - a.price)[0] ?? null
      : clusters
          .filter((c) => c.side === 'SHORT_STOPS' && c.price > currentPrice)
          .sort((a, b) => a.price - b.price)[0] ?? null

  if (!blocking) {
    return {
      ...empty,
      gateOpen: true,
      label: 'Нет блокирующего liq-пула',
    }
  }

  const raidMatches =
    raid != null &&
    raid.type !== 'NONE' &&
    raid.isFresh &&
    ((direction === 'LONG' && raid.type === 'BULL_SWEEP') ||
      (direction === 'SHORT' && raid.type === 'BEAR_SWEEP'))

  const priceSweptCluster =
    direction === 'LONG'
      ? currentPrice > blocking.price &&
        (blocking.swept ||
          (raid?.sweptLevel != null &&
            Math.abs(raid.sweptLevel - blocking.price) / blocking.price < 0.003))
      : currentPrice < blocking.price &&
        (blocking.swept ||
          (raid?.sweptLevel != null &&
            Math.abs(raid.sweptLevel - blocking.price) / blocking.price < 0.003))

  const swept = Boolean(raidMatches || priceSweptCluster || blocking.swept)
  const fresh = Boolean(raidMatches) || (swept && blocking.distancePct < 1.2)

  // Сильный пул без sweep — держим gate закрытым для элитных интрадей-сетапов
  const gateOpen = blocking.strength < 70 || swept

  let scoreBoost = 0
  let label = `Waiting sweep @ ${blocking.price.toFixed(4)}`

  if (swept && fresh) {
    scoreBoost = 2.0
    label = `Liq swept @ ${blocking.price.toFixed(4)} → Confidence boost`
  } else if (swept) {
    scoreBoost = 1.0
    label = `Liq cluster cleared @ ${blocking.price.toFixed(4)}`
  } else if (!gateOpen) {
    scoreBoost = 0
    label = `Gate closed: need sweep of ${blocking.label}`
  }

  return {
    clusters,
    blockingCluster: blocking,
    swept,
    fresh,
    gateOpen,
    scoreBoost,
    label,
  }
}
