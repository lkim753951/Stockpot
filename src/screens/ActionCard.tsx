import { t, tk } from '../lib/i18n'
import { DotsThree, PhoneCall } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { api } from '../lib/api'
import { dayWords, inSentence, whenWords } from '../lib/dates'
import { Chip, ErrorNote, Reveal, Sheet } from '../components/ui'

export type Bucket = 'urgent' | 'due' | 'later'

export const PRIORITIES = [{ value: 'now', label: tk('Urgent') }, { value: 'today', label: tk('Today') }, { value: 'soon', label: tk('Later') }]

function PrioritySheet({ action, onClose, onDone }: { action: any; onClose: () => void; onDone: () => void }) {
  const choose = async (urgency: string) => {
    await api(`/api/actions/${action.id}/urgency`, { body: { urgency } })
    onDone()
  }
  return (
    <Sheet title={t('Priority')} onClose={onClose}>
      <p className="muted">{action.title}</p>
      <div className="stack">
        {PRIORITIES.map(({ value, label }) => <button className={`btn block${action.urgency === value ? ' primary' : ''}`} type="button" key={value} onClick={() => choose(value)}>{t(label)}</button>)}
      </div>
    </Sheet>
  )
}

/** The owner's three buckets: urgent and important, important with a date, not important. */
export const bucketOf = (action: any): Bucket => (action.urgency === 'now' ? 'urgent' : action.urgency === 'today' || (action.dueDate && !action.urgencySet) ? 'due' : 'later')

function chipFor(action: any) {
  const bucket = bucketOf(action)
  if (bucket === 'urgent') return <Chip tone="urgent">{t('Urgent')}</Chip>
  if (action.sourceType === 'overdue') return <Chip tone="urgent">{t('Overdue')}</Chip>
  if (bucket === 'due') return <Chip tone="due">{action.dueDate ? t('Due {dueDate}', { dueDate: inSentence(dayWords(action.dueDate)) }) : t('Today')}</Chip>
  return <Chip tone="neutral">{t('Later')}</Chip>
}

const compactDate = (iso: string) => iso.slice(0, 10).replace(/-/g, '')
const nextDay = (iso: string) => new Date(Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)

/** An all-day calendar entry the owner saves in their own Google account. Stockpot holds no sign-in. */
const calendarLink = (action: any) =>
  `https://calendar.google.com/calendar/render?${new URLSearchParams({
    action: 'TEMPLATE', text: action.title, dates: `${compactDate(action.dueDate)}/${compactDate(nextDay(action.dueDate))}`, details: action.detail ?? t('From Stockpot'),
  })}`

/** With WhatsApp not linked, this opens WhatsApp with the words ready, and the owner picks who gets it. */
const shareLink = (action: any) => `https://wa.me/?text=${encodeURIComponent([action.title, action.detail].filter(Boolean).join('\n'))}`

