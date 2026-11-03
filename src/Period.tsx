import { useMemo, useState } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { niceDate } from './api'
import { t } from './i18n'
import { Segment } from './ui'

export type PeriodKind = 'week' | 'month' | 'year' | 'custom'
export interface Period { from: string; to: string }

const day = (date: Date) => date.toISOString().slice(0, 10)
const utc = (iso: string) => new Date(`${iso}T12:00:00Z`)

function addDays(iso: string, days: number) {
  const date = utc(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return day(date)
}

function addMonths(iso: string, months: number) {
  const date = utc(iso)
  const target = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(target, last))
  return day(date)
}

/** Each period ends on a day and reaches back from it, so a Monday still shows a full week. */
const startOf = (kind: PeriodKind, end: string) =>
  kind === 'week' ? addDays(end, -6) : kind === 'month' ? addDays(addMonths(end, -1), 1) : addDays(addMonths(end, -12), 1)

/** The dashboard ends yesterday, because today's sales aren't in yet. */
export function usePeriod(kind: PeriodKind = 'week', endsYesterday = false) {
  const latest = useMemo(() => addDays(day(new Date()), endsYesterday ? -1 : 0), [endsYesterday])
  const [state, setState] = useState({ kind, end: latest, from: addDays(latest, -29), to: latest })
  const period: Period = state.kind === 'custom' ? { from: state.from, to: state.to } : { from: startOf(state.kind, state.end), to: state.end }
  const move = (direction: -1 | 1) => setState((now) => {
    const stepped = now.kind === 'week' ? addDays(now.end, 7 * direction) : addMonths(now.end, now.kind === 'month' ? direction : 12 * direction)
    return { ...now, end: stepped > latest ? latest : stepped }
  })
  return {
    period, kind: state.kind, atLatest: state.end >= latest, move,
    choose: (next: PeriodKind) => setState((now) => ({ ...now, kind: next, end: latest })),
    custom: (part: Partial<Period>) => setState((now) => ({ ...now, ...part })),
  }
}

export function PeriodPicker({ state }: { state: ReturnType<typeof usePeriod> }) {
  const { period, kind, atLatest, move, choose, custom } = state
  return (
    <section className="period" aria-label={t('Period')}>
      <Segment label={t('Period')} fill value={kind} onChange={choose} options={[
        { value: 'week', label: t('Week') }, { value: 'month', label: t('Month') }, { value: 'year', label: t('Year') }, { value: 'custom', label: t('Dates') },
      ]} />
      {kind === 'custom' ? (
        <div className="period-dates">
          <label className="field">{t('From')}<input type="date" value={period.from} max={period.to} onChange={(event) => event.target.value && custom({ from: event.target.value })} /></label>
          <label className="field">{t('Until')}<input type="date" value={period.to} min={period.from} onChange={(event) => event.target.value && custom({ to: event.target.value })} /></label>
        </div>
      ) : (
        <div className="period-step">
          <button className="icon-btn" type="button" aria-label={t('Earlier')} onClick={() => move(-1)}><CaretLeft size={22} aria-hidden="true" /></button>
          <span className="num">{t('{from} to {to}', { from: niceDate(period.from), to: niceDate(period.to) })}</span>
          <button className="icon-btn" type="button" aria-label={t('Later')} disabled={atLatest} onClick={() => move(1)}><CaretRight size={22} aria-hidden="true" /></button>
        </div>
      )}
    </section>
  )
}

export const rangeQuery = (period: Period) => `from=${period.from}&to=${period.to}`
