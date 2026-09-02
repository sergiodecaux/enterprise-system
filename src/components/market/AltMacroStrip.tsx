import type { WorkerMarketContext } from '../../api/marketContext'
import {
  altBiasLabel,
  deriveAltMacro,
  fmtSigned,
  fmtTotal3Usd,
} from '../../engine/analysis/altMacro'

export function AltMacroStrip({ ctx }: { ctx: WorkerMarketContext | null }) {
  const macro = deriveAltMacro(ctx ?? {})
  const biasTone =
    macro.altBias === 'LONG'
      ? 'text-emerald-300'
      : macro.altBias === 'SHORT'
        ? 'text-rose-300'
        : 'text-white/70'

  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-2 text-center">
        <div className="font-mono text-[9px] uppercase text-white/40">BTC.D</div>
        <div className="font-mono text-sm font-bold text-white">
          {ctx?.btcDominance != null ? `${ctx.btcDominance.toFixed(1)}%` : '—'}
        </div>
        <div className="font-mono text-[9px] text-white/40">
          {fmtSigned(ctx?.btcDomDelta24h, 2, 'пп') || '24ч'}
        </div>
      </div>
      <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-2 text-center">
        <div className="font-mono text-[9px] uppercase text-white/40">TOTAL3</div>
        <div className="font-mono text-sm font-bold text-white">
          {fmtTotal3Usd(ctx?.total3Usd)}
        </div>
        <div className="font-mono text-[9px] text-white/40">
          {fmtSigned(ctx?.total3Delta24h ?? ctx?.totalMcapDelta24h, 1, '%') || 'ex BTC+ETH'}
        </div>
      </div>
      <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-2 text-center">
        <div className="font-mono text-[9px] uppercase text-white/40">Альты</div>
        <div className={`font-mono text-[11px] font-bold leading-tight ${biasTone}`}>
          {altBiasLabel(macro.altBias)}
        </div>
        <div className="font-mono text-[9px] text-white/40">
          {macro.regime === 'NEUTRAL' ? 'BTC.D×TOTAL3' : macro.regime.replace('_', ' ')}
        </div>
      </div>
    </div>
  )
}
