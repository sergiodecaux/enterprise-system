/**
 * MM trap board: hunt vs actual trade. Visible on purpose — not a 9px chip.
 */

import type { StructureRead, TfStructure } from '../../engine/smc/structureRead'

interface Props {
  read: StructureRead | null
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(1)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function tfBit(tf: TfStructure | null): string {
  if (!tf) return '—'
  const name =
    tf.tf === '1h' ? '1ч' : tf.tf === '4h' ? '4ч' : tf.tf === '1d' ? 'день' : 'нед'
  const ev = tf.lastSweep ?? tf.lastReclaim ?? tf.lastChoch ?? tf.lastBos
  const arrow = ev?.side === 'UP' ? '↑' : ev?.side === 'DOWN' ? '↓' : ''
  const kind =
    ev?.kind === 'SWEEP'
      ? 'свип'
      : ev?.kind === 'RECLAIM'
        ? 'закр'
        : ev?.kind === 'CHOCH'
          ? 'смена'
          : ev?.kind === 'BOS'
            ? 'слом'
            : tf.trend === 'BULLISH'
              ? 'вверх'
              : tf.trend === 'BEARISH'
                ? 'вниз'
                : 'флэт'
  return `${name} ${kind}${arrow}`
}

const StructureHud = ({ read }: Props) => {
  if (!read) return null
  const trap = read.trap
  const phase = trap?.phase ?? 'NEUTRAL'
  const ready = phase === 'TRADE_READY'
  const trapLong = trap?.trapSide === 'LONG'

  const headline = ready
    ? trap?.tradeSide === 'SHORT'
      ? 'СДЕЛКА: ШОРТ'
      : 'СДЕЛКА: ЛОНГ'
    : phase === 'TRAP'
      ? trapLong
        ? 'ММ КОРМИТ ЛОНГИ'
        : 'ММ КОРМИТ ШОРТЫ'
      : phase === 'HUNTING'
        ? trap?.huntSide === 'LONG'
          ? 'ОХОТА НА ШОРТЫ — НЕ ЛОНГ'
          : 'ОХОТА НА ЛОНГИ — НЕ ШОРТ'
        : phase === 'SWEPT'
          ? 'СНЯЛИ — ЖДЁМ ЗАКРЕП'
          : 'НЕТ СДЕЛКИ'

  const tone = ready
    ? 'border-emerald-400/35 bg-emerald-950/40 text-emerald-200'
    : phase === 'TRAP'
      ? 'border-amber-400/40 bg-amber-950/45 text-amber-200'
      : 'border-violet-400/30 bg-violet-950/35 text-violet-100'

  return (
    <div className={`rounded-xl border px-3 py-2 ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[12px] font-bold uppercase tracking-wide">
            {headline}
          </div>
          <p className="mt-0.5 font-mono text-[11px] leading-snug text-white/75">
            {trap?.summary ?? read.summary}
          </p>
        </div>
        <div className="shrink-0 text-right font-mono text-[9px] text-white/40">
          <div>{tfBit(read.h1)}</div>
          <div>{tfBit(read.h4)}</div>
          <div>{tfBit(read.d1)}</div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] uppercase tracking-wider text-white/35">
            Для сделки
          </div>
          {ready ? (
            <div className="text-emerald-200">
              {trap?.tradeSide === 'SHORT' ? 'шорт' : 'лонг'}
              {trap?.reclaimLevel != null
                ? ` · держать ${fmtPx(trap.reclaimLevel)}`
                : ''}
            </div>
          ) : (
            <div className="text-white/70">
              {trap?.reclaimLevel != null
                ? `закреп ${fmtPx(trap.reclaimLevel)}`
                : 'нет закрепа — не входим'}
            </div>
          )}
          {trap?.weaknessLevel != null && (
            <div className="text-rose-300/80">
              слабость {fmtPx(trap.weaknessLevel)}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] uppercase tracking-wider text-white/35">
            Где висит толпа
          </div>
          <div className="text-emerald-300/90">
            лонги {trap?.crowdLongs != null ? fmtPx(trap.crowdLongs) : '—'}
          </div>
          <div className="text-rose-300/90">
            шорты {trap?.crowdShorts != null ? fmtPx(trap.crowdShorts) : '—'}
          </div>
        </div>
      </div>

      {trap?.forecast && (
        <p className="mt-1.5 font-mono text-[10px] leading-snug text-white/55">
          {trap.forecast}
        </p>
      )}
    </div>
  )
}

export default StructureHud
