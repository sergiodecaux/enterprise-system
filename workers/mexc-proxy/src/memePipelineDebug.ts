/**
 * Persist last meme scan funnel for /debug Telegram command.
 */

export const MEME_PIPELINE_DEBUG_KEY = 'scanner:meme_pipeline_debug_v1'

export interface MemePipelineSample {
  symbol: string
  age_minutes: number
  spike_detected: boolean
  regime: string
  exhaustion: number
  vol_ratio: number
  age_gate: string
  book_score_short: number
  book_real_short: boolean
  book_toxic_short: boolean
  book_bias_short: string
  wall_age_sec: number
  reject?: string
}

export interface MemePipelineDebug {
  at: number
  hotlist: number
  scanned: number
  age_gate_pass: number
  age_gate_block: number
  alerts_peak: number
  alerts_pump: number
  rejectStats: Record<string, number>
  samples: MemePipelineSample[]
  topRejects: Array<{ symbol: string; reason: string }>
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<unknown>
}

export function bucketRejectReason(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes('age_gate') || r.includes('too_early') || r.includes('zombie'))
    return 'age_gate'
  if (r.includes('toxic') || r.includes('book_toxic')) return 'book_toxic'
  if (r.includes('no_weakness') || r.includes('peak_b')) return 'peak_structure'
  if (r.includes('pump_b') || r.includes('no_pump')) return 'pump_structure'
  if (r.includes('regime')) return 'regime'
  if (r.includes('exh')) return 'exhaustion'
  if (r.includes('dump')) return 'dump'
  if (r.includes('hist_dead')) return 'hist_dead'
  return reason.split(':')[0]?.slice(0, 28) || 'other'
}

export async function saveMemePipelineDebug(
  kv: KvLike | undefined,
  data: MemePipelineDebug
): Promise<void> {
  if (!kv) return
  try {
    await kv.put(MEME_PIPELINE_DEBUG_KEY, JSON.stringify(data))
  } catch {
    /* ignore */
  }
}

export async function loadMemePipelineDebug(
  kv: KvLike | undefined
): Promise<MemePipelineDebug | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(MEME_PIPELINE_DEBUG_KEY)
    if (!raw) return null
    return JSON.parse(raw) as MemePipelineDebug
  } catch {
    return null
  }
}

export function formatMemePipelineDebug(d: MemePipelineDebug | null): string {
  if (!d) {
    return '🧪 <b>Pipeline debug</b>\nНет снимка — подожди cron */2 или /scan.'
  }
  const ageMin = Math.round((Date.now() - d.at) / 60_000)
  const top = Object.entries(d.rejectStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `  ${k}: ${n}`)
  const samples = d.samples.slice(0, 4).map((s) => {
    return (
      `${s.symbol.replace('_USDT', '')}: age=${s.age_minutes}m ` +
      `exh=${s.exhaustion} ${s.regime} bk=${s.book_score_short}` +
      `${s.book_toxic_short ? ' TOXIC' : ''}` +
      `${s.book_real_short ? ' real' : ''}` +
      (s.reject ? `\n  → ${s.reject.slice(0, 60)}` : '')
    )
  })
  return [
    `🧪 <b>Meme pipeline</b> · ${ageMin}м назад`,
    `Hotlist: <b>${d.hotlist}</b> · scanned: <b>${d.scanned}</b>`,
    `AgeGate pass: <b>${d.age_gate_pass}</b> · block: <b>${d.age_gate_block}</b>`,
    `A alerts: PEAK <b>${d.alerts_peak}</b> · PUMP <b>${d.alerts_pump}</b>`,
    '',
    '<b>Топ отказов:</b>',
    ...(top.length ? top : ['  (нет)']),
    '',
    '<b>Сэмплы:</b>',
    ...(samples.length ? samples : ['  —']),
  ].join('\n')
}
