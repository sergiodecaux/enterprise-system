/**
 * Single source of truth for the lightweight-charts canvas.
 * The app background and the chart background are intentionally identical:
 * the plot reads as part of the terminal, not an embedded third-party widget.
 */
export const CHART_BG = '#0B0E13'
export const CHART_TEXT = '#94A0B2'
export const CHART_BORDER = '#232A35'
export const CHART_GRID = 'rgba(255, 255, 255, 0.03)'
export const CHART_CROSSHAIR = '#6EA8FE'
export const CHART_LABEL_BG = '#171C24'
export const CHART_UP = '#2DD4BF'
export const CHART_DOWN = '#FB7185'
export const CHART_FONT = 'JetBrains Mono, ui-monospace, monospace'

/** Muted fills for volume and secondary plot marks. */
export const CHART_UP_FILL = 'rgba(45, 212, 191, 0.28)'
export const CHART_DOWN_FILL = 'rgba(251, 113, 133, 0.26)'
export const CHART_PRICE_LINE = 'rgba(148, 160, 178, 0.4)'

export const CHART_LAYOUT = {
  background: { color: CHART_BG },
  textColor: CHART_TEXT,
  fontFamily: CHART_FONT,
} as const

export const CHART_GRID_LINES = {
  vertLines: { color: CHART_GRID },
  horzLines: { color: CHART_GRID },
} as const

export const CHART_CROSSHAIR_LINES = {
  vertLine: {
    color: CHART_CROSSHAIR,
    width: 1 as const,
    style: 3 as const,
    labelBackgroundColor: CHART_LABEL_BG,
  },
  horzLine: {
    color: CHART_CROSSHAIR,
    width: 1 as const,
    style: 3 as const,
    labelBackgroundColor: CHART_LABEL_BG,
  },
} as const

export const CHART_TIME_SCALE = {
  borderColor: CHART_BORDER,
  timeVisible: true,
  secondsVisible: false,
} as const

export const CHART_PRICE_SCALE = {
  borderColor: CHART_BORDER,
} as const
