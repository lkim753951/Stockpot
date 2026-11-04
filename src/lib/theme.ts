import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'stockpot-theme'
const system = () => window.matchMedia('(prefers-color-scheme: dark)')

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch { return null }
}

const show = (theme: Theme) => { document.documentElement.dataset.theme = theme }
const current = (): Theme => saved() ?? (system().matches ? 'dark' : 'light')

/** Runs before the first draw, so the page never flashes the wrong colours. */
export const startTheme = () => show(current())

/** Follows the device until the person picks one, then keeps their pick. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(current)
  useEffect(() => {
    const follow = () => { if (!saved()) { show(current()); setTheme(current()) } }
    const list = system()
    list.addEventListener('change', follow)
    return () => list.removeEventListener('change', follow)
  }, [])
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(KEY, next) } catch { /* private window: it still changes for this visit */ }
    show(next)
    setTheme(next)
  }
  return { theme, toggle }
}
