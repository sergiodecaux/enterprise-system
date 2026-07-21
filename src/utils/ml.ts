/** Helpers for ML feature display / formatting */

export function formatMlConfidence(confidence: number): string {
  return `${confidence.toFixed(1)}%`
}

export function formatMlAccuracy(accuracy: number): string {
  return `${accuracy.toFixed(1)}%`
}

export function directionTone(
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
): 'long' | 'short' | 'neutral' {
  if (direction === 'LONG') return 'long'
  if (direction === 'SHORT') return 'short'
  return 'neutral'
}
