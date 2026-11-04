import { useState } from 'react'
import { CaretDown, CaretUp, ChatTeardropDots, ClipboardText, Package, Thermometer, Tray, Truck, UsersThree, type Icon } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { t, tk, tn } from '../lib/i18n'
import { dayWords } from '../lib/dates'
import { Segment } from './ui'
import { ActionCard } from '../screens/ActionCard'

type Level = 'urgent' | 'soon' | 'later'

/** Red, yellow, then the rest: the three groups the owner reads a tracker in. */
const LEVELS: Array<{ value: Level; label: string }> = [
  { value: 'urgent', label: tk('Urgent') },
  { value: 'soon', label: tk('Due today or tomorrow') },
  { value: 'later', label: tk('Later') },
]

interface Row {
  key: string
  person: string
  level: Level
  title: string
  href: string | null
  meta: string
  when: string
  Mark: Icon
  action?: any
}

/** What kind of job a line is, seen at a glance before reading it. */
const MARKS: Record<string, Icon> = {
  delivery: Truck, problem: Truck, order: Package, check: Package, overdue: ClipboardText, reading: Thermometer, report: ChatTeardropDots,
}

const OWNER = 'Owner'
const EVERYONE = 'Everyone'
const plusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

function actionRow(action: any, tomorrow: string): Row {
  const late = action.sourceType === 'overdue'
  const level: Level = action.urgency === 'now' || late ? 'urgent'
    : action.urgency === 'today' || (action.dueDate && action.dueDate <= tomorrow && !action.urgencySet) ? 'soon' : 'later'
  const when = late ? t('Overdue') : action.dueDate ? dayWords(action.dueDate) : level === 'soon' ? t('Today') : ''
  return { key: `a${action.id}`, person: action.person ?? OWNER, level, title: action.title, href: action.href, meta: action.source, when, Mark: MARKS[action.sourceType] ?? Tray, action }
}

/** A list not done yet. A late one already has a card, so it isn't shown twice. */
function runRow(run: any, tomorrow: string): Row {
  const day = String(run.dueAt).slice(0, 10)
  const level: Level = run.state === 'overdue' ? 'urgent' : day <= tomorrow ? 'soon' : 'later'
  return {
    key: `r${run.id}`, person: run.assignee ?? EVERYONE, level, title: t(String(run.name)), href: `#/run/${run.id}`,
    meta: t('Checklist, {done} of {total} done, due {time}', { done: run.done, total: run.total, time: String(run.dueAt).slice(11, 16) }),
    when: level === 'urgent' ? t('Overdue') : dayWords(day),
    Mark: ClipboardText,
  }
}

