/**
 * Compact structure strip: hunt / trap / reclaim, then 1H → 4H → D.
 */

import type { StructureRead, TfStructure } from '../../engine/smc/structureRead'

interface Props {
  read: StructureRead | null
}

function fmtPx(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

function chip(tf: TfStructure | null, primary: boolean) {
  if (!tf) {
    return (
      <span className="font-mono text-[9px] text-white/30">
        {primary ? '1ч —' : '—'}
      </span>
    )
  }
  const ev = tf.lastReclaim ?? tf.lastChoch ?? tf.lastBos ?? tf.lastSweep
  const up = ev?.side === 'UP' || (!ev && tf.trend === 'BULLISH')
  const down = ev?.side === 'DOWN' || (!ev && tf.trend === 'BEARISH')
  const kind =
    ev?.kind === 'RECLAIM'
      ? 'закр'
      : ev?.kind === 'CHOCH'
        ? 'смена'
        : ev?.kind === 'BOS'
          ? 'слом'
          : ev?.kind === 'SWEEP'
            ? 'свип'
            : tf.trend === 'RANGING'
              ? 'флэт'
              : tf.trend === 'BULLISH'
                ? 'вверх'
                : 'вниз'
  const cls = up
    ? 'text-emerald-300'
    : down
      ? 'text-rose-300'
      : 'text-white/45'
  const name =
    tf.tf === '1h' ? '1ч' : tf.tf === '4h' ? '4ч' : tf.tf === '1d' ? 'день' : 'нед'
  return (
    <span
      className={`font-mono text-[9px] font-semibold ${cls} ${
        primary ? 'rounded bg-white/5 px-1 py-px' : ''
      }`}
    >
      {name} {kind}
      {up ? ' ↑' : down ? ' ↓' : ''}
    </span>
  )
}

function phaseLabel(read: StructureRead): { text: string; cls: string } {
  const p = read.trap?.phase
  if (p === 'TRADE_READY') {
    return {
      text: read.preferredSide === 'SHORT' ? 'Факт шорт' : 'Факт лонг',
      cls: 'text-emerald-300',
    }
  }
  if (p === 'TRAP') {
    return { text: 'Развод ММ', cls: 'text-amber-300' }
  }
  if (p === 'HUNTING') {
    return { text: 'Охота', cls: 'text-violet-300' }
  }
  if (p === 'SWEPT') {
    return { text: 'Сняли — ждём закреп', cls: 'text-sky-300' }
  }
  return { text: 'Ждём факт', cls: 'text-white/50' }
}

const StructureHud = ({ read }: Props) => {
  if (!read) return null
  const phase = phaseLabel(read)
  const trap = read.trap
  const dest = read.magnet

  return (
    <div className="space-y-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] px-2 py-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`font-mono text-[9px] font-bold uppercase ${phase.cls}`}>
          {phase.text}
        </span>
        {chip(read.h1, true)}
        {chip(read.h4, false)}
        {chip(read.d1, false)}
        {dest && (
          <span className="ml-auto font-mono text-[9px] text-white/55">
            {trap?.phase === 'TRADE_READY' ? 'цель' : 'охота'} {fmtPx(dest.price)}
          </span>
        )}
      </div>
      {trap && (trap.reclaimLevel != null || trap.weaknessLevel != null) && (
        <div className="font-mono text-[9px] text-white/45">
          {trap.reclaimLevel != null && (
            <span>
              закреп {fmtPx(trap.reclaimLevel)}
            </span>
          )}
          {trap.weaknessLevel != null && (
            <span>
              {trap.reclaimLevel != null ? ' · ' : ''}слабость {fmtPx(trap.weaknessLevel)}
            </span>
          )}
          {trap.crowdLongs != null && (
            <span> · лонги {fmtPx(trap.crowdLongs)}</span>
          )}
          {trap.crowdShorts != null && (
            <span> · шорты {fmtPx(trap.crowdShorts)}</span>
          )}
        </div>
      )}
    </div>
  )
}

export default StructureHud
