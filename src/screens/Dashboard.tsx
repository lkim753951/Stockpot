import { locale, t, tn } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { CaretRight, MagnifyingGlass } from '@phosphor-icons/react'
import { setAgentPeriod } from '../Agent'
import { Mascot } from '../Mascot'
import { ReportBody } from './Reports'
import { PeriodPicker, rangeQuery, usePeriod } from '../Period'
import { api, niceDate, pounds, wholePounds } from '../api'
import { Chip, Dock, Empty, ErrorNote, Loading, Screen, Tile, type TileChange } from '../ui'

/** The figure counts to its new value when the dates change, so it reads as the same number moving. */
function Counted({ pence }: { pence: number }) {
  const [shown, setShown] = useState(pence)
  const from = useRef(pence)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setShown(pence)
    const start = performance.now()
    const begin = from.current
    from.current = pence
    let frame = 0
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / 450)
      setShown(begin + (pence - begin) * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [pence])
  return <>{pounds(shown)}</>
}

export function Dashboard() {
  const period = usePeriod('week', true)
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const query = rangeQuery(period.period)

  useEffect(() => {
    if (!data?.running) return
    const timer = setInterval(() => { api(`/api/summary?${query}`).then(setData).catch(() => undefined) }, 1500)
    return () => clearInterval(timer)
  }, [data?.running, query])

  useEffect(() => {
    setAgentPeriod(period.period)
    api(`/api/summary?${query}`).then(setData).catch((e) => setError(e.message))
    return () => setAgentPeriod(undefined)
  }, [query])

  if (!data) return <Screen title={t('Dashboard')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const run = async () => {
    setError(null)
    try { setData(await api('/api/summary/run', { body: { ...period.period, background: true } })) } catch (problem) { setError((problem as Error).message) }
  }

  const { facts, money } = data
  const { report } = data
  const cost = facts.food_cost
  const change = facts.food_cost_change_points
  const before = facts.previous_food_cost.net_sales_pence
  const salesMove = before ? Math.round(((cost.net_sales_pence - before) / before) * 1000) / 10 : null
  const sold = facts.dishes.reduce((sum: number, dish: any) => sum + dish.sold, 0)
  const costChange: TileChange | null = change === null ? null : { text: t('{points} points', { points: Math.abs(change).toFixed(1) }), good: change === 0 ? null : change < 0, up: change === 0 ? null : change > 0, compare: '' }
  const salesChange: TileChange | null = salesMove === null ? null : { text: `${Math.abs(salesMove)}%`, good: salesMove === 0 ? null : salesMove > 0, up: salesMove === 0 ? null : salesMove > 0, compare: '' }
  const saved = money.talkedDownPence + money.foundPence
  const noSales = !cost.net_sales_pence

  return (
    <Screen wide title={t('Dashboard')}>
      <PeriodPicker state={period} />
      <section className="money-hero" aria-label={t('Money saved')}>
        <p className="money-label">{t('Money saved')}</p>
        <p className="money-figure num"><Counted pence={saved} /></p>
        {saved ? null : <p className="money-empty">{t('Savings show up here after a call or a claim.')}</p>}
        <div className="money-split">
          <span><b className="num">{pounds(money.talkedDownPence)}</b> {t('talked down on calls')}</span>
          <span><b className="num">{pounds(money.foundPence)}</b> {t('found on invoices')}</span>
          {money.openPence ? <a href="#/checks"><b className="num">{pounds(money.openPence)}</b> {t('still to get back')}</a> : null}
        </div>
      </section>
      {noSales ? (
        <section className="card">
          <h2>{t('No sales in this period')}</h2>
          <p>{t('Import your sales to see food cost and margins.')}</p>
          <a className="btn block" href="#/settings/sales">{t('Import sales')}</a>
        </section>
      ) : null}
      <div className="split">
        <div className="split-main">
          <section className="stack" aria-label={t('Numbers')}>
            <div className="tiles led">
              <Tile lead label={t('Food cost')} value={cost.food_cost_percent === null ? t('None') : `${cost.food_cost_percent}%`} change={costChange} chip={<Chip tone="brand">{t('Estimated')}</Chip>} />
              <Tile label={t('Sales')} value={wholePounds(cost.net_sales_pence)} change={salesChange} />
              <Tile label={t('Dishes sold')} value={sold.toLocaleString(locale())} />
              <Tile label={t('Deliveries')} href="#/checks" value={String(data.deliveries.count)} note={data.deliveries.problems ? `${t('Needs you')}: ${data.deliveries.problems}` : undefined} />
            </div>
            <p className="caption">{t('Compared with the same length of time before.')}</p>
          </section>

          <section className="stack">
            <div className="section-head">
              <h2>{t('AI analyst')}</h2>
              <button className="btn small" type="button" disabled={data.running} onClick={run}><MagnifyingGlass size={22} aria-hidden="true" />{data.running ? t('Investigating') : report ? t('Run again') : t('Explain this period')}</button>
            </div>
            <ErrorNote message={error} />
            {data.running ? (
              <section className="card analyst-working" aria-live="polite">
                <div className="ask-reply"><Mascot size={40} thinking /><div><strong>{t('Looking through your numbers')}</strong><p className="muted">{t('This can take a minute or two. You can leave this screen and come back.')}</p></div></div>
                {data.progress.length ? <ol className="trail">{data.progress.map((step: string) => <li className="arrive" key={step}>{step}</li>)}</ol> : null}
              </section>
            ) : null}
            {!data.running && data.problem ? <p className="notice">{t('The AI could not finish, so this is the plain version: {problem}', { problem: data.problem })}</p> : null}
            {report ? <ReportBody key={report.id} report={report} /> : data.running ? null : <Empty title={t('Find out why the numbers moved.')}><p className="muted">{t('The analyst looks through the invoices and calls for this period, then tells you what to do.')}</p></Empty>}
            {data.reports.length ? <a className="btn text block" href="#/reports">{tn(data.reports.length, 'See {n} past report', 'See all {n} past reports')}<CaretRight size={20} aria-hidden="true" /></a> : null}
          </section>
        </div>

        <div className="split-side">
          <section className="stack">
            <h2>{t('Dish margins')}</h2>
            {facts.dishes.length ? (
              <table className="compare">
                <thead><tr><th>{t('Dish')}</th><th>{t('Margin')}</th><th>{t('Before')}</th><th>{t('Target')}</th></tr></thead>
                <tbody>
                  {facts.dishes.map((dish: any) => (
                    <tr key={dish.dish}>
                      <td>{dish.dish}<span className="when"><br />{dish.cost_incomplete ? t('{sold} sold, cost incomplete', { sold: dish.sold }) : t('{sold} sold', { sold: dish.sold })}</span></td>
                      <td className={dish.margin_percent < dish.target_margin_percent ? 'bad' : undefined}>{dish.margin_percent}%</td>
                      <td>{dish.previous_margin_percent === null ? t('None') : `${dish.previous_margin_percent}%`}</td>
                      <td>{dish.target_margin_percent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">{t('Add your recipes and sales to see dish margins.')}</p>}
            <p className="caption">{t("Food cost uses saved recipes and the newest price paid each day. Waste, labour and other costs aren't included yet.")}</p>
          </section>

          {money.talkedDown.length || money.priceRises.length ? (
            <details className="worked">
              <summary>{t('Where the money moved')}</summary>
              <ul className="list">
                {money.talkedDown.map((row: any) => <li key={`down${row.item}${row.supplier}`}><span>{row.item}, {row.supplier}</span><span className="num">{pounds(row.offeredPence)} → {pounds(row.agreedPence)}</span></li>)}
                {money.priceRises.map((row: any) => <li key={`up${row.item}${row.supplier}${row.nowPence}`}><span>{row.item}, {row.supplier}</span><span className="num">{pounds(row.beforePence)} → {pounds(row.nowPence)}</span></li>)}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}
