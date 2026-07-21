import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { fetchOhlcv, fetchDepth } from '../api/mexc'
import { isTradeInvalidated } from '../engine/confidence'
import type { ActiveTrade } from '../engine/types'
import { logger } from '../utils/logger'
import { useTelegramWebApp } from './useTelegramWebApp'

const MONITOR_INTERVAL_MS = 5_000

export const useTradeCopilot = () => {
  const activeTrades = useAppStore((s) => s.activeTrades)
  const updateTrade = useAppStore((s) => s.updateTrade)
  const addTradeEvent = useAppStore((s) => s.addTradeEvent)
  const closeTrade = useAppStore((s) => s.closeTrade)
  const { haptic, showAlert } = useTelegramWebApp()

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMounted = useRef(true)

  const monitorTrade = useCallback(
    async (trade: ActiveTrade) => {
      if (trade.status !== 'ACTIVE' && trade.status !== 'BREAKEVEN') return

      try {
        const ohlcv1m = await fetchOhlcv(trade.internalSymbol, '1m', 30)
        if (!ohlcv1m.length || !isMounted.current) return

        const currentPrice = ohlcv1m[ohlcv1m.length - 1][4]

        const pnlPercent =
          trade.direction === 'LONG'
            ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
            : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100

        const pnlUsd = trade.positionSizeUsd
          ? (pnlPercent / 100) * trade.positionSizeUsd
          : null

        updateTrade(trade.id, { currentPrice, pnlPercent, pnlUsd })

        // ── Meme Shadow Trailing ──────────────────────────────────────────
        if (trade.isMemeTrade) {
          const trailPct = 0.02 // 2% от пика
          let peak = trade.peakPrice ?? trade.entryPrice
          if (trade.direction === 'LONG' && currentPrice > peak) peak = currentPrice
          if (trade.direction === 'SHORT' && currentPrice < peak) peak = currentPrice

          const trailingStop =
            trade.direction === 'LONG'
              ? peak * (1 - trailPct)
              : peak * (1 + trailPct)

          const prevTrail = trade.trailingStop
          if (
            prevTrail == null ||
            (trade.direction === 'LONG' && trailingStop > prevTrail) ||
            (trade.direction === 'SHORT' && trailingStop < prevTrail)
          ) {
            if (prevTrail != null && Math.abs(trailingStop - prevTrail) / trade.entryPrice > 0.005) {
              addTradeEvent(trade.id, {
                type: 'TRAILING_MOVED',
                price: currentPrice,
                message: `Shadow trail → ${trailingStop.toFixed(6)} (peak ${peak.toFixed(6)})`,
              })
            }
            updateTrade(trade.id, {
              peakPrice: peak,
              trailingStop,
              currentPrice,
              pnlPercent,
              pnlUsd,
            })
          } else {
            updateTrade(trade.id, { peakPrice: peak, currentPrice, pnlPercent, pnlUsd })
          }

          const trailHit =
            trade.direction === 'LONG'
              ? currentPrice <= trailingStop && peak > trade.entryPrice * 1.03
              : currentPrice >= trailingStop && peak < trade.entryPrice * 0.97

          if (trailHit && !trade.trailingAlertShown) {
            haptic.error()
            showAlert(
              `🚨 ${trade.symbol}: ТРЕЙЛИНГ ПРОБИТ!\nСРОЧНО ИДИ В MEXC И ЖМИ SELL MARKET!`
            )
            addTradeEvent(trade.id, {
              type: 'TRAILING_HIT',
              price: currentPrice,
              message: 'Shadow trailing пробит — закрывай по рынку!',
            })
            updateTrade(trade.id, { trailingAlertShown: true })
            return
          }

          // Hard SL still applies
          if (trade.direction === 'LONG' && currentPrice <= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
          if (trade.direction === 'SHORT' && currentPrice >= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
          // Skip hard TP1 for memes — trailing owns the exit
        } else if (trade.direction === 'LONG') {
          if (currentPrice >= trade.tp1) {
            haptic.success()
            showAlert(`🎯 ${trade.symbol}: TP1 достигнут!`)
            closeTrade(trade.id, 'WIN', currentPrice)
            return
          }
          if (currentPrice <= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
        } else {
          if (currentPrice <= trade.tp1) {
            haptic.success()
            showAlert(`🎯 ${trade.symbol}: TP1 достигнут!`)
            closeTrade(trade.id, 'WIN', currentPrice)
            return
          }
          if (currentPrice >= trade.sl) {
            haptic.error()
            showAlert(`🛑 ${trade.symbol}: SL активирован`)
            closeTrade(trade.id, 'LOSS', currentPrice)
            return
          }
        }

        if (!trade.breakevenAlertShown && trade.status === 'ACTIVE') {
          const distanceToTP1 = Math.abs(trade.tp1 - trade.entryPrice)
          const currentDistance = Math.abs(currentPrice - trade.entryPrice)
          const progressPercent = (currentDistance / distanceToTP1) * 100

          if (progressPercent >= 50) {
            haptic.impact()
            showAlert(
              `💎 ${trade.symbol}: Сила подтверждена! Переноси SL в безубыток.`
            )
            addTradeEvent(trade.id, {
              type: 'BREAKEVEN_REACHED',
              price: currentPrice,
              message: '50% пути до TP1 пройдено — рекомендация: SL → BE',
            })
            updateTrade(trade.id, { breakevenAlertShown: true })
          }
        }

        if (!trade.invalidationAlertShown) {
          const invalidation = isTradeInvalidated(
            ohlcv1m,
            trade.direction,
            trade.entryPrice
          )

          if (invalidation.invalidated) {
            haptic.error()
            showAlert(
              `⚠️ ${trade.symbol}: ПАТТЕРН СЛОМАН!\n${invalidation.reason}`
            )
            addTradeEvent(trade.id, {
              type: 'INVALIDATION',
              price: currentPrice,
              message: invalidation.reason,
            })
            updateTrade(trade.id, {
              invalidationAlertShown: true,
              status: 'INVALIDATED',
              invalidationPrice:
                invalidation.invalidationPrice ?? trade.invalidationPrice,
            })
          } else if (
            trade.invalidationPrice != null &&
            ((trade.direction === 'LONG' &&
              currentPrice < trade.invalidationPrice) ||
              (trade.direction === 'SHORT' &&
                currentPrice > trade.invalidationPrice))
          ) {
            // Цена пробила линию, но структура ещё не закрылась — soft warning раз в цикл через message
            logger.info(
              `[Copilot] ${trade.symbol} near invalidation ${trade.invalidationPrice}`
            )
          }
        }

        if (!trade.wallAlertShown) {
          const depth = await fetchDepth(trade.internalSymbol, 20)
          if (!isMounted.current) return

          if (trade.direction === 'LONG' && depth.asks.length > 0) {
            const bestAskVol = depth.asks[0]?.volume ?? 0
            const dangerousAsks = depth.asks.filter((ask) => {
              const inRange =
                ask.price > currentPrice && ask.price <= trade.tp1
              const isLarge = bestAskVol > 0 && ask.volume > bestAskVol * 5
              return inRange && isLarge
            })

            if (dangerousAsks.length > 0) {
              const wall = dangerousAsks[0]
              const volumeUsd = wall.price * wall.volume
              haptic.warning()
              showAlert(
                `🧱 ${trade.symbol}: Крупная стена Ask на пути!\nЦена: ${wall.price.toFixed(4)} | Объём: $${(volumeUsd / 1000).toFixed(0)}k\nВозможно торможение.`
              )
              addTradeEvent(trade.id, {
                type: 'WALL_DETECTED',
                price: wall.price,
                message: `Ask Wall: $${(volumeUsd / 1000).toFixed(0)}k`,
              })
              updateTrade(trade.id, { wallAlertShown: true })
            }
          }

          if (trade.direction === 'SHORT' && depth.bids.length > 0) {
            const bestBidVol = depth.bids[0]?.volume ?? 0
            const dangerousBids = depth.bids.filter((bid) => {
              const inRange =
                bid.price < currentPrice && bid.price >= trade.tp1
              const isLarge = bestBidVol > 0 && bid.volume > bestBidVol * 5
              return inRange && isLarge
            })

            if (dangerousBids.length > 0) {
              const wall = dangerousBids[0]
              const volumeUsd = wall.price * wall.volume
              haptic.warning()
              showAlert(
                `🧱 ${trade.symbol}: Крупная стена Bid на пути!\nЦена: ${wall.price.toFixed(4)} | Объём: $${(volumeUsd / 1000).toFixed(0)}k\nВозможно торможение.`
              )
              addTradeEvent(trade.id, {
                type: 'WALL_DETECTED',
                price: wall.price,
                message: `Bid Wall: $${(volumeUsd / 1000).toFixed(0)}k`,
              })
              updateTrade(trade.id, { wallAlertShown: true })
            }
          }
        }
      } catch (err) {
        logger.warn(`Trade monitor error ${trade.symbol}`, err)
      }
    },
    [updateTrade, addTradeEvent, closeTrade, haptic, showAlert]
  )

  const monitorAll = useCallback(async () => {
    const active = activeTrades.filter(
      (t) => t.status === 'ACTIVE' || t.status === 'BREAKEVEN'
    )

    for (const trade of active) {
      if (!isMounted.current) break
      await monitorTrade(trade)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }, [activeTrades, monitorTrade])

  useEffect(() => {
    isMounted.current = true
    monitorAll()
    intervalRef.current = setInterval(monitorAll, MONITOR_INTERVAL_MS)

    return () => {
      isMounted.current = false
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [monitorAll])
}
