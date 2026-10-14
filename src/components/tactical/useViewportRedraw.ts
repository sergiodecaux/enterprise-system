/**
 * Coalesce chart viewport redraws to one rAF per frame.
 * Skips work while the user is panning/zooming when `interactingRef` is set.
 */

import { useEffect, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'

export type ViewportRedrawOpts = {
  /** When true, skip redraw while interactingRef.current is true */
  interactingRef?: React.MutableRefObject<boolean>
  /** Subscribe to crosshair moves (default false — pan must stay smooth) */
  crosshair?: boolean
  /** Trailing redraw after interaction ends (ms). 0 = off */
  trailingMs?: number
}

/**
 * Calls `redraw` on visible-range / resize (and optional crosshair),
 * coalesced to a single requestAnimationFrame.
 */
export function useViewportRedraw(
  chart: IChartApi | null,
  container: HTMLElement | null | undefined,
  redraw: () => void,
  opts: ViewportRedrawOpts = {}
): void {
  const { interactingRef, crosshair = false, trailingMs = 120 } = opts
  const redrawRef = useRef(redraw)
  redrawRef.current = redraw

  useEffect(() => {
    if (!chart || !container) return

    let raf = 0
    let trailing: ReturnType<typeof setTimeout> | null = null

    const run = () => {
      raf = 0
      if (interactingRef?.current) {
        if (trailingMs > 0) {
          if (trailing) clearTimeout(trailing)
          trailing = setTimeout(() => {
            trailing = null
            if (!interactingRef.current) redrawRef.current()
          }, trailingMs)
        }
        return
      }
      redrawRef.current()
    }

    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(run)
    }

    const timeScale = chart.timeScale()
    timeScale.subscribeVisibleLogicalRangeChange(schedule)
    if (crosshair) chart.subscribeCrosshairMove(schedule)

    const ro = new ResizeObserver(schedule)
    ro.observe(container)

    schedule()

    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (trailing) clearTimeout(trailing)
      try {
        timeScale.unsubscribeVisibleLogicalRangeChange(schedule)
      } catch {
        /* ignore */
      }
      if (crosshair) {
        try {
          chart.unsubscribeCrosshairMove(schedule)
        } catch {
          /* ignore */
        }
      }
      ro.disconnect()
    }
  }, [chart, container, interactingRef, crosshair, trailingMs])
}
