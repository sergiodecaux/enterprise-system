/**
 * TradingView-style popup opened by clicking a zone.
 * One card, two legs: hold (закреп) / break (пробой).
 * Context chips explain fib / 141 / strength / liquidity / sweeps.
 */

import type { ZoneAdvisorBrief, ZoneNote } from '../../engine/smc/zoneAdvisor'

export type AdvisorMode = 'hold' | 'break'

/** Used by the parent to clamp the popup inside the chart box. */
export const ADVISOR_CARD_W = 300
export const ADVISOR_CARD_H = 390

interface Props {
  brief: ZoneAdvisorBrief
  mode: AdvisorMode
  left: number
  top: number
  /** Телефон / Telegram Mini App: карточка снизу на всю ширину графика. */
  mobile?: boolean
  onMode: (mode: AdvisorMode) => void
  onClose: () => void
}

function px(p: number): string {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toPrecision(5)
}

const TONE_DOT: Record<ZoneNote['tone'], string> = {
  good: 'bg-emerald-400',
  bad: 'bg-rose-400',
  flat: 'bg-[#5d6675]',
}

const TONE_TEXT: Record<ZoneNote['tone'], string> = {
  good: 'text-emerald-300/90',
  bad: 'text-rose-300/90',
  flat: 'text-[#b2b5be]',
}

function rr(entry: number, stop: number, target: number): string {
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  if (!(risk > 0) || !(reward > 0)) return '—'
  return `1 : ${(reward / risk).toFixed(1)}`
}

