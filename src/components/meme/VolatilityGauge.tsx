import type { VolatilityGaugeResult } from '../../engine/meme/volatility'

interface Props {
  volatility: VolatilityGaugeResult
  compact?: boolean
}

/**
 * Спидометр волатильности мем-коина.
 * 5%+/1m → стрелка в красной зоне.
 */
const VolatilityGauge = ({ volatility, compact = false }: Props) => {
  const angle = -90 + (volatility.gauge / 100) * 180
  const zoneColor =
    volatility.zone === 'RED'
      ? '#ff003c'
      : volatility.zone === 'ORANGE'
        ? '#ff6b00'
        : volatility.zone === 'YELLOW'
          ? '#facc15'
          : '#00ff41'

  const size = compact ? 56 : 72

  return (
    <div className="flex flex-col items-center">
      <svg
        width={size}
        height={size * 0.62}
        viewBox="0 0 100 62"
        className="overflow-visible"
      >
        {/* Arc background */}
        <path
          d="M 10 55 A 40 40 0 0 1 90 55"
          fill="none"
          stroke="#2a2a2a"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {/* Green zone */}
        <path
          d="M 10 55 A 40 40 0 0 1 35 22"
          fill="none"
          stroke="#00ff4133"
          strokeWidth="8"
          strokeLinecap="butt"
        />
        {/* Yellow */}
        <path
          d="M 35 22 A 40 40 0 0 1 55 15"
          fill="none"
          stroke="#facc1533"
          strokeWidth="8"
        />
        {/* Orange */}
        <path
          d="M 55 15 A 40 40 0 0 1 72 22"
          fill="none"
          stroke="#ff6b0033"
          strokeWidth="8"
        />
        {/* Red */}
        <path
          d="M 72 22 A 40 40 0 0 1 90 55"
          fill="none"
          stroke="#ff003c44"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {/* Needle */}
        <g transform={`rotate(${angle}, 50, 55)`}>
          <line
            x1="50"
            y1="55"
            x2="50"
            y2="20"
            stroke={zoneColor}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </g>
        <circle cx="50" cy="55" r="4" fill={zoneColor} />
      </svg>
      <div
        className="font-mono text-[9px] font-bold uppercase"
        style={{ color: zoneColor }}
      >
        {volatility.lastCandleMovePct.toFixed(1)}%/1m
      </div>
    </div>
  )
}

export default VolatilityGauge
