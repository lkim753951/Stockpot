import { useEffect, useState } from 'react'
import { CaretRight, ClipboardText, Plus, Trash } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { CALL_LANGUAGES, LANGUAGES } from '../../shared/lang'
import { currentLanguage, locale, t, tk, tn } from '../lib/i18n'
import { Dock, Empty, ErrorNote, Loading, Screen, Segment, Sheet } from '../components/ui'

const TYPES = [{ value: 'tick', label: tk('Tick') }, { value: 'temperature', label: tk('Temperature') }, { value: 'stock', label: tk('Stock count') }]
const WEEKS = [{ value: 1, label: tk('First') }, { value: 2, label: tk('Second') }, { value: 3, label: tk('Third') }, { value: 4, label: tk('Fourth') }, { value: -1, label: tk('Last') }]
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 0]
const CHASE_TIMES = [
  { value: -60, label: tk('1 hour before') }, { value: -30, label: tk('30 minutes before') }, { value: 0, label: tk('At the due time') },
  { value: 30, label: tk('30 minutes after') }, { value: 60, label: tk('1 hour after') },
]

const NEW_ITEM = { label: '', type: 'tick', min: '', max: '', unit: '', proof: true, proofHint: '' }
const BLANK = { name: '', schedule: { kind: 'days', days: EVERY_DAY }, dueTime: '11:00', assignee: '', chaseAfter: null, callWho: null, items: [{ ...NEW_ITEM }] }

/** Sunday is 0, and 2 Nov 2026 was a Monday. */
const dayName = (day: number, width: 'short' | 'long' = 'short') => new Date(Date.UTC(2026, 10, 1 + day)).toLocaleDateString(locale(), { weekday: width, timeZone: 'UTC' })

function whenWords(list: any) {
  const { schedule } = list
  if (schedule.kind === 'days') {
    if (schedule.days.length === 7) return t('Every day, by {time}', { time: list.dueTime })
    return t('{days}, by {time}', { days: EVERY_DAY.filter((day) => schedule.days.includes(day)).map((day) => dayName(day)).join(', '), time: list.dueTime })
  }
  const rules = schedule.rules.map((rule: any) => `${t(WEEKS.find((week) => week.value === rule.week)!.label)} ${dayName(rule.day)}`).join(', ')
  return t('{days}, by {time}', { days: rules, time: list.dueTime })
}

function ScheduleEditor({ schedule, onChange }: { schedule: any; onChange: (next: any) => void }) {
  const repeat = schedule.kind === 'monthly' ? 'monthly' : schedule.days.length === 7 ? 'every' : 'some'
  const choose = (next: string) => onChange(next === 'every' ? { kind: 'days', days: EVERY_DAY } : next === 'some' ? { kind: 'days', days: [1, 3] } : { kind: 'monthly', rules: [{ week: 1, day: 3 }] })
  const toggle = (day: number) => onChange({ ...schedule, days: schedule.days.includes(day) ? schedule.days.filter((value: number) => value !== day) : [...schedule.days, day] })
  const rule = (index: number, change: object) => onChange({ ...schedule, rules: schedule.rules.map((row: any, at: number) => (at === index ? { ...row, ...change } : row)) })
  return (
    <div className="stack">
      <Segment label={t('Repeats')} fill value={repeat} onChange={choose} options={[{ value: 'every', label: t('Every day') }, { value: 'some', label: t('Some days') }, { value: 'monthly', label: t('Monthly') }]} />
      {repeat === 'some' ? (
        <div className="day-picks" role="group" aria-label={t('Days')}>
          {EVERY_DAY.map((day) => <button type="button" key={day} aria-pressed={schedule.days.includes(day)} aria-label={dayName(day, 'long')} onClick={() => toggle(day)}>{dayName(day)}</button>)}
        </div>
      ) : null}
      {repeat === 'monthly' ? (
        <>
          <ul className="month-rules">
            {schedule.rules.map((row: any, index: number) => (
              <li key={index}>
                <select aria-label={t('Which week')} value={row.week} onChange={(event) => rule(index, { week: Number(event.target.value) })}>
                  {WEEKS.map((week) => <option key={week.value} value={week.value}>{t(week.label)}</option>)}
                </select>
                <select aria-label={t('Which day')} value={row.day} onChange={(event) => rule(index, { day: Number(event.target.value) })}>
                  {EVERY_DAY.map((day) => <option key={day} value={day}>{dayName(day, 'long')}</option>)}
                </select>
                {schedule.rules.length > 1 ? <button className="icon-btn" type="button" aria-label={t('Remove')} onClick={() => onChange({ ...schedule, rules: schedule.rules.filter((_: any, at: number) => at !== index) })}><Trash size={20} aria-hidden="true" /></button> : <span />}
              </li>
            ))}
          </ul>
          <button className="btn text small" type="button" onClick={() => onChange({ ...schedule, rules: [...schedule.rules, { week: 3, day: 3 }] })}><Plus size={20} aria-hidden="true" />{t('Add another day')}</button>
        </>
      ) : null}
    </div>
  )
}