function AssignSheet({ action, onClose, onDone }: { action: any; onClose: () => void; onDone: () => void }) {
  const [people, setPeople] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/team').then((team) => setPeople(team.people.length ? team.people : ['Maria'])).catch((e) => setError(e.message)) }, [])
  const send = async (person: string) => {
    setError(null)
    try {
      await api(`/api/actions/${action.id}/assign`, { body: { person } })
      onDone()
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <Sheet title={t('Assign on WhatsApp')} onClose={onClose}>
      <p>{action.title}</p>
      <div className="stack">
        {people?.map((person) => <button className="btn block" type="button" key={person} onClick={() => send(person)}>{t('Send to {person}', { person })}</button>)}
      </div>
      <ErrorNote message={error} />
    </Sheet>
  )
}

const SWIPE_TO_FINISH = 96

/** New work from a call, a report or a delivery check. Nothing joins the list until the owner says yes. */
function ConfirmCard({ action, onChange }: { action: any; onChange: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (choice: 'confirm' | 'dismiss') => {
    setError(null)
    try {
      await api(`/api/actions/${action.id}/${choice}`, { method: 'POST' })
      setLeaving(true)
      setTimeout(onChange, 220)
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <li>
      <Reveal closed={leaving}>
        <div className="confirm-row">
          <div className="task-text">
            {action.href ? <a href={action.href}>{action.title}</a> : <span>{action.title}</span>}
            {action.detail ? <p className="task-note">{action.detail}</p> : null}
            <small>{action.urgency === 'now' ? <><b>{t('Urgent')}</b>, </> : null}{t('{source}, {when}', { source: action.source, when: whenWords(action.createdAt) })}</small>
          </div>
          <div className="confirm-actions">
            <button className="btn primary small" type="button" onClick={() => decide('confirm')}>{t('Confirm')}</button>
            <button className="btn text small" type="button" onClick={() => decide('dismiss')}>{t('Dismiss')}</button>
            {action.suggested?.href?.startsWith('tel:') ? <a className="btn text small confirm-call" href={action.suggested.href}><PhoneCall size={18} aria-hidden="true" />{action.suggested.label}</a> : null}
          </div>
        </div>
        <ErrorNote message={error} />
      </Reveal>
    </li>
  )
}

/** Sits at the top of Tasks and Home. It takes no room when there's nothing to decide. */
export function ToConfirm({ actions, onChange }: { actions: any[]; onChange: () => void }) {
  if (!actions.length) return null
  return (
    <section className="stack" aria-label={t('To confirm')}>
      <div className="section-head"><h2>{t('To confirm')}</h2></div>
      <ul className="task-sheet">
        {actions.map((action) => <ConfirmCard key={action.id} action={action} onChange={onChange} />)}
      </ul>
    </section>
  )
}

export function ActionCard({ action, lead = false, compact = false, line = false, canSend, onChange }: { action: any; lead?: boolean; compact?: boolean; line?: boolean; canSend: boolean; onChange: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [priority, setPriority] = useState(false)
  const [more, setMore] = useState(false)
  const card = useRef<HTMLElement>(null)
  const start = useRef<number | null>(null)

  const finish = async () => {
    setLeaving(true)
    await api(`/api/actions/${action.id}/done`, { method: 'POST' })
    setTimeout(onChange, 220)
  }
  const snooze = async () => {
    setLeaving(true)
    await api(`/api/actions/${action.id}/snooze`, { method: 'POST' })
    setTimeout(onChange, 220)
  }

  // Done is a swipe to the right. The tick box does the same job for anyone who can't swipe.
  const down = (event: PointerEvent) => { if (action.closable && event.pointerType === 'touch') start.current = event.clientX }
  const move = (event: PointerEvent) => {
    if (start.current === null || !card.current) return
    card.current.style.transform = `translateX(${Math.max(0, event.clientX - start.current)}px)`
  }
  const up = (event: PointerEvent) => {
    if (start.current === null || !card.current) return
    const moved = event.clientX - start.current
    start.current = null
    card.current.style.transform = ''
    if (moved > SWIPE_TO_FINISH) void finish()
  }

  const urgent = bucketOf(action) === 'urgent'
  const title = action.href ? <a className="action-title" href={action.href}>{action.title}</a> : <span className="action-title">{action.title}</span>
  const canAssign = action.closable || action.sourceType === 'reading' || action.sourceType === 'report'
  const meta = action.assignedTo ? t('{source}, assigned to {name}, {when}', { source: action.source, name: action.assignedTo, when: whenWords(action.createdAt) }) : t('{source}, {when}', { source: action.source, when: whenWords(action.createdAt) })
  const tick = action.closable ? <input type="checkbox" className="action-tick" aria-label={t('Mark done: {title}', { title: action.title })} onChange={finish} /> : null
  const swipe = { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up }

  if (line) {
    return (
      <Reveal closed={leaving}>
        <article ref={card} className={`card action line${action.closable ? '' : ' no-tick'}`} {...swipe}>
          {tick}
          <h3>{title}</h3>
          <div className="line-meta">{chipFor(action)}<span className="meta">{whenWords(action.createdAt)}</span></div>
        </article>
      </Reveal>
    )
  }

  return (
    <Reveal closed={leaving}>
    <article ref={card} className={`card action${lead ? ' lead' : ''}${urgent ? ' urgent-card' : ''}${compact ? ' compact' : ''}`} {...swipe}>
      <div className="card-top">{chipFor(action)}<span className="meta">{meta}</span></div>
      <div className={`action-main${action.closable ? '' : ' no-tick'}`}>
        {tick}
        <div>
          <h3>{title}</h3>
          {action.detail ? <p>{action.detail}</p> : null}
        </div>
      </div>
      <div className="card-actions">
        {action.suggested ? <a className={`btn small${lead ? ' primary' : ''}`} href={action.suggested.href}>{action.suggested.label}</a> : null}
        {['problem', 'delivery'].includes(action.sourceType) && action.href ? <a className="btn text small" href={`${action.href}/say`}>{t('What to say')}</a> : null}
        <button className="icon-btn card-more" type="button" aria-label={t('More')} onClick={() => setMore(true)}><DotsThree size={24} weight="bold" aria-hidden="true" /></button>
      </div>
      {more ? (
        <Sheet title={action.title} onClose={() => setMore(false)}>
          <div className="stack">
            <button className="btn block" type="button" onClick={() => { setMore(false); setPriority(true) }}>{t('Priority')}</button>
            <button className="btn block" type="button" onClick={() => { setMore(false); void snooze() }}>{t('Snooze')}</button>
            {canAssign ? (
              canSend
                ? <button className="btn block" type="button" onClick={() => { setMore(false); setAssigning(true) }}>{t('Assign')}</button>
                : <a className="btn block" href={shareLink(action)} target="_blank" rel="noreferrer">{t('Assign')}</a>
            ) : null}
            {action.dueDate && action.sourceType !== 'overdue' ? <a className="btn block" href={calendarLink(action)} target="_blank" rel="noreferrer">{t('Calendar')}</a> : null}
          </div>
        </Sheet>
      ) : null}
      {priority ? <PrioritySheet action={action} onClose={() => setPriority(false)} onDone={() => { setPriority(false); onChange() }} /> : null}
      {assigning ? <AssignSheet action={action} onClose={() => setAssigning(false)} onDone={() => { setAssigning(false); onChange() }} /> : null}
    </article>
    </Reveal>
  )
}
