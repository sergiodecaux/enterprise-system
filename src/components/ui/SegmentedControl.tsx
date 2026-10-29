import type { ComponentType, ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>
  disabled?: boolean
  title?: string
  /** Optional active tone for semantic controls (LONG / SHORT). */
  tone?: 'neutral' | 'brand' | 'long' | 'short'
}

export interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<SegmentedOption<T>>
  size?: 'sm' | 'md'
  ariaLabel?: string
  className?: string
  /** Stretch options to fill the container evenly. */
  stretch?: boolean
}

const toneClasses = {
  neutral: 'bg-bg-elevated text-text-primary shadow-sm',
  brand: 'bg-brand/[0.12] text-brand shadow-sm',
  long: 'bg-market-long/[0.12] text-market-long shadow-sm',
  short: 'bg-market-short/[0.12] text-market-short shadow-sm',
} as const

/**
 * One visual control for mutually exclusive choices. Replaces rows of
 * equally weighted toggle buttons.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  ariaLabel,
  className = '',
  stretch = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={[
        'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md',
        'border border-border bg-bg-base p-0.5 no-scrollbar',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {options.map((option) => {
        const active = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={[
              'inline-flex items-center justify-center gap-1.5 rounded-[4px]',
              'font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
              'disabled:pointer-events-none disabled:opacity-35',
              size === 'sm'
                ? 'h-10 px-2 text-[11px] desk:h-6'
                : 'h-10 px-2.5 text-[12px] desk:h-7',
              stretch ? 'min-w-0 flex-1 basis-0' : 'shrink-0',
              active
                ? toneClasses[option.tone ?? 'neutral']
                : 'text-text-secondary hover:bg-white/[0.045] hover:text-text-primary',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default SegmentedControl
