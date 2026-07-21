import type { PathPoint } from './types'

/**
 * Project scenario path onto chart X axis when future timestamps
 * are outside LWC visible range (timeToCoordinate returns null).
 */
export function projectPathToPixels(
  path: PathPoint[],
  lastBarX: number,
  barSpacingPx: number,
  candleTimeframeSeconds: number,
  priceToY: (price: number) => number | null
): Array<{ x: number; y: number; label?: string; isKey?: boolean }> {
  const spacing =
    candleTimeframeSeconds > 0
      ? barSpacingPx / candleTimeframeSeconds
      : barSpacingPx / 3600

  const points: Array<{ x: number; y: number; label?: string; isKey?: boolean }> = []

  for (const pp of path) {
    const y = priceToY(pp.price)
    if (y == null) continue
    const x = lastBarX + pp.timeOffsetSeconds * spacing
    points.push({
      x,
      y,
      label: pp.label,
      isKey: pp.isKeyLevel,
    })
  }

  return points
}

export function estimateBarSpacing(
  containerWidth: number,
  visibleBars: number
): number {
  if (visibleBars <= 0) return 8
  return Math.max(2, containerWidth / visibleBars)
}
