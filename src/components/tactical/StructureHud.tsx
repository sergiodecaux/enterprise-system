/**
 * Compact structure strip: закреп vs слом, then 1H → 4H → D.
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

const StructureHud = ({ read }: Props) => {
  if (!read) return null
  const held = read.structureHeld
  const dest = read.magnet
  const fly = read.preferredSide === 'LONG'

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] px-2 py-1">
      <span
        className={`font-mono text-[9px] font-bold uppercase ${
          held ? 'text-emerald-300' : 'text-rose-300'
        }`}
      >
        {held ? 'Закреп держит' : 'Структура потеряна'}
      </span>
      {chip(read.h1, true)}
      {chip(read.h4, false)}
      {chip(read.d1, false)}
      {dest && (
        <span className="ml-auto font-mono text-[9px] text-white/55">
          {held ? 'цель' : fly ? 'полёт к' : 'падение к'} {fmtPx(dest.price)}
        </span>
      )}
    </div>
  )
}

export default StructureHud
