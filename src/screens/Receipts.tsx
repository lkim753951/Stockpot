import { t, tn } from '../lib/i18n'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Camera, DownloadSimple, FileText, ImageSquare, Scales, UploadSimple, WarningCircle } from '@phosphor-icons/react'
import { PeriodPicker, rangeQuery, usePeriod } from '../components/Period'
import { api, pounds } from '../lib/api'
import { dayWords } from '../lib/dates'
import { Chip, Dock, Empty, ErrorNote, Screen, Sk, useWide } from '../components/ui'

function ReceiptCard({ invoice, order }: { invoice: any; order: number }) {
  if (invoice.status === 'reading') {
    return (
      <article className="card" aria-busy="true">
        <div className="receipt-head"><strong>{invoice.name}</strong><span className="when">{t('Reading')}</span></div>
        <div className="sk-group"><Sk width="80%" /><Sk width="60%" /><Sk width="70%" /></div>
      </article>
    )
  }
  return (
    <article className="card arrive" style={{ ['--i' as string]: order }}>
      <div className="receipt-head">
        <div>
          <strong>{invoice.supplier ?? invoice.name}</strong>
          <p className="when">{invoice.status === 'reading' ? t('Reading') : dayWords(invoice.date)}{invoice.number ? `, ${invoice.number}` : ''}{invoice.source === 'gmail' ? `, ${t('from Gmail')}` : ''}</p>
        </div>
        {invoice.grossPence !== null ? <strong className="num">{pounds(invoice.grossPence)}</strong> : null}
      </div>
      {invoice.lines.length ? (
        <ul className="receipt-lines">
          {invoice.lines.map((line: any, index: number) => (
            <li key={`${invoice.id}-${index}`}>
              <span>{line.description}<span className="when"><br />{line.quantity} {line.unit}</span></span>
              <span className="num">{pounds(line.totalPence)}</span>
              {line.issue ? <span className="flag"><WarningCircle size={18} aria-hidden="true" />{line.issue}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {invoice.issues.map((issue: string) => <p className="notice" key={issue}>{issue}</p>)}
      {invoice.file ? <a className="link-btn" href={`/api/files/${invoice.file}`}><ImageSquare size={20} aria-hidden="true" />{t('See the photo')}</a> : null}
    </article>
  )
}

/** What the invoices alone show, so a pile of old ones is useful on day one. */
function PriceCheck({ period, refresh }: { period: any; refresh: number }) {
  const [found, setFound] = useState<any>(null)
  useEffect(() => { api(`/api/invoices/price-check?${rangeQuery(period)}`).then(setFound).catch(() => setFound(null)) }, [period, refresh])
  if (!found || (!found.extraPence && !found.twice.length)) return null
  return (
    <section className="money-hero price-check">
      <div>
        <p className="money-label">{t('Paid above the first price')}</p>
        <p className="money-figure num">{pounds(found.extraPence)}</p>
        <p className="money-empty">{t('Invoices checked: {count}', { count: found.invoices })}</p>
      </div>
      <ul className="price-rises">
        {found.items.map((row: any) => (
          <li key={`${row.supplier}-${row.item}`}><span>{row.item}<small>{row.supplier}: {pounds(row.firstPence)} → {pounds(row.lastPence)}</small></span><strong className="num">{pounds(row.extraPence)}</strong></li>
        ))}
        {found.twice.map((row: any) => <li key={`${row.supplier}-${row.number}-${row.date}`}><span>{t('May be billed twice')}<small>{row.supplier}{row.number ? `, ${row.number}` : ''}</small></span><strong className="num">{pounds(row.pence)}</strong></li>)}
      </ul>
    </section>
  )
}

function ReceiptTable({ rows, reading }: { rows: any[]; reading: number }) {
  return (
    <div className="sheet-wrap" tabIndex={0} role="region" aria-label={t('Receipt rows')}>
      <table className="sheet">
        <thead><tr><th>{t('Date')}</th><th>{t('Supplier')}</th><th>{t('Item')}</th><th>{t('Qty')}</th><th>{t('Unit')}</th><th>{t('Cost')}</th><th>{t('Photo')}</th></tr></thead>
        <tbody>
          {Array.from({ length: reading }, (_, index) => (
            <tr key={index} aria-hidden="true">{[64, 120, 160, 24, 24, 48, 24].map((width, cell) => <td key={cell}><Sk width={width} /></td>)}</tr>
          ))}
          {rows.map((row, index) => (
            <tr key={row.key} className={`arrive${row.issue ? ' flagged' : ''}`} style={{ ['--i' as string]: Math.min(index, 8) }}>
              <td className="nowrap">{dayWords(row.invoice.date)}</td>
              <td>{row.invoice.supplier ?? row.invoice.name}</td>
              <td>{row.description}{row.issue ? <span className="caption"><br />{row.issue}</span> : null}</td>
              <td>{row.quantity}</td>
              <td>{row.unit}</td>
              <td>{pounds(row.totalPence)}</td>
              <td><a href={`/api/files/${row.invoice.file}`} aria-label={t('Photo of {number}', { number: row.invoice.number ?? t('this receipt') })}><ImageSquare size={22} aria-hidden="true" /></a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Receipts({ sample }: { sample: boolean }) {
  const [invoices, setInvoices] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const wide = useWide()
  const period = usePeriod('month')
  const [sort, setSort] = useState('date-desc')
  const query = `${rangeQuery(period.period)}&sort=${sort.split('-')[0]}&direction=${sort.split('-')[1]}`

  const load = () => api(`/api/invoices?${query}`).then(setInvoices).catch((e) => setError(e.message))
  useEffect(() => {
    void load()
    const refresh = () => { void load() }
    window.addEventListener('stockpot-receipts', refresh)
    return () => window.removeEventListener('stockpot-receipts', refresh)
  }, [query])
  const reading = invoices.filter((invoice) => invoice.status === 'reading').length
  useEffect(() => {
    if (!reading) return
    const timer = setInterval(load, 800)
    return () => clearInterval(timer)
  }, [reading, query])

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length) return
    setError(null)
    const form = new FormData()
    files.forEach((file) => form.append('files', file))
    try {
      await api('/api/invoices', { form })
      await load()
    } catch (problem) {
      setError((problem as Error).message)
    }
  }

  const usePile = async () => {
    setError(null)
    await api('/api/invoices/sample-pile', { method: 'POST' })
    await load()
  }

  const rows = invoices.flatMap((invoice) => invoice.lines.map((line: any, index: number) => ({ ...line, invoice, key: `${invoice.id}-${index}` })))
  const unsure = rows.filter((row) => row.issue).length

  const total = invoices.reduce((sum, invoice) => sum + (invoice.grossPence ?? 0), 0)

  return (
    <Screen wide={wide} title={t('Receipts')} lead={t('Photos and PDFs become rows you can check and export.')}>
      <ErrorNote message={error} />
      <PeriodPicker state={period} />
      <PriceCheck period={period.period} refresh={invoices.length} />
      <div className="receipt-bar">
        <p><strong className="num">{pounds(total)}</strong> <span className="muted">{tn(invoices.length, '{n} receipt', '{n} receipts')}</span></p>
        <label className="sort">{t('Sort')}
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="date-desc">{t('Newest first')}</option>
            <option value="date-asc">{t('Oldest first')}</option>
            <option value="amount-desc">{t('Highest amount')}</option>
            <option value="amount-asc">{t('Lowest amount')}</option>
            <option value="supplier-asc">{t('Supplier A to Z')}</option>
          </select>
        </label>
      </div>
      {invoices.length ? (
        <>
          <div className="row between">
            {unsure ? <Chip tone="attention">{tn(unsure, '{n} line to check', '{n} lines to check')}</Chip> : <Chip tone="good">{t('All lines add up')}</Chip>}
            <a className="btn text small" href={`/api/invoices.csv?${rangeQuery(period.period)}`}><DownloadSimple size={22} aria-hidden="true" />{t('Export this period')}</a>
          </div>
          {wide ? <ReceiptTable rows={rows} reading={reading} /> : <section className="stack" aria-label={t('Receipts')}>{invoices.map((invoice, index) => <ReceiptCard key={invoice.id} invoice={invoice} order={Math.min(index, 6)} />)}</section>}
          <a className="btn text block" href="#/checks"><Scales size={24} aria-hidden="true" />{t('See deliveries and money to claim')}</a>
        </>
      ) : <Empty title={t('No receipts in this period.')}><p className="muted">{t('Take a photo or upload a file, and it shows up here line by line.')}</p></Empty>}

      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden onChange={upload} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={upload} />
      {sample ? (
        <Dock><button className="btn primary block" type="button" disabled={reading > 0} onClick={usePile}><FileText size={24} aria-hidden="true" />{reading ? t('Reading {reading}', { reading }) : t('Read the sample pile')}</button></Dock>
      ) : (
        <Dock pair>
          <button className="btn primary block" type="button" onClick={() => camera.current?.click()}><Camera size={24} aria-hidden="true" />{reading ? t('Reading {reading}', { reading }) : t('Take a photo')}</button>
          <button className="btn block" type="button" onClick={() => input.current?.click()}><UploadSimple size={24} aria-hidden="true" />{t('Upload files')}</button>
        </Dock>
      )}
    </Screen>
  )
}
