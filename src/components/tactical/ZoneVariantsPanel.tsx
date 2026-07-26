/**
 * Trade variants for found liquidity zones (bounce / break).
 */

import type { ConditionalSetup } from '../../engine/setups'
import type { FoundTradeZone } from '../../engine/zones/findTradeZones'

interface Props {
  zones: FoundTradeZone[]
  setups: ConditionalSetup[]
  selectedId: string | null
  watchingIds: Set<string>
  onSelect: (setup: ConditionalSetup) => void
  onWatch: (setup: ConditionalSetup) => void
  busy?: boolean
}

function fmt(p: number): string {
  if (!(p > 0)) return '—'
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function strengthDots(strength: number): string {
  if (strength >= 9) return '●●●'
  if (strength >= 7) return '●●'
  return '●'
}

function strengthLabel(strength: number): string {
  if (strength >= 9) return 'сильная'
  if (strength >= 7) return 'средняя'
  return 'слабая'
}

const ZoneVariantsPanel = ({
  zones,
  setups,
  selectedId,
  watchingIds,
  onSelect,
  onWatch,
  busy,
}: Props) => {
  if (!zones.length && !setups.length) return null

  return (
    <div className="space-y-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300/80">
          Варианты на зонах
        </div>
        <div className="font-mono text-[9px] text-holo/35">
          {zones.length} зон · {setups.length} сделок ·{' '}
          {setups[0]?.tradeStyle === 'SCALP'
            ? '#SCALP'
            : setups[0]?.tradeStyle === 'SWING'
              ? '#SWING'
              : '#INTRA'}{' '}
          · бот
        </div>
      </div>

      {zones.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {zones.map((z) => (
            <span
              key={z.id}
              className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                z.side === 'LONG'
                  ? 'border-teal-400/45 bg-teal-500/10 text-teal-200'
                  : 'border-rose-400/45 bg-rose-500/10 text-rose-200'
              }`}
              title={
                z.side === 'LONG'
                  ? `Удерж зоны → вверх · слом < ${fmt(z.invalidation)}`
                  : `Удерж зоны → вниз · слом > ${fmt(z.invalidation)}`
              }
            >
              <span className="mr-1 opacity-70">{strengthDots(z.strength)}</span>
              {z.side === 'LONG' ? 'SSL↑' : 'BSL↓'} {z.source} @ {fmt(z.mid)}
              <span className="ml-1 opacity-50">
                {z.distancePct >= 0 ? '+' : ''}
                {z.distancePct.toFixed(2)}%
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-white/5 bg-black/20 px-2 py-1.5 font-mono text-[9px] text-holo/45">
        <span className="text-teal-300/80">бирюза SSL</span> — закрепиться, чтобы
        идти вверх ·{' '}
        <span className="text-rose-300/80">роза BSL</span> — удерж шорта / слом
        выше = потеряли уровень
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
        {setups.map((s) => {
          const selected = selectedId === s.id
          const watching = watchingIds.has(s.id)
          const isBreak = s.kind === 'STOP_THEN_REVERSE'
          const zone = zones.find((z) => s.id.startsWith(z.id))
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s)}
              className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                selected
                  ? 'border-emerald-400/50 bg-hull-light/40'
                  : 'border-hull-border/60 bg-hull/40 hover:border-holo/30'
              }`}
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <div>
                  <span
                    className={`font-mono text-[11px] font-bold ${
                      s.side === 'LONG' ? 'text-teal-300' : 'text-rose-300'
                    }`}
                  >
                    {s.side}
                  </span>
                  <span className="ml-2 font-mono text-[10px] text-holo/50">
                    {s.tradeStyle === 'SCALP'
                      ? '#SCALP'
                      : s.tradeStyle === 'SWING'
                        ? '#SWING'
                        : '#INTRA'}{' '}
                    · {isBreak ? 'слом' : 'отскок'}
                    {zone && (
                      <>
                        {' '}
                        · {strengthDots(zone.strength)}{' '}
                        {strengthLabel(zone.strength)}
                      </>
                    )}
                  </span>
                  <div className="mt-0.5 font-mono text-[11px] text-holo">
                    {s.title}
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] text-holo/40">
                    {isBreak
                      ? s.side === 'LONG'
                        ? `Слом зоны вверх → лонг · SL ${fmt(s.invalidation)}`
                        : `Слом зоны вниз → шорт · SL ${fmt(s.invalidation)}`
                      : s.side === 'LONG'
                        ? `Удерж SSL → вверх · слом < ${fmt(s.invalidation)}`
                        : `Удерж BSL → вниз · слом > ${fmt(s.invalidation)}`}
                  </div>
                </div>
                <div className="text-right font-mono text-sm font-bold text-holo">
                  {Math.round(s.probability)}%
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1 font-mono text-[9px] text-holo/45">
                <div>
                  Вход
                  <div className="text-sky-300/90">{fmt(s.limitEntry)}</div>
                </div>
                <div>
                  Слом
                  <div className="text-rose-300/90">{fmt(s.invalidation)}</div>
                </div>
                <div>
                  Цель
                  <div className="text-teal-300/90">{fmt(s.target)}</div>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] text-holo/35">
                  {s.status === 'READY'
                    ? 'ГОТОВ'
                    : s.status === 'ARMED'
                      ? 'на зоне'
                      : 'ждём'}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!busy && !watching) onWatch(s)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy && !watching) onWatch(s)
                  }}
                  className={`rounded px-2 py-0.5 font-mono text-[9px] font-bold ${
                    watching
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-holo/10 text-holo/70 hover:bg-holo/20'
                  }`}
                >
                  {watching ? 'в боте' : 'следить'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default ZoneVariantsPanel