function ItemEditor({ item, onChange, onRemove }: { item: any; onChange: (change: object) => void; onRemove: () => void }) {
  return (
    <li className="check-editor">
      <div className="row-fill">
        <input aria-label={t('What to check')} placeholder={t('What to check')} value={item.label} onChange={(event) => onChange({ label: event.target.value })} />
        <button className="icon-btn" type="button" aria-label={t('Remove {name}', { name: item.label || t('this check') })} onClick={onRemove}><Trash size={20} aria-hidden="true" /></button>
      </div>
      <label className="field">{t('How')}
        <select value={item.type} onChange={(event) => onChange({ type: event.target.value })}>
          {TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.label)}</option>)}
        </select>
      </label>
      {item.type !== 'tick' ? (
        <div className="two">
          <label className="field">{t('Lowest allowed')}<input inputMode="decimal" className="num" value={item.min ?? ''} onChange={(event) => onChange({ min: event.target.value })} /></label>
          <label className="field">{t('Highest allowed')}<input inputMode="decimal" className="num" value={item.max ?? ''} onChange={(event) => onChange({ max: event.target.value })} /></label>
        </div>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={item.proof} onChange={(event) => onChange({ proof: event.target.checked })} />
        <span>{t('Needs a photo or video')}</span>
      </label>
      {item.proof ? <label className="field">{t('What should it show?')}<input placeholder={t('The fryer is clean and switched off')} value={item.proofHint ?? ''} onChange={(event) => onChange({ proofHint: event.target.value })} /></label> : null}
    </li>
  )
}

