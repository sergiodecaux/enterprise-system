/**
 * Compact Smart Money structure strip: 1H (primary) → 4H → D → W.
 */

import type { StructureRead, TfStructure } from '../../engine/smc/structureRead'

interface Props {
  read: StructureRead | null
}

function chip(tf: TfStructure | null, primary: boolean) {
  if (!tf) {
    return (
      <span className="font-mono text-[9px] text-white/30">{primary ? '1H —' : '—'}</span>
    )
  }
  const ev = tf.lastReclaim ?? tf.lastChoch ?? tf.lastBos ?? tf.lastSweep
  const up =
    ev?.side === 'UP' || (!ev && tf.trend === 'BULLISH')
  const down =
    ev?.side === 'DOWN' || (!ev && tf.trend === 'BEARISH')
  const kind =
    ev?.kind === 'RECLAIM'
      ? 'закр'
      : ev?.kind === 'CHOCH'
        ? 'CHoCH'
        : ev?.kind === 'BOS'
          ? 'BOS'
          : ev?.kind === 'SWEEP'
            ? 'свип'
            : tf.trend === 'RANGING'
              ? 'флэт'
              : tf.trend === 'BULLISH'
                ? 'HH'
                : 'LL'
  const cls = up
    ? 'text-emerald-300'
    : down
      ? 'text-rose-300'
      : 'text-white/45'
  return (
    <span
      className={`font-mono text-[9px] font-semibold ${cls} ${
        primary ? 'rounded bg-white/5 px-1 py-px' : ''
      }`}
    >
      {tf.tf.toUpperCase()} {kind}
      {up ? '↑' : down ? '↓' : ''}
      {tf.inDiscount ? ' · disc' : tf.inPremium ? ' · prem' : ''}
    </span>
  )
}

const StructureHud = ({ read }: Props) => {
  if (!read) return null
  const biasCls =
    read.bias === 'BULLISH'
      ? 'text-emerald-300'
      : read.bias === 'BEARISH'
        ? 'text-rose-300'
        : 'text-white/50'
  const fib = read.fib141
  const fibCls =
    fib?.state === 'BOUNCE' || fib?.state === 'RECLAIM'
      ? 'text-amber-200'
      : fib?.state === 'BREAK'
        ? 'text-orange-300'
        : 'text-amber-200/70'

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-white/[0.08] bg-[#10141a] px-2 py-1">
      <span className={`font-mono text-[9px] font-bold uppercase ${biasCls}`}>
        SMC {read.bias === 'BULLISH' ? '↑' : read.bias === 'BEARISH' ? '↓' : '·'}{' '}
        {read.confidence}%
      </span>
      {chip(read.h1, true)}
      {chip(read.h4, false)}
      {chip(read.d1, false)}
      {chip(read.w1, false)}
      {fib && (
        <span className={`font-mono text-[9px] ${fibCls}`}>
          141{' '}
          {fib.state === 'BOUNCE'
            ? 'отскок'
            : fib.state === 'BREAK'
              ? 'слом'
              : fib.state === 'RECLAIM'
                ? 'закреп'
                : fib.state === 'INSIDE'
                  ? 'внутри'
                  : fib.state === 'APPROACHING'
                    ? 'подход'
                    : 'watch'}
        </span>
      )}
      {read.magnet && (
        <span className="ml-auto font-mono text-[9px] text-white/40">
          → {read.magnet.label} {read.magnet.price >= 1
            ? read.magnet.price.toFixed(4)
            : read.magnet.price.toPrecision(5)}
        </span>
      )}
    </div>
  )
}

export default StructureHud
