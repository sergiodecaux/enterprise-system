import type {
  OrderBookWall,
  TrackedWall,
  WallEvent,
  WallTrackerState,
} from '../types'

const WALL_EATEN_THRESHOLD = 0.7
const WALL_TIMEOUT_MS = 10_000
/** Стена исчезла быстрее этого порога без съедения → spoof candidate */
const SPOOF_MAX_LIFETIME_MS = 2_000
const MAX_EVENTS = 50

export function createWallTracker(): WallTrackerState {
  return {
    walls: new Map(),
    events: [],
    maxEventsHistory: MAX_EVENTS,
  }
}

function cloneWall(wall: TrackedWall): TrackedWall {
  return { ...wall }
}

/**
 * Обновить состояние стенок и вернуть новые события
 */
export function updateWalls(
  tracker: WallTrackerState,
  currentWalls: OrderBookWall[]
): { tracker: WallTrackerState; newEvents: WallEvent[] } {
  const now = Date.now()
  const newEvents: WallEvent[] = []
  const walls = new Map(tracker.walls)
  const activeWallIds = new Set<string>()

  for (const wall of currentWalls) {
    const id = `${wall.side}_${wall.price.toFixed(4)}`
    activeWallIds.add(id)

    const existing = walls.get(id)

    if (!existing) {
      const tracked: TrackedWall = {
        id,
        side: wall.side,
        price: wall.price,
        initialVolume: wall.volume,
        currentVolume: wall.volume,
        firstSeen: now,
        lastSeen: now,
        isActive: true,
      }
      walls.set(id, tracked)
      newEvents.push({
        type: 'APPEARED',
        wall: cloneWall(tracked),
        timestamp: now,
      })
      continue
    }

    const updated = cloneWall(existing)
    const volumeChange = wall.volume - updated.currentVolume
    const reductionPercent =
      updated.initialVolume > 0
        ? ((updated.initialVolume - wall.volume) / updated.initialVolume) * 100
        : 0

    updated.currentVolume = wall.volume
    updated.lastSeen = now

    if (volumeChange < 0 && reductionPercent > WALL_EATEN_THRESHOLD * 100) {
      updated.isActive = false
      newEvents.push({
        type: 'EATEN',
        wall: cloneWall(updated),
        timestamp: now,
        reduction: reductionPercent,
      })
    } else if (volumeChange < -updated.initialVolume * 0.2) {
      newEvents.push({
        type: 'REDUCED',
        wall: cloneWall(updated),
        timestamp: now,
        reduction: reductionPercent,
      })
    } else if (volumeChange > updated.initialVolume * 0.5) {
      updated.initialVolume = wall.volume
      newEvents.push({
        type: 'INCREASED',
        wall: cloneWall(updated),
        timestamp: now,
      })
    }

    walls.set(id, updated)
  }

  walls.forEach((wall, id) => {
    if (!activeWallIds.has(id) && wall.isActive) {
      const goneMs = now - wall.lastSeen
      const lifetimeMs = now - wall.firstSeen
      const reductionPercent =
        wall.initialVolume > 0
          ? ((wall.initialVolume - wall.currentVolume) / wall.initialVolume) * 100
          : 0
      const barelyEaten = reductionPercent < 20

      // Spoof: крупная стена исчезла за ≤2с почти без проторговки
      if (
        lifetimeMs <= SPOOF_MAX_LIFETIME_MS &&
        barelyEaten &&
        wall.initialVolume > 0
      ) {
        const updated = cloneWall(wall)
        updated.isActive = false
        newEvents.push({
          type: 'SPOOFED',
          wall: cloneWall(updated),
          timestamp: now,
          reduction: reductionPercent,
        })
        walls.set(id, updated)
        return
      }

      if (goneMs > WALL_TIMEOUT_MS) {
        const updated = cloneWall(wall)

        if (reductionPercent > 50) {
          newEvents.push({
            type: 'EATEN',
            wall: cloneWall(updated),
            timestamp: now,
            reduction: reductionPercent,
          })
        }

        updated.isActive = false
        walls.set(id, updated)
      }
    }
  })

  const cleanupTime = now - 60_000
  walls.forEach((wall, id) => {
    if (!wall.isActive && wall.lastSeen < cleanupTime) {
      walls.delete(id)
    }
  })

  const allEvents = [...tracker.events, ...newEvents]
  if (allEvents.length > tracker.maxEventsHistory) {
    allEvents.splice(0, allEvents.length - tracker.maxEventsHistory)
  }

  return {
    tracker: {
      walls,
      events: allEvents,
      maxEventsHistory: tracker.maxEventsHistory,
    },
    newEvents,
  }
}

export function getRecentEvents(
  tracker: WallTrackerState,
  count = 5
): WallEvent[] {
  return tracker.events.slice(-count).reverse()
}