/** Each person keeps one colour wherever they appear. */
const toneOf = (name: string) => [...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 5

export function Person({ name }: { name: string }) {
  if (name === EVERYONE) return <span className="task-avatar" aria-hidden="true"><UsersThree size={16} weight="fill" /></span>
  return <span className="task-avatar" data-tone={toneOf(name)} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
}

function TaskLine({ row, canSend, onChange }: { row: Row; canSend: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [gone, setGone] = useState(false)
  const action = row.action
  const finish = async () => {
    setGone(true)
    await api(`/api/actions/${action.id}/done`, { method: 'POST' })
    onChange()
  }
  if (gone) return null
  return (
    <li className={`task-line ${row.level}`}>
      <div className="task-row">
        {action?.closable ? <input type="checkbox" className="task-tick" aria-label={t('Mark done: {title}', { title: row.title })} onChange={finish} /> : <row.Mark className="task-mark" size={20} weight="fill" aria-hidden="true" />}
        <div className="task-text">
          {row.href ? <a href={row.href}>{row.title}</a> : <span>{row.title}</span>}
          <small>{row.meta}</small>
        </div>
        <span className="task-when">{row.when}</span>
        {action ? (
          <button className="icon-btn" type="button" aria-expanded={open} aria-label={t('More for {title}', { title: row.title })} onClick={() => setOpen(!open)}>
            {open ? <CaretUp size={20} aria-hidden="true" /> : <CaretDown size={20} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {open && action ? <div className="task-more"><ActionCard action={action} compact canSend={canSend} onChange={onChange} /></div> : null}
    </li>
  )
}

function Levels({ rows, limit, canSend, onChange }: { rows: Row[]; limit?: number; canSend: boolean; onChange: () => void }) {
  return (
    <>
      {LEVELS.map(({ value, label }) => {
        const shown = rows.filter((row) => row.level === value)
        if (!shown.length) return null
        return (
          <div className={`task-group ${value}`} key={value}>
            <h4>{t(label)}<span className="num">{shown.length}</span></h4>
            <ul className="task-list">
              {shown.slice(0, limit ?? shown.length).map((row) => <TaskLine key={row.key} row={row} canSend={canSend} onChange={onChange} />)}
            </ul>
            {limit && shown.length > limit ? <a className="link-btn" href="#/actions">{t('And {more} more.', { more: shown.length - limit })}</a> : null}
          </div>
        )
      })}
    </>
  )
}

/**
 * Two trackers under one toggle: the owner's own jobs, and each staff member's. Inside each, red for urgent,
 * yellow for due today or tomorrow, then later. Rows are short lines, and the actions open from the arrow.
 */
export function TaskTracker({ data, limit, canSend, onChange }: { data: any; limit?: number; canSend: boolean; onChange: () => void }) {
  const [side, setSide] = useState<'owner' | 'staff'>('owner')
  const tomorrow = plusDays(data.date, 1)
  const lateRuns = new Set(data.actions.filter((action: any) => action.sourceType === 'overdue').map((action: any) => Number(action.href?.split('/').pop())))
  const rows: Row[] = [
    ...data.actions.map((action: any) => actionRow(action, tomorrow)),
    ...(data.runs ?? []).filter((run: any) => !lateRuns.has(Number(run.id))).map((run: any) => runRow(run, tomorrow)),
  ]
  const order = { urgent: 0, soon: 1, later: 2 }
  rows.sort((a, b) => order[a.level] - order[b.level])
  const mine = rows.filter((row) => row.person === OWNER)
  const theirs = rows.filter((row) => row.person !== OWNER)
  const people = [...new Set(theirs.map((row) => row.person))].sort((a, b) => (a === EVERYONE ? 1 : b === EVERYONE ? -1 : a.localeCompare(b)))
  const urgentIn = (list: Row[]) => list.filter((row) => row.level === 'urgent').length

  return (
    <section className="stack tracker" aria-label={t('Tasks')}>
      <Segment label={t('Show')} fill value={side} onChange={setSide} options={[
        { value: 'owner', label: `${t('Owner tasks')} ${mine.length}` },
        { value: 'staff', label: `${t('Staff tasks')} ${theirs.length}` },
      ]} />
      {side === 'owner' ? (
        mine.length ? <div className="task-sheet"><Levels rows={mine} limit={limit} canSend={canSend} onChange={onChange} /></div> : <p className="muted">{t('Nothing for you right now.')}</p>
      ) : people.length ? (
        <div className="task-sheet">
          {people.map((person) => {
            const list = theirs.filter((row) => row.person === person)
            return (
              <div key={person}>
                <div className="task-who">
                  <Person name={person} />
                  <strong>{person === EVERYONE ? t('Everyone') : person}</strong>
                  <span className="meta">{tn(list.length, '{n} task', '{n} tasks')}{urgentIn(list) ? `, ${t('{count} urgent', { count: urgentIn(list) })}` : ''}</span>
                </div>
                <Levels rows={list} limit={limit} canSend={canSend} onChange={onChange} />
              </div>
            )
          })}
        </div>
      ) : <p className="muted">{t('Nothing waiting on staff right now.')}</p>}
    </section>
  )
}
