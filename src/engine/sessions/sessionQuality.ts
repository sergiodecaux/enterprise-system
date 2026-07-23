export type SessionName = 'OVERLAP' | 'LONDON' | 'NY' | 'ASIA' | 'DEAD'

export interface SessionQuality {
  score: number
  session: SessionName
  avoid: boolean
}

/** UTC session quality for ScoreCard (London / NY / Overlap preferred). */
export function evaluateSessionQuality(nowMs = Date.now()): SessionQuality {
  const hour = new Date(nowMs).getUTCHours()

  if (hour >= 12 && hour < 16) {
    return { score: 100, session: 'OVERLAP', avoid: false }
  }
  if (hour >= 7 && hour < 12) {
    return { score: 85, session: 'LONDON', avoid: false }
  }
  if (hour >= 16 && hour < 21) {
    return { score: 80, session: 'NY', avoid: false }
  }
  if (hour >= 0 && hour < 7) {
    return { score: 35, session: 'ASIA', avoid: true }
  }
  return { score: 20, session: 'DEAD', avoid: true }
}
