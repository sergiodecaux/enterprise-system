import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Max height of the sheet. Defaults to 90dvh. */
  className?: string
}

/**
 * Telegram Mini App / Android bottom sheet. Same content as the desktop
 * modal, but with a drag handle, safe-area padding and 40px targets.
 */
const Sheet = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className = '',
}: SheetProps) => {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    window.setTimeout(() => panelRef.current?.focus(), 0)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[300]">
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={[
          'animate-sheet-in absolute inset-x-0 bottom-0 flex max-h-[90dvh] flex-col',
          'overflow-hidden rounded-t-xl border-t border-border bg-bg-panel shadow-modal',
          'focus:outline-none',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex shrink-0 flex-col items-center pt-2">
          <span className="h-1 w-10 rounded-full bg-bg-surface" aria-hidden />
        </div>

        <div className="flex shrink-0 items-start justify-between gap-4 px-4 pb-3 pt-2">
          <div className="min-w-0">
            {title && (
              <h2
                id={titleId}
                className="font-sans text-[15px] font-semibold leading-5 text-text-primary"
              >
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 font-sans text-[12px] leading-4 text-text-secondary">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="-mr-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {children}
        </div>

        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-panel/95 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export default Sheet
