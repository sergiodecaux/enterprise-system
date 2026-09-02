/**
 * Live scenario board: which path is leading, and why — not a binary reclaim line.
 */

import type { StructureRead, TfStructure } from '../../engine/smc/structureRead'

interface Props {
  read: StructureRead | null
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
  const board = read.scenarios
  const lead = board?.scenarios[0] ?? null
  const list = board?.scenarios ?? []

  const nest = read.cascade
  const regime =
    nest?.regime === 'TREND'
      ? 'Тренд'
      : nest?.regime === 'PULLBACK'
        ? 'Откат / топливо'
        : nest?.regime === 'COUNTERTREND'
          ? 'Контртренд'
          : 'Пила'
  const tone =
    nest?.regime === 'TREND'
      ? 'border-emerald-400/30 bg-emerald-950/35 text-emerald-100'
      : nest?.regime === 'PULLBACK'
        ? 'border-amber-400/30 bg-amber-950/30 text-amber-100'
        : nest?.regime === 'COUNTERTREND'
          ? 'border-rose-400/30 bg-rose-950/30 text-rose-100'
          : 'border-cyan-400/25 bg-slate-950/50 text-cyan-100'

  return (
    <div className={`rounded-xl border px-3 py-2 ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-bold uppercase tracking-wide text-white/90">
            {regime}
            {lead ? ` · ${lead.id} ${lead.title} · ${lead.probability}%` : ''}
          </div>
          <p className="mt-0.5 font-mono text-[11px] leading-snug text-white/75">
            {board?.now ?? read.summary}
          </p>
          {read.fuel && (
            <p className="mt-0.5 font-mono text-[10px] text-white/55">
              Топливо: {read.fuel.label} {read.fuel.price >= 1000 ? read.fuel.price.toFixed(1) : read.fuel.price.toPrecision(5)}
              {nest?.entrySide ? ' · 15м только вход' : ''}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right font-mono text-[9px] text-white/40">
          <div>{tfBit(read.w1)}</div>
          <div>{tfBit(read.d1)}</div>
          <div>{tfBit(read.h4)}</div>
          <div>{tfBit(read.h1)}</div>
        </div>
      </div>

      {list.length > 0 && (
        <div className="mt-2 max-h-[24vh] space-y-1.5 overflow-y-auto">
          {list.map((sc, i) => {
            const leadRow = i === 0
            return (
              <div
                key={sc.id}
                className={`rounded-lg border px-2 py-1.5 ${
                  leadRow
                    ? 'border-white/20 bg-black/35'
                    : 'border-white/10 bg-black/20'
                }`}
              >
                <div className="flex items-baseline gap-2 font-mono text-[10px]">
                  <span
                    className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: sc.color }}
                  />
                  <span className="font-bold" style={{ color: sc.color }}>
                    {sc.id} {sc.probability}%
                  </span>
                  <span className="text-white/85">{sc.title}</span>
                </div>
                <p className="mt-0.5 pl-4 font-mono text-[10px] leading-snug text-white/60">
                  {sc.why}
                </p>
                <p className="mt-0.5 pl-4 font-mono text-[9px] text-white/40">
                  {sc.invalidation}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default StructureHud
