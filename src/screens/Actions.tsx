import { t } from '../lib/i18n'
import { Plus } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Dock, ErrorNote, Loading, Screen, Sheet } from '../components/ui'
import { ToConfirm } from './ActionCard'
import { TaskTracker } from '../components/TaskTracker'


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
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/home').then(setData).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  if (!data) return <Screen title={t('Tasks')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const undo = async (id: number) => {
    await api(`/api/actions/${id}/done`, { body: { done: false } })
    await load()
  }

  return (
    <Screen title={t('Tasks')} lead={t('{count} open. Checked at {checkedAt}.', { count: data.actions.length, checkedAt: data.checkedAt })}>
      <ToConfirm actions={data.toConfirm} canSend={sample || data.teamLinked} onChange={load} />
      <TaskTracker data={data} canSend={sample || data.teamLinked} onChange={load} />
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
      <details className="worked">
        <summary>{t('How this list works')}</summary>
        <p>{t('A task is a one-off job, for you or someone you assign it to. A checklist repeats on a schedule, and staff prove it with a photo.')}</p>
        <p>{t('Stockpot adds tasks from your calls, receipts, checklists and staff reports, and you can add your own.')}</p>
        <p>{t('New tasks from calls, staff reports and delivery problems wait under To confirm until you say yes. Anything about safety skips that and comes straight here.')}</p>
        <p>{t('Owner tasks are yours. Staff tasks are grouped by person, with checklists that are not done yet.')}</p>
        <ul>
          <li>{t('Urgent: a safety problem, a late checklist, or something that can not wait.')}</li>
          <li>{t('Due today or tomorrow: something with a date coming up, or money to claim.')}</li>
          <li>{t('Later: everything else.')}</li>
        </ul>
        <p>{t('Use Priority on any card to change it. Stockpot keeps to your choice.')}</p>
      </details>
      <Dock><button className="btn primary block" type="button" onClick={() => setAdding(true)}><Plus size={24} aria-hidden="true" />{t('Add a task')}</button></Dock>
      {adding ? <AddTask onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load() }} /> : null}
    </Screen>
  )
}
