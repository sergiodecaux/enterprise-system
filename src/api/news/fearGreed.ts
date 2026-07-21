import type { FearGreedData, FearGreedLabel } from '../../engine/sentiment/types'

function getBase(): string {
  return (import.meta.env.VITE_MEXC_PROXY_URL as string | undefined) ?? ''
}

interface FGResponse {
  data: Array<{
    value: string
    value_classification: string
    timestamp: string
  }>
}

export async function fetchFearGreed(): Promise<FearGreedData> {
  const base = getBase()
  const url = `${base}/news/fg/fng/?limit=2`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`FearGreed: ${res.status}`)

  const data = (await res.json()) as FGResponse
  const current = data.data[0]
  const previous = data.data[1]

  return {
    value: parseInt(current.value, 10),
    label: current.value_classification as FearGreedLabel,
    timestamp: parseInt(current.timestamp, 10),
    previousValue: previous ? parseInt(previous.value, 10) : null,
  }
}

export function fearGreedToBoost(value: number): number {
  if (value <= 25) return -0.5
  if (value <= 45) return -0.25
  if (value <= 55) return 0
  if (value <= 75) return 0.25
  return 0.5
}
