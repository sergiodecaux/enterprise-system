import { useTranslation } from 'react-i18next'

interface ProbabilityGaugeProps {
  value: number
  direction: 'LONG' | 'SHORT' | null
}

const ProbabilityGauge = ({ value, direction }: ProbabilityGaugeProps) => {
  const { t } = useTranslation()

  // SVG dimensions
  const width = 200
  const height = 110
  const centerX = width / 2
  const centerY = height
  const radius = 80
  const strokeWidth = 12

  // Calculate arc properties (semi-circle opening upward)
  // Start from left (180°), end at right (0°), going counter-clockwise
  const startAngle = 180 // Start from left
  const endAngle = 0 // End at right
  const totalAngle = Math.abs(endAngle - startAngle) // 180 degrees

  // Value arc (proportional to value)
  // For semi-circle opening upward, we go from 180° (left) to 0° (right) counter-clockwise
  const valueAngle = (value / 100) * totalAngle
  const valueEndAngle = startAngle - valueAngle // Subtract because we're going counter-clockwise from 180° to 0°

  // Convert angles to radians and calculate arc path
  const toRadians = (angle: number) => (angle * Math.PI) / 180

  const getArcPath = (start: number, end: number) => {
    const startRad = toRadians(start)
    const endRad = toRadians(end)
    const x1 = centerX + radius * Math.cos(startRad)
    const y1 = centerY - radius * Math.sin(startRad)
    const x2 = centerX + radius * Math.cos(endRad)
    const y2 = centerY - radius * Math.sin(endRad)

    const largeArcFlag = end - start > 180 ? 1 : 0

    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`
  }

  // Get color based on value
  const getColor = () => {
    if (value >= 75) return '#00ff41' // matrix
    if (value >= 60) return '#eab308' // yellow-500
    if (value >= 40) return '#f97316' // orange-500
    return '#ff003c' // alert
  }

  const color = getColor()

  // Calculate stroke-dasharray and stroke-dashoffset for animation
  const circumference = Math.PI * radius
  const valueLength = (valueAngle / totalAngle) * circumference
  const dashArray = circumference
  const dashOffset = circumference - valueLength

  // Tick marks positions (0%, 25%, 50%, 75%, 100%)
  const tickAngles = [0, 25, 50, 75, 100].map((p) => startAngle + (p / 100) * totalAngle)

  return (
    <div className="flex flex-col items-center">
      <svg width={width} height={height} className="overflow-visible">
        {/* Background arc */}
        <path
          d={getArcPath(startAngle, endAngle)}
          fill="none"
          stroke="#2a2a2a"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Tick marks */}
        {tickAngles.map((angle, index) => {
          const rad = toRadians(angle)
          const x1 = centerX + radius * Math.cos(rad)
          const y1 = centerY - radius * Math.sin(rad)
          const x2 = centerX + (radius - 8) * Math.cos(rad)
          const y2 = centerY - (radius - 8) * Math.sin(rad)

          return (
            <line
              key={index}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#2a2a2a"
              strokeWidth={2}
            />
          )
        })}

        {/* Value arc */}
        <path
          d={getArcPath(startAngle, valueEndAngle)}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={dashArray}
          className="transition-all duration-1000 ease-out"
          style={{
            strokeDashoffset: dashOffset,
          }}
        />
      </svg>

      {/* Center text */}
      <div className="flex flex-col items-center -mt-16">
        <div className="flex items-baseline gap-1">
          <span
            className="text-3xl font-mono font-bold"
            style={{ color }}
          >
            {Math.round(value)}
          </span>
          <span
            className="text-lg font-mono"
            style={{ color, opacity: 0.6 }}
          >
            %
          </span>
        </div>

        {direction && (
          <div
            className={`mt-2 px-3 py-1 rounded border text-xs font-mono uppercase ${
              direction === 'LONG'
                ? 'bg-matrix/10 text-matrix border-matrix/30'
                : 'bg-alert/10 text-alert border-alert/30'
            }`}
          >
            {direction === 'LONG' ? t('signal_long') : t('signal_short')}
          </div>
        )}
      </div>
    </div>
  )
}

export default ProbabilityGauge
