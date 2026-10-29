import type { ReactNode } from 'react'

export type BadgeTone =
  | 'neutral'
  | 'long'
  | 'short'
  | 'warning'
  | 'info'
  | 'purple'
  | 'brand'
  | 'danger'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  /** Small status dot before the label. */
  dot?: boolean
  /** Uppercase is reserved for machine values such as LONG / SHORT / NEW. */
  uppercase?: boolean
  className?: string
  title?: string
}

const toneClasses: Record<BadgeTone, string> = {
  neutral:
    'border-border-subtle bg-white/[0.04] text-text-secondary',
  long: 'border-market-long/20 bg-market-long/10 text-market-long',
  short: 'border-market-short/20 bg-market-short/10 text-market-short',
  warning: 'border-market-warning/25 bg-market-warning/10 text-market-warning',
  info: 'border-market-info/25 bg-market-info/10 text-market-info',
  purple: 'border-market-purple/25 bg-market-purple/10 text-market-purple',
  brand: 'border-brand/25 bg-brand/10 text-brand',
  danger: 'border-market-short/30 bg-market-short/10 text-market-short',
}

const dotClasses: Record<BadgeTone, string> = {
  neutral: 'bg-text-muted',
  long: 'bg-market-long',
  short: 'bg-market-short',
  warning: 'bg-market-warning',
  info: 'bg-market-info',
  purple: 'bg-market-purple',
  brand: 'bg-brand',
  danger: 'bg-market-short',
}

/** One semantic marker. Maximum 2–3 per card. */
const Badge = ({
  tone = 'neutral',
  children,
  dot = false,
  uppercase = false,
  className = '',
  title,
}: BadgeProps) => (
  <span
    title={title}
    className={[
      'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5',
      'font-mono text-[11px] font-medium leading-[14px] tracking-wide',
      uppercase ? 'uppercase' : '',
      toneClasses[tone],
      className,
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {dot && (
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClasses[tone]}`} />
    )}
    {children}
  </span>
)

export default Badge
