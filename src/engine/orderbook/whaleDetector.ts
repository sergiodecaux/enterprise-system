import type {
  OrderBookSnapshot,
  WhaleAlert,
  WhaleOrder,
  WhaleWatcherState,
} from '../types'

/** Минимальный объём в USD для whale-ордера */
export const WHALE_THRESHOLD_USD = 1_000_000 // $1M

/** Зона поиска китов: min и max расстояние от цены в % */
export const WHALE_ZONE_MIN_PCT = 0.0 // 0% — включая текущую цену
export const WHALE_ZONE_MAX_PCT = 5.0 // до 5%

/** TTL алерта после исчезновения ордера из стакана (мс) */
export const WHALE_ALERT_TTL_MS = 5 * 60 * 1000 // 5 минут

/**
 * Форматирует объём USD в читаемый вид: 1.23M, 456K
 */
export function formatWhaleVolume(usd: number): string {
  if (usd >= 1_000_000) {
    return `$${(usd / 1_000_000).toFixed(2)}M`
  }
  if (usd >= 1_000) {
    return `$${(usd / 1_000).toFixed(0)}K`
  }
  return `$${usd.toFixed(0)}`
}

/**
 * formatWhalePrice — форматирует цену в зависимости от её диапазона
 */
function formatWhalePrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

/**
 * detectWhaleOrders — сканирует снапшот стакана и находит whale-ордера.
 *
 * Алгоритм:
 * 1. Определяем midPrice из лучшего bid/ask
 * 2. Для каждого уровня в стакане считаем volumeUsd = volume * price
 * 3. Если volumeUsd >= WHALE_THRESHOLD_USD и distancePct <= WHALE_ZONE_MAX_PCT
 *    — это whale-ордер
 * 4. Классифицируем: IMMEDIATE (0-1%), SUPPORT/RESISTANCE (1-5%)
 *
 * @param snapshot - снапшот стакана
 * @param currentPrice - текущая цена (mid или last trade)
 */
export function detectWhaleOrders(
  snapshot: OrderBookSnapshot,
  currentPrice: number
): WhaleOrder[] {
  if (!snapshot || currentPrice <= 0) return []

  const whales: WhaleOrder[] = []
  const now = Date.now()

  const processLevels = (
    levels: typeof snapshot.bids,
    side: 'BID' | 'ASK'
  ) => {
    for (const level of levels) {
      const { price, volume } = level
      if (price <= 0 || volume <= 0) continue

      const volumeUsd = volume * price
      if (volumeUsd < WHALE_THRESHOLD_USD) continue

      const distancePct = (Math.abs(currentPrice - price) / currentPrice) * 100
      if (distancePct > WHALE_ZONE_MAX_PCT) continue

      whales.push({
        side,
        price,
        volume,
        volumeUsd,
        distancePct,
        detectedAt: now,
      })
    }
  }

  processLevels(snapshot.bids, 'BID')
  processLevels(snapshot.asks, 'ASK')

  // Сортировка: сначала крупнейшие, затем ближайшие
  whales.sort((a, b) => {
    if (Math.abs(a.volumeUsd - b.volumeUsd) > 100_000) {
      return b.volumeUsd - a.volumeUsd
    }
    return a.distancePct - b.distancePct
  })

  return whales
}

/**
 * buildWhaleAlerts — преобразует whale-ордера в алерты с текстовыми сообщениями.
 */
export function buildWhaleAlerts(
  whaleOrders: WhaleOrder[],
  symbol: string,
  _currentPrice: number
): WhaleAlert[] {
  return whaleOrders.map((order) => {
    const id = `whale_${order.side}_${order.price.toFixed(6)}`
    const volStr = formatWhaleVolume(order.volumeUsd)
    const priceStr = formatWhalePrice(order.price)

    let type: WhaleAlert['type']
    let message: string

    if (order.distancePct <= 1.0) {
      type = 'IMMEDIATE'
      if (order.side === 'BID') {
        message = `🐋 Поддержка китов на ${priceStr} — ${volStr} (СРОЧНО)`
      } else {
        message = `🐋 Сопротивление китов на ${priceStr} — ${volStr} (СРОЧНО)`
      }
    } else if (order.side === 'BID') {
      type = 'SUPPORT'
      message = `🐋 Поддержка китов на ${priceStr} — ${volStr} (${order.distancePct.toFixed(1)}% ниже)`
    } else {
      type = 'RESISTANCE'
      message = `🐋 Сопротивление китов на ${priceStr} — ${volStr} (${order.distancePct.toFixed(1)}% выше)`
    }

    const now = Date.now()
    return {
      id,
      order,
      symbol,
      type,
      message,
      isActive: true,
      firstSeen: now,
      lastSeen: now,
      isExpired: false,
    }
  })
}

