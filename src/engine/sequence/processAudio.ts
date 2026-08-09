/**
 * Process audio landscape — Web Audio (no Howler dependency).
 * Click = hits, glass = wall release, hum = OI, chord = sequence moment.
 */

export type ProcessSound =
  | 'HIT_BUY'
  | 'HIT_SELL'
  | 'WALL_RELEASE'
  | 'OI_RISE'
  | 'LIQ'
  | 'MOMENT'
  | 'TRAP'

const STORAGE_KEY = 'enterprise_process_audio'

let ctx: AudioContext | null = null
let enabled = false
let lastHitAt = 0
let lastMomentId = ''

try {
  enabled = localStorage.getItem(STORAGE_KEY) === '1'
} catch {
  enabled = false
}

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export function isProcessAudioEnabled(): boolean {
  return enabled
}

export function setProcessAudioEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (on) void ac()?.resume()
}

function tone(
  freq: number,
  durMs: number,
  type: OscillatorType,
  gain = 0.08,
  when = 0
): void {
  const audio = ac()
  if (!audio || !enabled) return
  const t0 = audio.currentTime + when
  const osc = audio.createOscillator()
  const g = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000)
  osc.connect(g)
  g.connect(audio.destination)
  osc.start(t0)
  osc.stop(t0 + durMs / 1000 + 0.02)
}

export function playProcessSound(
  kind: ProcessSound,
  intensity = 0.5
): void {
  if (!enabled) return
  const i = Math.max(0.15, Math.min(1, intensity))

  switch (kind) {
    case 'HIT_BUY':
    case 'HIT_SELL': {
      const now = Date.now()
      if (now - lastHitAt < 90) return
      lastHitAt = now
      const base = kind === 'HIT_BUY' ? 180 : 140
      tone(base + i * 40, 35 + i * 40, 'triangle', 0.04 + i * 0.05)
      break
    }
    case 'WALL_RELEASE':
      // Louder "glass" when intensity high (big wall eaten)
      tone(880, 40 + i * 30, 'square', 0.05 + i * 0.06)
      tone(1320, 70 + i * 40, 'sawtooth', 0.03 + i * 0.05, 0.03)
      tone(440, 100 + i * 50, 'triangle', 0.04 + i * 0.05, 0.06)
      break
    case 'OI_RISE':
      tone(90 + i * 30, 280 + i * 80, 'sine', 0.03 + i * 0.05)
      tone(120 + i * 20, 320 + i * 60, 'sine', 0.02 + i * 0.03, 0.05)
      break
    case 'LIQ':
      tone(60, 45 + i * 40, 'square', 0.05 + i * 0.07)
      tone(90, 80 + i * 50, 'sawtooth', 0.04 + i * 0.05, 0.04)
      break
    case 'TRAP':
    case 'MOMENT':
      tone(523, 70 + i * 40, 'sine', 0.05 + i * 0.05) // C
      tone(659, 90 + i * 40, 'sine', 0.04 + i * 0.05, 0.07) // E
      tone(784, 120 + i * 50, 'sine', 0.04 + i * 0.04, 0.14) // G
      break
  }
}

export function announceSequenceSound(
  kind: string,
  id: string,
  confidence: number
): void {
  if (id === lastMomentId) return
  lastMomentId = id
  if (kind === 'TRAPPED_TRADERS') {
    playProcessSound('TRAP', confidence / 100)
  } else if (kind === 'WALL_RELEASE') {
    playProcessSound('WALL_RELEASE', confidence / 100)
  } else {
    playProcessSound('MOMENT', confidence / 100)
  }
}
