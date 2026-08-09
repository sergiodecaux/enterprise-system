import { useEffect, useState } from 'react'
import {
  getFrames,
  getOiSnapshot,
  getCachedSpotPerpHealth,
  getVenueLeadCache,
  evaluateVenueLead,
  type SequenceHit,
} from '../../engine/sequence'
import type { MarketRegime } from '../../engine/regime/marketRegime'

interface Props {
  symbol: string
  regime: MarketRegime
  sequence: SequenceHit | null
  refreshKey?: number
}

const REGIME_LABEL: Record<MarketRegime, string> = {
  TRENDING_STRONG: 'Тренд ↑',
  TRENDING_WEAK: 'Тренд ~',
  RANGING: 'Боковик',
  VOLATILE_CHOP: 'Хаос',
}

/**
 * Полоска процесса: режим · OI · спот/перп · лента кадров · активный момент.
 */
const ProcessStrip = ({ symbol, regime, sequence, refreshKey = 0 }: Props) => {
  const [dots, setDots] = useState<
    Array<{ kind: string; side?: string; strength: number; tip: string }>
  >([])
  const [oiLabel, setOiLabel] = useState<string>('Интерес …')
  const [healthLabel, setHealthLabel] = useState<string>('Спот …')
  const [healthTip, setHealthTip] = useState<string>('')
  const [healthTone, setHealthTone] = useState<string>('text-white/35')
  const [venueLabel, setVenueLabel] = useState<string>('BN …')
  const [venueTip, setVenueTip] = useState<string>('')
  const [venueTone, setVenueTone] = useState<string>('text-white/35')

  useEffect(() => {
    const frames = getFrames(symbol, 5 * 60_000)
    const interesting = frames.filter((f) =>
      ['HIT', 'WALL', 'DELTA', 'OI', 'BOOK', 'LIQ', 'SPOT_PERP', 'VENUE'].includes(
        f.kind
      )
    )
    const recent = interesting.slice(-18).map((f) => ({
      kind: f.kind,
      side: f.side,
      strength: f.strength ?? 0.4,
      tip: frameTip(f.kind, f.side),
    }))
    setDots(recent)

    const oi = getOiSnapshot(symbol)
    if (oi) {
      const sign = oi.changePct >= 0 ? '+' : ''
      setOiLabel(`Контракты ${sign}${oi.changePct.toFixed(1)}%`)
    } else {
      setOiLabel('Контракты …')
    }

    const hitBuy = frames
      .filter((f) => f.kind === 'HIT' && f.side === 'BUY')
      .reduce((s, f) => s + (f.volumeUsd ?? 0), 0)
    const hitSell = frames
      .filter((f) => f.kind === 'HIT' && f.side === 'SELL')
      .reduce((s, f) => s + (f.volumeUsd ?? 0), 0)
    // Approximate perp delta from HIT frames when trades cache empty
    const perpApprox = hitBuy - hitSell
    const health = getCachedSpotPerpHealth(symbol, perpApprox)
    setHealthLabel(health.label)
    setHealthTip(health.tip)
    setHealthTone(
      health.status === 'SPOT_LED' || health.status === 'ALIGNED'
        ? 'text-emerald-300/80'
        : health.status === 'DIVERGED' || health.status === 'PERP_LED'
          ? 'text-amber-300/80'
          : 'text-white/35'
    )

    const lead = getVenueLeadCache(symbol)
    const wallPx = [...frames]
      .reverse()
      .find((f) => f.kind === 'WALL' && f.price != null)?.price
    const venue = evaluateVenueLead({
      localPrice: wallPx ?? lead?.mid ?? 0,
      bidWallAlive: frames.some(
        (f) => f.kind === 'WALL' && f.side === 'BID' && (f.strength ?? 0) >= 0.4
      ),
      askWallAlive: frames.some(
        (f) => f.kind === 'WALL' && f.side === 'ASK' && (f.strength ?? 0) >= 0.4
      ),
      lead,
    })
    setVenueLabel(venue.label)
    setVenueTip(venue.reason || 'Binance futures lead')
    setVenueTone(
      venue.kind === 'ARB_WALL_RISK'
        ? 'text-rose-300/90'
        : venue.kind === 'LEAD_CONFIRM'
          ? 'text-sky-300/85'
          : lead?.connected
            ? 'text-white/45'
            : 'text-white/25'
    )
  }, [symbol, refreshKey, sequence?.detectedAt])

  const seqLive =
    sequence && sequence.expiresAt > Date.now() ? sequence : null
  const regimeColor =
    regime === 'TRENDING_STRONG'
      ? 'text-emerald-300 bg-emerald-500/15 border-emerald-400/30'
      : regime === 'TRENDING_WEAK'
        ? 'text-emerald-200/80 bg-emerald-500/10 border-emerald-400/20'
        : regime === 'VOLATILE_CHOP'
          ? 'text-rose-300 bg-rose-500/15 border-rose-400/30'
          : 'text-sky-300 bg-sky-500/12 border-sky-400/25'

  const dotColor = (kind: string, side?: string) => {
    if (kind === 'HIT')
      return side === 'BUY' ? 'bg-emerald-400' : 'bg-rose-400'
    if (kind === 'WALL')
      return side === 'BID' ? 'bg-cyan-400' : 'bg-orange-400'
    if (kind === 'DELTA') return 'bg-violet-400'
    if (kind === 'OI') return 'bg-amber-300'
    if (kind === 'LIQ') return 'bg-fuchsia-400'
    if (kind === 'SPOT_PERP') return 'bg-teal-300'
    if (kind === 'VENUE') return 'bg-sky-300'
    return 'bg-white/35'
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-white/[0.07] bg-[#0e1218] px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wide ${regimeColor}`}
          title="Первый кадр: в каком состоянии рынок"
        >
          {REGIME_LABEL[regime]}
        </span>
        <span
          className="font-mono text-[9px] text-white/40"
          title="Как меняется число открытых контрактов"
        >
          {oiLabel}
        </span>
        <span
          className={`font-mono text-[9px] font-semibold ${healthTone}`}
          title={healthTip || 'Здоровье: спот vs перпы'}
        >
          {healthLabel}
        </span>
        <span
          className={`font-mono text-[9px] font-semibold ${venueTone}`}
          title={venueTip}
        >
          {venueLabel}
        </span>
        {seqLive ? (
          <span
            className={`ml-auto truncate rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold ${
              seqLive.allowedInRegime
                ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                : 'border-white/10 bg-white/[0.04] text-white/40'
            }`}
            title={seqLive.summary}
          >
            {seqLive.side === 'LONG' ? 'Момент ↑' : 'Момент ↓'} ~
            {seqLive.confidence}%
            {!seqLive.allowedInRegime ? ' · не сейчас' : ''}
          </span>
        ) : (
          <span className="ml-auto font-mono text-[9px] text-white/25">
            ждём процесс…
          </span>
        )}
      </div>

      {dots.length > 0 && (
        <div className="flex items-center gap-0.5 overflow-hidden">
          <span className="mr-1 shrink-0 font-mono text-[8px] text-white/25">
            5м
          </span>
          {dots.map((d, i) => (
            <span
              key={`${d.kind}-${i}`}
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor(d.kind, d.side)}`}
              style={{ opacity: 0.35 + d.strength * 0.65 }}
              title={d.tip}
            />
          ))}
          <span className="ml-auto flex flex-wrap gap-x-1.5 gap-y-0 font-mono text-[7px] text-white/25">
            <span className="text-emerald-400/60">покупки</span>
            <span className="text-rose-400/60">продажи</span>
            <span className="text-cyan-400/60">стены</span>
            <span className="text-fuchsia-400/55">liq</span>
            <span className="text-amber-300/50">контракты</span>
          </span>
        </div>
      )}

      {seqLive && (
        <p className="truncate font-mono text-[9px] leading-snug text-white/50">
          {seqLive.title}
          {seqLive.histWr && seqLive.histWr.decided >= 3
            ? ` · раньше сработало ${seqLive.histWr.winRate?.toFixed(0) ?? '—'}%`
            : ''}
        </p>
      )}
    </div>
  )
}

function frameTip(kind: string, side?: string): string {
  if (kind === 'HIT' && side === 'BUY') return 'Рыночные покупки'
  if (kind === 'HIT' && side === 'SELL') return 'Рыночные продажи'
  if (kind === 'WALL' && side === 'BID') return 'Стена снизу (опора)'
  if (kind === 'WALL' && side === 'ASK') return 'Стена сверху (крыша)'
  if (kind === 'DELTA') return 'Баланс покупок и продаж'
  if (kind === 'OI') return 'Открытый интерес'
  if (kind === 'BOOK') return 'Перевес в стакане'
  if (kind === 'LIQ' && side === 'SHORT_LIQ') return 'Ликвидации шортов (forced buy)'
  if (kind === 'LIQ' && side === 'LONG_LIQ') return 'Ликвидации лонгов (forced sell)'
  if (kind === 'LIQ') return 'Волна ликвидаций'
  if (kind === 'SPOT_PERP') return 'Спот vs перпы'
  if (kind === 'VENUE') return 'Binance lead / arb риск стены'
  return kind
}

export default ProcessStrip
