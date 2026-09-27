export function px(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n === 0) return null
  return Number(n.toPrecision(6))
}

export function num(n: number | null | undefined, digits = 1): number | null {
  if (n == null || !Number.isFinite(n)) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function clip(s: string | null | undefined, max: number): string | undefined {
  if (!s) return undefined
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Drops null/undefined/empty values so the JSON stays compact. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => compact(v)).filter((v) => v != null) as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v == null || v === '') continue
      const c = compact(v)
      if (Array.isArray(c) && c.length === 0) continue
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue
      out[k] = c
    }
    return out as T
  }
  return value
}

export function texts(list: Array<string | null | undefined> | null | undefined, n: number, max: number): string[] {
  return (list ?? [])
    .map((s) => clip(s, max))
    .filter((s): s is string => !!s)
    .slice(0, n)
}