const ZoneAdvisorCard = ({ brief, mode, left, top, mobile = false, onMode, onClose }: Props) => {
  const a = brief.primary
  const b = brief.alternate
  const leg = mode === 'hold' ? a : b
  const up = leg.side === 'LONG'
  const accent = up ? '#34d399' : '#fb7185'
  const alt = mode === 'hold' ? b : a

  return (
    <div
      data-advisor-card=""
      className="pointer-events-auto absolute z-30 select-none overflow-y-auto overscroll-contain rounded-md border border-[#2a2e39] bg-[#1e222d]/[0.97] shadow-[0_10px_28px_rgba(0,0,0,0.55)] backdrop-blur-sm"
      style={
        mobile
          ? {
              left: 6,
              right: 6,
              bottom: 6,
              width: 'auto',
              maxWidth: 'none',
              maxHeight: 'calc(100% - 12px)',
            }
          : { left, top, width: ADVISOR_CARD_W, maxWidth: 'calc(100% - 12px)' }
      }
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* header */}
      <div className="flex items-center gap-1.5 border-b border-[#2a2e39] px-2.5 py-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span className="truncate font-mono text-[11px] font-semibold text-[#d1d4dc]">
          {brief.zoneLabel}
        </span>
        <span className="rounded-sm bg-white/[0.06] px-1 py-px font-mono text-[11px] uppercase tracking-wide text-[#b2b5be]">
          {brief.strength > 0 ? `${Math.round(brief.strength)}/12` : '—'}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-[#5d6675]">
          {brief.timeframe}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="-mr-0.5 shrink-0 rounded px-1 font-mono text-[11px] leading-none text-[#787b86] transition-colors hover:text-[#d1d4dc]"
        >
          ✕
        </button>
      </div>

      {/* tabs */}
      <div className="grid grid-cols-2 gap-1 px-2 pt-2">
        {(
          [
            { id: 'hold' as const, text: 'Закреп', p: a.probability, color: up ? '#34d399' : '#fb7185' },
            { id: 'break' as const, text: 'Пробой', p: b.probability, color: '#8b96a8' },
          ]
        ).map((t) => {
          const on = t.id === mode
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onMode(t.id)}
              className={`flex items-center justify-between rounded-sm border px-1.5 py-1 font-mono text-[11px] transition-colors ${
                on
                  ? 'border-[#2a2e39] bg-white/[0.08] text-[#d1d4dc]'
                  : 'border-transparent bg-white/[0.02] text-[#787b86] hover:bg-white/[0.05]'
              }`}
            >
              <span className="uppercase tracking-wide">{t.text}</span>
              <span style={{ color: on ? t.color : undefined }}>{t.p}%</span>
            </button>
          )
        })}
      </div>

      {/* leg body */}
      <div className="px-2.5 pb-2 pt-2">
        <div className="flex items-center gap-1.5">
          <span
            className="font-mono text-[11px] font-bold uppercase tracking-wide"
            style={{ color: accent }}
          >
            {up ? 'лонг' : 'шорт'}
          </span>
          <span className="truncate font-mono text-[11px] text-[#787b86]">
            {leg.targetLabel}
          </span>
        </div>

        <p className="mt-1 font-mono text-[11px] leading-[1.35] text-[#b2b5be]">
          {mode === 'hold'
            ? up
              ? 'ЕСЛИ покупатель удержит зону и вернёт цену выше — вероятен ретест; при слабом импульсе цена может не дойти до цели.'
              : 'ЕСЛИ продавец удержит зону и закрепит цену ниже — вероятно продолжение к нижней ликвидности.'
            : up
              ? 'ЕСЛИ свеча закроется выше зоны и ретест удержится — сценарий продолжения вверх; возврат внутрь отменяет пробой.'
              : 'ЕСЛИ свеча закроется ниже зоны и ретест снизу не вернёт цену — сценарий продолжения вниз.'}
        </p>
        <div className="mt-2 rounded border border-white/[0.06] bg-black/20 px-2 py-1.5">
          <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-[#687386]">Что отменит сценарий</div>
          <div className="font-mono text-[11px] leading-relaxed text-[#b2b5be]">{leg.invalidationHint}</div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-[#b2b5be]">ЕСЛИ импульс ослабевает до цели — возможен откат к ближайшей встречной зоне.</div>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1">
          <Cell label="вход" value={px(leg.entry)} tone="#d1d4dc" />
          <Cell
            label="стоп"
            value={px(
              mode === 'hold'
                ? up
                  ? Math.min(leg.invalidation, leg.entryBottom)
                  : Math.max(leg.invalidation, leg.entryTop)
                : leg.invalidation
            )}
            tone="#f87171"
          />
          <Cell label="цель" value={px(leg.targetPrice)} tone={accent} />
        </div>

        <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-[#787b86]">
          <span>
            R:R{' '}
            <span className="text-[#b2b5be]">
              {rr(
                leg.entry,
                mode === 'hold'
                  ? up
                    ? Math.min(leg.invalidation, leg.entryBottom)
                    : Math.max(leg.invalidation, leg.entryTop)
                  : leg.invalidation,
                leg.targetPrice
              )}
            </span>
          </span>
          <span className="truncate pl-2 text-right">
            альтернатива: {alt.side === 'LONG' ? 'лонг' : 'шорт'} → {px(alt.targetPrice)}
          </span>
        </div>

        {/* probability bar */}
        <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-[#2a2e39]">
          <div
            className="h-full rounded-full transition-[width] duration-200"
            style={{
              width: `${Math.max(4, Math.min(100, leg.probability))}%`,
              background: accent,
            }}
          />
        </div>
      </div>

      {/* context */}
      {brief.notes.length > 0 && (
        <div className="border-t border-[#2a2e39] px-2.5 py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[#5d6675]">
              Контекст зоны
            </span>
            <span className="font-mono text-[11px] text-[#787b86]">
              совпадений {brief.confluence}/5
            </span>
          </div>
          <div className="space-y-[3px]">
            {brief.notes.map((n) => (
              <div key={n.key} className="flex items-center gap-1.5">
                <span
                  className={`h-1 w-1 shrink-0 rounded-full ${TONE_DOT[n.tone]}`}
                />
                <span className="shrink-0 font-mono text-[11px] text-[#787b86]">
                  {n.label}
                </span>
                <span
                  className={`ml-auto truncate pl-1 text-right font-mono text-[11px] ${TONE_TEXT[n.tone]}`}
                  title={n.value}
                >
                  {n.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[#2a2e39] px-2.5 py-1 font-mono text-[11px] text-[#5d6675]">
        зона {px(brief.zoneBottom)} – {px(brief.zoneTop)} · клик по графику закрывает
      </div>
    </div>
  )
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: string
}) {
  return (
    <div className="rounded-sm bg-white/[0.03] px-1 py-1">
      <div className="font-mono text-[11px] uppercase tracking-wide text-[#5d6675]">
        {label}
      </div>
      <div className="truncate font-mono text-[11px] font-semibold" style={{ color: tone }}>
        {value}
      </div>
    </div>
  )
}

export default ZoneAdvisorCard
