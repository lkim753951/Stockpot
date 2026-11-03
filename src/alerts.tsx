import { t } from './i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { WarningOctagon, X } from '@phosphor-icons/react'
import { api } from './api'

export interface AlertItem { id: number; title: string; detail: string | null; href: string | null }

export const alertsSupported = () => 'Notification' in window

export const alertPermission = () => (alertsSupported() ? Notification.permission : 'denied')

function chime() {
  try {
    const context = new AudioContext()
    const tone = context.createOscillator()
    const gain = context.createGain()
    tone.frequency.value = 880
    gain.gain.setValueAtTime(0.12, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.5)
    tone.connect(gain).connect(context.destination)
    tone.start()
    tone.stop(context.currentTime + 0.5)
  } catch { /* sound is a bonus */ }
}

/** Watches for new urgent items. Works while Stockpot is open, on any tab of the browser. */
export function useAlerts(enabled: boolean) {
  const [count, setCount] = useState(0)
  const [toasts, setToasts] = useState<AlertItem[]>([])
  const known = useRef<Set<number> | null>(null)

  const check = useCallback(async () => {
    const { urgent } = await api<{ urgent: AlertItem[] }>('/api/alerts')
    // The badge counts urgent items only. Everything else waits calmly in Actions.
    setCount(urgent.length)
    // Anything already open at sign-in is on the list, so only later items alert.
    const fresh = known.current ? urgent.filter((item) => !known.current!.has(item.id)) : []
    known.current = new Set([...(known.current ?? []), ...urgent.map((item) => item.id)])
    if (!fresh.length) return
    chime()
    setToasts((list) => [...fresh, ...list].slice(0, 2))
    // A banner tells, then gets out of the way. The item stays on Today.
    for (const item of fresh) setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== item.id)), 7000)
    if (alertPermission() === 'granted') {
      for (const item of fresh) new Notification(item.title, { body: item.detail ?? undefined, tag: `stockpot-${item.id}`, icon: '/brand/stockpot-mark.svg' })
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const run = () => { check().catch(() => undefined) }
    run()
    const timer = setInterval(run, 8000)
    window.addEventListener('hashchange', run)
    return () => { clearInterval(timer); window.removeEventListener('hashchange', run) }
  }, [enabled, check])

  return { count, toasts, dismiss: (id: number) => setToasts((list) => list.filter((item) => item.id !== id)) }
}

export function AlertToasts({ toasts, onClose }: { toasts: AlertItem[]; onClose: (id: number) => void }) {
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="assertive">
      {toasts.map((toast) => (
        <div className="toast" key={toast.id}>
          <WarningOctagon size={22} weight="fill" aria-hidden="true" />
          <a href={toast.href ?? '#/home'} onClick={() => onClose(toast.id)}><strong>{toast.title}</strong>{toast.detail ? <span>{toast.detail}</span> : null}</a>
          <button type="button" aria-label={t('Dismiss')} onClick={() => onClose(toast.id)}><X size={18} aria-hidden="true" /></button>
        </div>
      ))}
    </div>
  )
}
