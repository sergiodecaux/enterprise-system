import type { FeatureVector, GroupAxis, HeldSnap } from './types'

export type { FeatureVector }

/** Fields written with every labeled event. Grouping uses a prefix of AXIS_ORDER. */
export const SAVED_FEATURES = [
  'event',
  'tf',
  'oi',
  'priorSweep',
  'trend',
  'location',
  'volumeRatio',
  'body',
  'htfZone',
] as const

/** Search order. Each step adds the next axis on top of the previous split. */
export const AXIS_ORDER: readonly GroupAxis[] = ['body', 'htfZone', 'location']

export function featureVectorOf(snap: HeldSnap): FeatureVector {
  return {
    event: snap.kind,
    tf: snap.tf,
    oi: 'unknown',
    priorSweep: snap.priorSweep,
    trend: snap.trend,
    location: snap.location,
    volumeRatio: snap.volumeRatio,
    body: snap.body,
    htfZone: snap.htfZone,
  }
}

/** event × tf × oi × prior sweep, plus any axes requested for this split. */
export function groupKey(feat: FeatureVector, axes: readonly GroupAxis[] = []): string {
  const parts = [feat.event, feat.tf, 'oi:unknown', `sweep:${feat.priorSweep ? 1 : 0}`]
  if (axes.includes('body')) parts.push(`body:${feat.body}`)
  if (axes.includes('htfZone')) parts.push(`htf:${feat.htfZone ? 1 : 0}`)
  if (axes.includes('location')) parts.push(`loc:${feat.location}`)
  return parts.join('|')
}
