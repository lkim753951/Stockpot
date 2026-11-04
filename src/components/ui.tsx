import { t } from '../lib/i18n'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, ChartLineUp, ChatTeardropDots, CheckCircle, CircleDashed, ClipboardText, Clock, PauseCircle, PencilSimple, PhoneCall,
  PlugsConnected, Receipt, Scales, ShoppingCart, Siren, Tray, Truck, WarningCircle, X, XCircle, type Icon,
} from '@phosphor-icons/react'

const CHIP_ICONS = {
  good: CheckCircle, attention: WarningCircle, broken: XCircle, paused: PauseCircle, off: CircleDashed,
  urgent: Siren, due: Clock, neutral: Tray, brand: PencilSimple, plain: null,
}

export type ChipTone = keyof typeof CHIP_ICONS

/** Colour never carries a status alone, so a status chip is always an icon and a word. Plain is for counts, which aren't a status. */
export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  const Icon = CHIP_ICONS[tone]
  return <span className={`chip ${tone}`}>{Icon ? <Icon size={16} aria-hidden="true" /> : null}{children}</span>
}

/** The light and dark versions are both on the page, and the stylesheet shows the one that suits the chosen colours. */
export function Brand({ kind = 'logo', width, height }: { kind?: 'logo' | 'mark'; width: number; height: number }) {
  return (
    <span className="brand">
      <img className="on-light" src={`/brand/stockpot-${kind}.svg`} alt="Stockpot" width={width} height={height} />
      <img className="on-dark" src={`/brand/stockpot-${kind}-reversed.svg`} alt="" width={width} height={height} />
    </span>
  )
}

/** One fixed icon for each feature, used everywhere that feature appears. */
export const FEATURE_ICONS: Record<string, Icon> = {
  receipts: Receipt, calls: PhoneCall, checklists: ClipboardText, reports: ChatTeardropDots, deliveries: Truck, crisis: Siren,
  analyst: ChartLineUp, connections: PlugsConnected, checks: Scales, shopping: ShoppingCart,
}

/** Closes its height along with the fade, so the things below move up instead of jumping. */
export function Reveal({ closed, children }: { closed: boolean; children: ReactNode }) {
  return <div className="reveal" data-closed={closed || undefined}><div>{children}</div></div>
}

export function Sk({ width, height = 16 }: { width: number | string; height?: number }) {
  return <i className="sk" aria-hidden="true" style={{ width, height }} />
}

export function Loading() {
  return <div className="stack" aria-label={t('Loading')}><div className="skeleton" /><div className="skeleton" /></div>
}

export function ErrorNote({ message }: { message: string | null }) {
  return message ? <p className="error" role="alert">{message}</p> : null
}

export function Segment<T extends string>({ label, value, options, onChange, fill = false }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; fill?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; width: number } | null>(null)
  const labels = options.map((option) => option.label).join('|')
  useLayoutEffect(() => {
    const place = () => {
      const on = root.current?.querySelector<HTMLElement>('[aria-pressed="true"]')
      if (on) setPill({ x: on.offsetLeft, width: on.offsetWidth })
    }
    place()
    window.addEventListener('resize', place)
    void document.fonts?.ready.then(place)
    return () => window.removeEventListener('resize', place)
  }, [value, labels])
  return (
    <div ref={root} className={`segment${fill ? ' fill' : ''}`} role="group" aria-label={label}>
      {pill ? <i className="segment-pill" aria-hidden="true" style={{ transform: `translateX(${pill.x}px)`, width: pill.width }} /> : null}
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  )
}

export function Screen({ title, lead, children, wide = false }: { title: ReactNode; lead?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <main className={`screen${wide ? ' wide' : ''}`}>
      <div className="screen-head">
        <h1>{title}</h1>
        {lead ? <p className="muted">{lead}</p> : null}
      </div>
      {children}
    </main>
  )
}

/** The screen's main action, pinned above the bottom bar so a thumb can reach it. */
export function Dock({ children, pair = false }: { children: ReactNode; pair?: boolean }) {
  return <div className={`dock${pair ? ' pair' : ''}`}>{children}</div>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>
}

export function useWide(width = 720) {
  const query = `(min-width: ${width}px)`
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const update = () => setWide(list.matches)
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return wide
}

/** A bottom sheet. The native dialog gives focus handling, Escape and a backdrop for free. */
export function Sheet({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
      // Focus sits on the sheet itself, so the close button doesn't open with a ring round it.
      element.focus()
    }
  }, [])
  return (
    <dialog ref={dialog} className={`sheet-dialog ${className}`} aria-label={title} tabIndex={-1} onClose={onClose}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" type="button" aria-label={t('Close')} onClick={onClose}><X size={22} aria-hidden="true" /></button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

export interface TileChange { text: string; good: boolean | null; up: boolean | null; compare: string }

/** Coloured by whether the move is good for the business, never by the arrow's direction. */
export function Tile({ label, value, change, chip, note, href, lead = false }: { label: string; value: string; change?: TileChange | null; chip?: ReactNode; note?: string; href?: string; lead?: boolean }) {
  const moved = change ? (
    <span className={`tile-change ${change.good === null ? 'even' : change.good ? 'better' : 'worse'}`}>
      {change.up === null ? null : change.up ? <ArrowUp size={16} weight="bold" aria-hidden="true" /> : <ArrowDown size={16} weight="bold" aria-hidden="true" />}
      {change.text} <span className="tile-compare">{change.compare}</span>
    </span>
  ) : null
  const body = lead ? (
    <>
      <span className="tile-top"><span className="tile-label">{label}</span>{chip}</span>
      <span className="tile-figure"><span className="tile-value">{value}</span>{moved}</span>
    </>
  ) : (
    <>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {moved}
      {note ? <span className="tile-change even"><span className="tile-compare">{note}</span></span> : null}
      {chip}
    </>
  )
  const name = `tile${lead ? ' lead' : ''}`
  return href ? <a className={name} href={href}>{body}</a> : <div className={name}>{body}</div>
}
