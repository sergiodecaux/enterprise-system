import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface Props {
  title: string
  subtitle?: string
  /** default collapsed to avoid layout jumps */
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

/**
 * Drawer submenu: collapsed by default so panels (order book, brief, etc.)
 * don't shove the layout when data arrives.
 */
const CollapsibleSection = ({
  title,
  subtitle,
  defaultOpen = false,
  children,
  className = '',
}: Props) => {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div
      className={`overflow-hidden rounded-xl border border-hull-border bg-hull ${className}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-hull-light/40"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-holo/50" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-holo/50" />
        )}
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-holo/80">
          {title}
        </span>
        {subtitle && (
          <span className="ml-auto truncate font-mono text-[10px] text-holo/35">
            {subtitle}
          </span>
        )}
      </button>
      {open ? (
        <div className="space-y-3 border-t border-hull-border/60 p-3">{children}</div>
      ) : (
        <div className="hidden" aria-hidden>
          {children}
        </div>
      )}
    </div>
  )
}

export default CollapsibleSection
