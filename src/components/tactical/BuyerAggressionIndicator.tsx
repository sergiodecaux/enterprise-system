import type { BuyerAggressionResult } from '../../engine/types'

interface BuyerAggressionIndicatorProps {
  aggression: BuyerAggressionResult
}

const BuyerAggressionIndicator = ({
  aggression,
}: BuyerAggressionIndicatorProps) => {
  const {
    detected,
    buyToSellRatio,
    threshold,
    largeBuyCount,
    color,
    label,
    windowSec,
  } = aggression

  const colorMap = {
    GREEN: {
      border: 'border-matrix/60',
      bg: 'bg-matrix/10',
      text: 'text-matrix',
      dot: 'bg-matrix',
      badge: 'bg-matrix/20 text-matrix',
      glow: 'shadow-[0_0_12px_rgba(0,255,65,0.3)]',
    },
    YELLOW: {
      border: 'border-yellow-400/50',
      bg: 'bg-yellow-400/8',
      text: 'text-yellow-400',
      dot: 'bg-yellow-400',
      badge: 'bg-yellow-400/20 text-yellow-400',
      glow: 'shadow-[0_0_8px_rgba(251,191,36,0.2)]',
    },
    NEUTRAL: {
      border: 'border-hull-border',
      bg: 'bg-hull',
      text: 'text-holo/40',
      dot: 'bg-holo/20',
      badge: 'bg-hull-light text-holo/40',
      glow: '',
    },
  }

  const c = colorMap[color]
  const totalVol = aggression.buyVolume + aggression.sellVolume

  return (
    <div
      className={`rounded-xl border ${c.border} ${c.bg} ${c.glow} p-3 transition-all duration-500`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="relative flex h-3 w-3">
          {detected && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full ${c.dot} opacity-60`}
            />
          )}
          <span
            className={`relative inline-flex h-3 w-3 rounded-full ${c.dot}`}
          />
        </span>

        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/70">
          Агрессия покупателей
        </span>

        {detected && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${c.badge}`}
          >
            +{aggression.scoreBoost} к оценке
          </span>
        )}
      </div>

      <div className="mb-3 flex items-end gap-3">
        <div>
          <div className="mb-0.5 font-mono text-[10px] uppercase text-holo/30">
            Покупка / Продажа
          </div>
          <div className={`font-mono text-2xl font-bold ${c.text}`}>
            {buyToSellRatio.toFixed(2)}
            <span className="ml-1 text-sm font-normal text-holo/40">x</span>
          </div>
        </div>

        <div className="mb-1">
          <div className="mb-0.5 font-mono text-[10px] text-holo/30">порог</div>
          <div className="font-mono text-sm text-holo/50">{threshold}x</div>
        </div>

        {largeBuyCount > 0 && (
          <div className="mb-1 ml-auto">
            <div className="mb-0.5 font-mono text-[10px] text-holo/30">
              крупных покупок
            </div>
            <div className={`font-mono text-sm font-bold ${c.text}`}>
              {largeBuyCount}
            </div>
          </div>
        )}
      </div>

      <div className="mb-2">
        <div className="relative h-2 overflow-hidden rounded-full bg-hull-border">
          <div
            className="absolute left-0 top-0 h-full rounded-l-full bg-alert/60 transition-all duration-700"
            style={{
              width: `${Math.min((aggression.sellVolume / totalVol) * 100, 100)}%`,
            }}
          />
          <div
            className={`absolute right-0 top-0 h-full rounded-r-full ${c.dot} transition-all duration-700`}
            style={{
              width: `${Math.min((aggression.buyVolume / totalVol) * 100, 100)}%`,
            }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-holo/30">
          <span>ПРОДАЖА</span>
          <span>ПОКУПКА</span>
        </div>
      </div>

      <p className={`font-mono text-[10px] leading-relaxed ${c.text}`}>
        {detected ? `⚡ ${label}` : `Мониторинг ленты · окно ${windowSec}с`}
      </p>
    </div>
  )
}

export default BuyerAggressionIndicator