export function ChecklistSettings() {
  const [lists, setLists] = useState<any[] | null>(null)
  const [setup, setSetup] = useState<any>(null)
  const [form, setForm] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/setup/checklists').then(setLists).catch((e) => setError(e.message))
  useEffect(() => { void load(); api('/api/setup').then(setSetup).catch(() => undefined) }, [])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(form.id ? `/api/setup/checklists/${form.id}` : '/api/setup/checklists', { method: form.id ? 'PUT' : 'POST', body: { ...form, language: form.language ?? (form.callWho ? currentLanguage() : null) } })
      setForm(null)
      await load()
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const retire = async () => {
    await api(`/api/setup/checklists/${form.id}`, { method: 'DELETE' })
    setForm(null)
    await load()
  }
  const item = (index: number, change: object) => setForm({ ...form, items: form.items.map((row: any, at: number) => (at === index ? { ...row, ...change } : row)) })

  return (
    <Screen title={t('Checklists')} lead={t('Past records stay safe when you change a list.')}>
      {!form ? <ErrorNote message={error} /> : null}
      {!lists && !error ? <Loading /> : null}
      {lists?.length === 0 ? <Empty title={t('No checklists yet.')} /> : null}
      {lists?.length ? (
        <ul className="feature-list">
          {lists.map((list) => (
            <li key={list.id}>
              <button className="feature-row" type="button" onClick={() => setForm({ ...list, assignee: list.assignee ?? '' })}>
                <ClipboardText size={24} aria-hidden="true" />
                <strong>{t(list.name)}</strong>
                <CaretRight className="note" size={20} aria-hidden="true" />
                <small>{whenWords(list)}<br />{list.assignee ?? t('Everyone')}, {tn(list.items.length, '{n} check', '{n} checks')}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dock><button className="btn primary block" type="button" onClick={() => setForm(structuredClone(BLANK))}><Plus size={24} aria-hidden="true" />{t('New checklist')}</button></Dock>
      {form ? (
        <Sheet title={form.id ? t(form.name) : t('New checklist')} onClose={() => { setForm(null); setError(null) }}>
          <label className="field">{t('Name')}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <h3>{t('When')}</h3>
          <ScheduleEditor schedule={form.schedule} onChange={(schedule) => setForm({ ...form, schedule })} />
          <label className="field">{t('Done by')}<input type="time" value={form.dueTime} onChange={(event) => setForm({ ...form, dueTime: event.target.value })} /></label>
          <label className="field">{t('Who does it?')}
            <select value={form.assignee} onChange={(event) => setForm({ ...form, assignee: event.target.value })}>
              <option value="">{t('Everyone')}</option>
              {(setup?.people ?? []).map((person: any) => <option key={person.name} value={person.name}>{person.name}</option>)}
            </select>
          </label>
          <h3>{t('If it is not done')}</h3>
          <label className="check">
            <input type="checkbox" checked={form.chaseAfter !== null} onChange={(event) => setForm({ ...form, chaseAfter: event.target.checked ? 30 : null, callWho: null })} />
            <span>{t('Chase it on WhatsApp')}</span>
          </label>
          {form.chaseAfter !== null ? (
            <>
              <label className="field">{t('When to chase')}
                <select value={form.chaseAfter} onChange={(event) => setForm({ ...form, chaseAfter: Number(event.target.value) })}>
                  {CHASE_TIMES.map(({ value, label }) => <option key={value} value={value}>{t(label)}</option>)}
                  {/* A list saved before these choices keeps its own time until the owner picks another. */}
                  {CHASE_TIMES.some(({ value }) => value === form.chaseAfter) ? null : <option value={form.chaseAfter}>{t('{minutes} minutes after', { minutes: form.chaseAfter })}</option>}
                </select>
              </label>
              <label className="field">{t('Phone call')}
                <select value={form.callWho ?? ''} onChange={(event) => setForm({ ...form, callWho: event.target.value || null })}>
                  <option value="">{t('No call')}</option>
                  <option value="assignee">{t('Call the person doing it')}</option>
                  <option value="owner">{t('Call me')}</option>
                </select>
              </label>
              {form.callWho ? (
                <label className="field">{t('Language')}
                  <select value={form.language ?? currentLanguage()} onChange={(event) => setForm({ ...form, language: event.target.value })}>
                    {LANGUAGES.filter((language) => CALL_LANGUAGES.includes(language.code)).map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
                  </select>
                </label>
              ) : null}
              {form.callWho && setup && !setup.phone ? <p className="notice">{t('Phone calls are not switched on yet, so this will only send WhatsApp messages.')}</p> : null}
            </>
          ) : null}
          <h3>{t('Checks')}</h3>
          <ul className="check-editors">
            {form.items.map((row: any, index: number) => (
              <ItemEditor key={row.id ?? `new-${index}`} item={row} onChange={(change) => item(index, change)} onRemove={() => setForm({ ...form, items: form.items.filter((_: any, at: number) => at !== index) })} />
            ))}
          </ul>
          <button className="btn text small" type="button" onClick={() => setForm({ ...form, items: [...form.items, { ...NEW_ITEM }] })}><Plus size={20} aria-hidden="true" />{t('Add a check')}</button>
          <ErrorNote message={error} />
          <button className="btn primary block" type="button" disabled={busy} onClick={save}>{busy ? t('Saving') : t('Save')}</button>
          {form.id ? <button className="btn text block" type="button" onClick={retire}>{t('Stop using this list')}</button> : null}
        </Sheet>
      ) : null}
    </Screen>
  )
}
