import { useEffect, useState } from 'react'

const QUERY = '(min-width: 1100px)'

/** Широкий экран ПК: список + график рядом, без нижнего шита. */
export function useDesktopLayout(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : false
  )

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const sync = () => setDesktop(mql.matches)
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [])

  return desktop
}
