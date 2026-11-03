import { locale, t } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { CheckCircle, Circle, ClipboardText, Clock, Microphone, PhoneCall, Receipt, UsersThree } from '@phosphor-icons/react'
import { api, wholePounds } from '../lib/api'
import { longToday } from '../lib/dates'
import { Chip, Empty, ErrorNote, Sk, Tile, type TileChange } from '../components/ui'
import { ActionCard, ToConfirm } from './ActionCard'

const percentChange = (value: number | null): TileChange | null =>
  value === null ? null : { text: `${Math.abs(value)}%`, good: value === 0 ? null : value > 0, up: value === 0 ? null : value > 0, compare: '' }

/** The screen's own shape in quiet blocks, so nothing jumps when the numbers land. */
function HomeLoading() {
  return (
    <main className="screen wide" aria-label={t('Loading')}>
      <div className="screen-head sk-group"><Sk width={160} /><Sk width={300} height={32} /></div>
      <div className="split">
        <div className="split-main">
          <div className="sk-card"><Sk width={84} height={30} /><Sk width="70%" height={24} /><Sk width="90%" /><Sk width="100%" height={48} /></div>
          <div className="sk-card"><Sk width="60%" height={20} /></div>
        </div>
        <div className="split-side"><div className="sk-card"><Sk width={100} /><Sk width={120} height={40} /></div></div>
      </div>
    </main>
  )
}

export function FeatureDot({ state }: { state: string }) {
  return <i className={`dot ${state === 'idle' ? '' : state}`} aria-hidden="true" />
}

export function Home({ sample, onClock }: { sample: boolean; onClock: () => void }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/home').then(setData).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  if (error) return <main className="screen"><h1>{t('Home')}</h1><ErrorNote message={error} /></main>
  if (!data) return <HomeLoading />

  const jump = async () => {
    await api('/api/sample/clock', { body: { time: '22:30' } })
    onClock()
    await load()
  }

  const { tiles, actions, features, status, checkedAt } = data
  const top = actions.slice(0, 3)
  const setupLeft = sample ? [] : data.setup.steps.filter((step: any) => !step.done)
  const food = tiles.foodCost
  const foodChange: TileChange | null = food.change === null ? null : {
    text: t('{points} points', { points: Math.abs(food.change).toFixed(1) }), good: food.change === 0 ? null : food.change < 0, up: food.change === 0 ? null : food.change > 0, compare: '',
  }

  return (
    <main className="screen wide">
      <div className="screen-head">
        <p className="today-date">{longToday()}</p>
        <h1>{status}</h1>
      </div>

      {setupLeft.length ? (
        <section className="card setup">
          <h2>{t('Set up your restaurant')}</h2>
          {data.setup.sampleData ? <p className="muted">{t('This is sample data for now. You can clear it in Settings.')}</p> : null}
          <ul className="setup-steps">
            {data.setup.steps.map((step: any) => (
              <li key={step.key}>
                <a href={step.href} data-done={step.done || undefined}>
                  {step.done ? <CheckCircle size={22} weight="fill" aria-hidden="true" /> : <Circle size={22} aria-hidden="true" />}{step.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="split">
        <div className="split-main">
          <ToConfirm actions={data.toConfirm} onChange={load} />
          <section className="stack" aria-label={t('Needs you')}>
            <div className="section-head">
              <h2>{t('Needs you')}</h2>
              {actions.length ? <a className="link-btn" href="#/actions">{t('See all {count}', { count: actions.length })}</a> : null}
            </div>
            {top.length ? top.map((action: any, index: number) => <ActionCard key={action.id} action={action} lead={index === 0} compact line={index > 0} canSend={sample || data.teamLinked} onChange={load} />) : (
              <Empty title={t('All clear.')}>
                <p className="muted">{t('Checked at {checkedAt}.', { checkedAt })}</p>
                {sample ? <p>{t('The day has just started. Switch to Staff and say a fridge reading, and it lands here.')}</p> : null}
                {sample ? <a className="btn small" href="#/staff"><Microphone size={22} aria-hidden="true" />{t('Go to staff checks')}</a> : null}
              </Empty>
            )}
          </section>

          <nav className="quick" aria-label={t('Quick actions')}>
            <a className="quick-item" href="#/call"><span className="quick-icon"><PhoneCall size={24} aria-hidden="true" /></span>{t('Record a call')}</a>
            <a className="quick-item" href="#/receipts"><span className="quick-icon"><Receipt size={24} aria-hidden="true" /></span>{t('Add receipts')}</a>
            <a className="quick-item" href="#/settings/team"><span className="quick-icon"><UsersThree size={24} aria-hidden="true" /></span>{t('Team')}</a>
            <a className="quick-item" href="#/checklists"><span className="quick-icon"><ClipboardText size={24} aria-hidden="true" /></span>{t('Checklists')}</a>
          </nav>
        </div>

        <div className="split-side">
          <section className="stack" aria-label={t('Last 7 days')}>
            <div className="section-head"><h2>{t('Last 7 days')}</h2></div>
            <div className="tiles led">
              <Tile lead label={t('Food cost')} href="#/dashboard" value={food.percent === null ? t('None') : `${food.percent}%`} change={foodChange} chip={<Chip tone="brand">{t('Estimated')}</Chip>} />
              <Tile label={t('Sales')} href="#/dashboard" value={wholePounds(tiles.sales.pence)} change={percentChange(tiles.sales.change)} />
              <Tile label={t('Dishes sold')} href="#/dashboard" value={tiles.dishes.sold.toLocaleString(locale())} change={percentChange(tiles.dishes.change)} />
              <Tile label={t('Stock alerts')} href="#/checklists" value={String(tiles.stock.open)} note={tiles.stock.open ? t('Open') : t('None low')} />
            </div>
            <p className="caption">{t('Compared with the 7 days before. Updated at {checkedAt}.', { checkedAt })}</p>
          </section>
        </div>
      </div>

      {sample ? <button className="btn text" type="button" onClick={jump}><Clock size={24} aria-hidden="true" />{t('Demo: jump to 22:30')}</button> : null}
    </main>
  )
}
