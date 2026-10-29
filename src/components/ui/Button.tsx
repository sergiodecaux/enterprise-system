import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'long'
  | 'short'

export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-brand text-[#0B0E13] hover:bg-brand-hover active:bg-brand-hover',
  secondary:
    'border border-border bg-bg-elevated text-text-primary hover:border-border-active hover:bg-bg-surface',
  ghost:
    'border border-transparent text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
  danger:
    'border border-market-short/30 bg-market-short/10 text-market-short hover:bg-market-short/15',
  long:
    'border border-market-long/30 bg-market-long/10 text-market-long hover:bg-market-long/15',
  short:
    'border border-market-short/30 bg-market-short/10 text-market-short hover:bg-market-short/15',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-10 px-2 text-[11px] font-mono font-medium desk:h-[26px]',
  md: 'h-10 px-3 text-[13px] font-medium desk:h-8',
  lg: 'h-11 px-4 text-sm font-medium',
  icon: 'h-10 w-10 p-0 desk:h-8 desk:w-8',
}

/**
 * Base action control. On phones every size is at least 40px tall;
 * the compact desktop heights start at the `desk` breakpoint (1100px).
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    className = '',
    type = 'button',
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base',
        'disabled:pointer-events-none disabled:opacity-40',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  )
})

export default Button
