import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, CaretRight, Plus } from '@phosphor-icons/react'
import { api, niceDate, wholePounds } from '../api'
import { t } from '../i18n'
import { whenWords } from '../dates'
import { Chip, Empty, ErrorNote, Loading, Screen, Tile } from '../ui'

/** Written by the AI analyst, with the numbers kept as they were on the day it was written. */
export function ReportBody({ report, onAdded }: { report: any; onAdded?: (index: number) => void }) {
  const [added, setAdded] = useState<number[]>([])
  const add = async (index: number) => {
    await api(`/api/summary/${report.id}/actions/${index}`, { method: 'POST' })
    setAdded((list) => [...list, index])
    onAdded?.(index)
  }
  return (
    <>
      <section className="card">
        <h2>{report.headline}</h2>
        <p>{report.summary}</p>
        {report.cause ? <p><strong>{t('Why:')}{' '}</strong>{report.cause}</p> : null}
        {report.wordsFrom === 'template' ? <p className="notice">{t("This is the plain version, written from the numbers. The AI summary wasn't used, so try again.")}</p> : null}
      </section>
      <section className="stack">
        <h2>{t('What you could do')}</h2>
        <ul className="list">
          {report.actions.map((action: any, index: number) => (
            <li key={action.title}>
              <span><strong>{action.title}</strong><span className="when"><br />{action.why}</span></span>
              {added.includes(index) ? <Chip tone="good">{t('Added to your list')}</Chip> : <button className="icon-btn add-btn" type="button" aria-label={t('Add to my list')} onClick={() => add(index)}><Plus size={22} aria-hidden="true" /></button>}
            </li>
          ))}
        </ul>
      </section>
      {report.sources.length ? (
        <section className="stack">
          <h2>{t('Where this came from')}</h2>
          <ul className="list">
            {report.sources.map((source: any) => (
              <li key={source.id}><span>{source.href ? <a href={source.href}>{source.title}</a> : source.title}<span className="when"><br />{source.detail}</span></span></li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.steps.length ? (
        <details className="worked">
          <summary>{t('How it was checked')}</summary>
          <ol className="trail">{report.steps.map((step: string) => <li key={step}>{step}</li>)}</ol>
        </details>
      ) : null}
    </>
  )
}

const rangeWords = (row: any) => t('{from} to {to}', { from: niceDate(row.weekStart), to: niceDate(row.weekEnd) })

export function Reports() {
  const [reports, setReports] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/summary').then((data) => setReports(data.reports)).catch((e) => setError(e.message)) }, [])
  return (
    <Screen title={t('Reports')} lead={t('Every report the AI analyst has written. The numbers stay as they were that day.')}>
      <ErrorNote message={error} />
      {!reports && !error ? <Loading /> : null}
      {reports?.length === 0 ? <Empty title={t('No reports yet.')}><p className="muted">{t('Open the Dashboard and ask the analyst to explain a period.')}</p></Empty> : null}
      {reports?.length ? (
        <ul className="report-list">
          {reports.map((row) => (
            <li key={row.id}>
              <a href={`#/reports/${row.id}`}>
                <span className="report-when">{rangeWords(row)}</span>
                <CaretRight size={20} aria-hidden="true" />
                <strong>{row.headline}</strong>
                <span className="report-figures num">
                  {row.foodCost === null ? null : (
                    <span>{t('Food cost')} <b>{row.foodCost}%</b>{row.change ? <i className={row.change > 0 ? 'worse' : 'better'}>{row.change > 0 ? <ArrowUp size={14} weight="bold" aria-hidden="true" /> : <ArrowDown size={14} weight="bold" aria-hidden="true" />}{Math.abs(row.change)}</i> : null}</span>
                  )}
                  <span>{t('Sales')} <b>{wholePounds(row.salesPence)}</b></span>
                  {row.owedPence ? <span>{t('To claim')} <b>{wholePounds(row.owedPence)}</b></span> : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </Screen>
  )
}

export function ReportDetail({ id }: { id: string }) {
  const [report, setReport] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api(`/api/summary/${id}`).then(setReport).catch((e) => setError(e.message)) }, [id])
  if (!report) return <Screen title={t('Report')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>
  const { facts } = report
  return (
    <Screen title={rangeWords(report)} lead={t('Written {when}', { when: whenWords(report.createdAt) })}>
      <div className="tiles three">
        <Tile label={t('Food cost')} value={facts.food_cost.food_cost_percent === null ? t('None') : `${facts.food_cost.food_cost_percent}%`} />
        <Tile label={t('Sales')} value={wholePounds(facts.food_cost.net_sales_pence)} />
        <Tile label={t('To claim')} value={wholePounds(facts.money_owed_pence)} />
      </div>
      <ReportBody report={report} />
      <a className="btn text block" href="#/reports">{t('All reports')}</a>
    </Screen>
  )
}