/**
 * updateWhaleWatcher — обновляет состояние Whale Watcher.
 *
 * Логика TTL:
 * - Ордер есть в стакане → обновляем lastSeen, isActive=true
 * - Ордер пропал        → если прошло > TTL, помечаем isExpired=true
 * - Новый ордер         → добавляем в alerts
 *
 * @param prev      - предыдущее состояние (null для первого вызова)
 * @param snapshot  - свежий снапшот стакана
 * @param symbol    - internalSymbol монеты
 * @param currentPrice - текущая цена
 */
export function updateWhaleWatcher(
  prev: WhaleWatcherState | null,
  snapshot: OrderBookSnapshot,
  symbol: string,
  currentPrice: number
): WhaleWatcherState {
  const now = Date.now()
  const freshOrders = detectWhaleOrders(snapshot, currentPrice)
  const freshIds = new Set(
    freshOrders.map((o) => `whale_${o.side}_${o.price.toFixed(6)}`)
  )
  const freshAlerts = buildWhaleAlerts(freshOrders, symbol, currentPrice)

  // Обновляем существующие алерты
  const prevAlerts = prev?.alerts ?? []
  const updatedPrev: WhaleAlert[] = prevAlerts.map((alert) => {
    if (freshIds.has(alert.id)) {
      // Ордер всё ещё в стакане
      const fresh = freshAlerts.find((a) => a.id === alert.id)
      return {
        ...alert,
        isActive: true,
        isExpired: false,
        lastSeen: now,
        order: fresh?.order ?? alert.order,
        message: fresh?.message ?? alert.message,
      }
    }
    // Ордер пропал — запускаем TTL
    const elapsed = now - alert.lastSeen
    return {
      ...alert,
      isActive: false,
      isExpired: elapsed > WHALE_ALERT_TTL_MS,
    }
  })

  // Добавляем новые алерты (которых не было в prev)
  const existingIds = new Set(prevAlerts.map((a) => a.id))
  const newAlerts = freshAlerts.filter((a) => !existingIds.has(a.id))

  // Фильтруем просроченные
  const allAlerts = [...updatedPrev, ...newAlerts].filter((a) => !a.isExpired)

  // Топ support/resistance
  const activeBids = freshOrders
    .filter((o) => o.side === 'BID')
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
  const activeAsks = freshOrders
    .filter((o) => o.side === 'ASK')
    .sort((a, b) => b.volumeUsd - a.volumeUsd)

  const strongestSupport = activeBids[0] ?? null
  const strongestResistance = activeAsks[0] ?? null

  // Score boost: 0..1.5
  // Логика: крупный BID ниже цены = поддержка для LONG
  //         крупный ASK выше цены = сопротивление для SHORT
  let scoreBoost = 0
  if (strongestSupport) {
    const intensity = Math.min(strongestSupport.volumeUsd / 5_000_000, 1)
    const proximity =
      strongestSupport.distancePct <= 1.0
        ? 1.5
        : strongestSupport.distancePct <= 2.5
          ? 1.0
          : 0.5
    scoreBoost = Math.max(scoreBoost, intensity * proximity)
  }
  if (strongestResistance) {
    const intensity = Math.min(strongestResistance.volumeUsd / 5_000_000, 1)
    const proximity =
      strongestResistance.distancePct <= 1.0
        ? 1.5
        : strongestResistance.distancePct <= 2.5
          ? 1.0
          : 0.5
    scoreBoost = Math.max(scoreBoost, intensity * proximity)
  }

  return {
    symbol,
    alerts: allAlerts,
    strongestSupport,
    strongestResistance,
    scoreBoost: parseFloat(Math.min(scoreBoost, 1.5).toFixed(2)),
    lastUpdated: now,
  }
}
