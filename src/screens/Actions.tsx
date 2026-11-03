import { t, tk } from '../i18n'
import { Plus } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Dock, ErrorNote, Empty, Loading, Screen, Segment, Sheet } from '../ui'
import { ActionCard, bucketOf, ToConfirm, type Bucket } from './ActionCard'

const BUCKETS: Array<{ value: Bucket; label: string; empty: string }> = [
  { value: 'urgent', label: tk('Urgent'), empty: tk('Nothing urgent right now.') },
  { value: 'due', label: tk('Today'), empty: tk('Nothing is due.') },
  { value: 'later', label: tk('Later'), empty: tk('Nothing is waiting here.') },
]

function AddTask({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const today = new Date().toISOString().slice(0, 10)
  const save = async () => {
    setError(null)
    try {
      await api('/api/actions', { body: { title, dueDate, urgency: urgent ? 'now' : !dueDate || dueDate <= today ? 'today' : 'soon' } })
      onDone()
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <Sheet title={t('Add a task')} onClose={onClose}>
      <label className="field">{t('What needs doing?')}<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field">{t('By when?')}<input type="date" min={today} value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
      <label className="check">
        <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
        <span>{t('Urgent')}</span>
      </label>
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" onClick={save}>{t('Save')}</button>
    </Sheet>
  )
}

export function Actions({ sample }: { sample: boolean }) {
  const [adding, setAdding] = useState(false)
  const [data, setData] = useState<any>(null)
  const [bucket, setBucket] = useState<Bucket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/home').then(setData).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  if (!data) return <Screen title={t('Tasks')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const counts = Object.fromEntries(BUCKETS.map(({ value }) => [value, data.actions.filter((action: any) => bucketOf(action) === value).length])) as Record<Bucket, number>
  const shown = bucket ?? BUCKETS.find(({ value }) => counts[value])?.value ?? 'urgent'
  const cards = data.actions.filter((action: any) => bucketOf(action) === shown)

  const undo = async (id: number) => {
    await api(`/api/actions/${id}/done`, { body: { done: false } })
    await load()
  }

  return (
    <Screen title={t('Tasks')} lead={t('{count} open. Checked at {checkedAt}.', { count: data.actions.length, checkedAt: data.checkedAt })}>
      <ToConfirm actions={data.toConfirm} onChange={load} />
      <details className="worked">
        <summary>{t('How this list works')}</summary>
        <p>{t('A task is a one-off job, for you or someone you assign it to. A checklist repeats on a schedule, and staff prove it with a photo.')}</p>
        <p>{t('Stockpot adds tasks from your calls, receipts, checklists and staff reports, and you can add your own.')}</p>
        <p>{t('New tasks from calls, staff reports and delivery problems wait under To confirm until you say yes. Anything about safety skips that and comes straight here.')}</p>
        <ul>
          <li>{t('Urgent: a safety problem, or something that can not wait.')}</li>
          <li>{t('Today: something due today, or money to claim.')}</li>
          <li>{t('Later: everything else.')}</li>
        </ul>
        <p>{t('Use Priority on any card to change it. Stockpot keeps to your choice.')}</p>
      </details>
      <Segment label={t('Show')} fill value={shown} options={BUCKETS.map(({ value, label }) => ({ value, label: `${t(label)} ${counts[value]}` }))} onChange={setBucket} />
      <section className="stack" aria-label={t(BUCKETS.find(({ value }) => value === shown)!.label)}>
        {cards.length
          ? cards.map((action: any, index: number) => <ActionCard key={action.id} action={action} lead={index === 0} canSend={sample || data.teamLinked} onChange={load} />)
          : <Empty title={t(BUCKETS.find(({ value }) => value === shown)!.empty)}><p className="muted">{t('Checked at {checkedAt}.', { checkedAt: data.checkedAt })}</p></Empty>}
      </section>
      {data.doneToday.length ? (
        <section className="stack">
          <h2>{t('Done today')}</h2>
          <ul className="done-list">
            {data.doneToday.map((action: any) => (
              <li key={action.id}>
                <label className="check">
                  <input type="checkbox" checked aria-label={t('Undo: {title}', { title: action.title })} onChange={() => undo(action.id)} />
                  <span>{action.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Dock><button className="btn primary block" type="button" onClick={() => setAdding(true)}><Plus size={24} aria-hidden="true" />{t('Add a task')}</button></Dock>
      {adding ? <AddTask onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load() }} /> : null}
    </Screen>
  )
}
