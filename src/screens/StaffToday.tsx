import { t, tn } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { ChatCircleText, Package, Siren, Truck } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { atWords, inSentence, longToday } from '../lib/dates'
import { Chip, Empty, ErrorNote, Loading, Screen } from '../components/ui'

function RunState({ run }: { run: any }) {
  if (run.state === 'done') return <Chip tone="good">{t('Done')}</Chip>
  if (run.state === 'overdue') return <Chip tone="due">{t('Overdue')}</Chip>
  return <Chip tone="plain">{t('{done} of {total}', { done: run.done, total: run.total })}</Chip>
}

export function StaffToday() {
  const [runs, setRuns] = useState<any[] | null>(null)
  const [deliveries, setDeliveries] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api('/api/staff/runs').then(setRuns).catch((e) => setError(e.message))
    api('/api/staff/deliveries').then((orders) => setDeliveries(orders.filter((order: any) => order.status !== 'done').length)).catch(() => undefined)
  }, [])

  const open = runs?.filter((run) => run.state !== 'done') ?? []
  const stock = runs?.find((run) => /stock/i.test(run.name))
  return (
    <Screen title={t('Today')} lead={runs ? `${longToday()}. ${open.length ? tn(open.length, '{n} list to finish.', '{n} lists to finish.') : t('All done for now.')}` : longToday()}>
      <ErrorNote message={error} />
      {!runs && !error ? <Loading /> : null}
      {runs?.length === 0 ? <Empty title={t('Nothing to do yet.')} /> : null}
      {runs?.length ? (
        <ul className="feature-list" aria-label={t('Checks')}>
          {runs.map((run) => (
            <li key={run.id}>
              <a className="staff-run" href={`#/staff/run/${run.id}`}>
                <span>
                  <strong>{t(run.name)}</strong>
                  <span className="when">{t('Due {dueAt}', { dueAt: inSentence(atWords(run.dueAt)) })}</span>
                </span>
                <RunState run={run} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <section className="staff-tiles" aria-label={t('Also today')}>
        <a className="tile-btn" href="#/staff/deliveries"><Truck size={32} aria-hidden="true" />{t('Delivery{v}', { v: deliveries ? ` (${deliveries})` : '' })}</a>
        <a className="tile-btn" href={stock ? `#/staff/run/${stock.id}` : '#/staff'}><Package size={32} aria-hidden="true" />{t('Stock count')}</a>
        <a className="tile-btn" href="#/staff/report"><ChatCircleText size={32} aria-hidden="true" />{t('Report')}</a>
      </section>
      <a className="tile-btn danger" href="#/staff/crisis" style={{ minHeight: 64, flexDirection: 'row' }}><Siren size={28} aria-hidden="true" />{t('Something is wrong')}</a>
    </Screen>
  )
}
