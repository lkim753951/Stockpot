import { t, tk } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { Camera, Check, Copy, EnvelopeSimple, Package, Pause, PhoneCall, Play, Plus, Receipt, Trash, Truck } from '@phosphor-icons/react'
import { dayWords, whenWords } from '../lib/dates'
import { EvidenceSheet } from '../components/Evidence'
import { MediaGrid } from '../components/MediaGrid'
import { evidenceForm } from '../lib/media'
import { api, niceDate, pounds, qty } from '../lib/api'
import { useClip } from '../lib/clip'
import { Chip, Dock, Empty, ErrorNote, Loading, Screen, Sheet } from '../components/ui'

const ISSUES: Record<string, string> = { short: tk('Short'), damaged: tk('Damaged'), wrong: tk('Wrong item'), missing: tk('Missing') }

const today = () => new Date().toISOString().slice(0, 10)

const stateChip = (check: any) => {
  if (check.credit?.status === 'settled') return <Chip tone="good">{t('Settled')}</Chip>
  if (check.problem && !check.owedPence) return <Chip tone="urgent">{t('Problem')}</Chip>
  if (check.state === 'owed') return <Chip tone="urgent">{t('{owedPence} to claim', { owedPence: pounds(check.owedPence) })}</Chip>
  if (check.state === 'clear') return <Chip tone="good">{t('All matches')}</Chip>
  if (check.arrivedAt) return <Chip tone="neutral">{t('Invoice to come')}</Chip>
  if (check.deliveryDate && check.deliveryDate < today()) return <Chip tone="urgent">{t('Late')}</Chip>
  if (check.deliveryDate === today()) return <Chip tone="due">{t('Due today')}</Chip>
  return <Chip tone="neutral">{t('On its way')}</Chip>
}

const groupOf = (check: any) => {
  if (check.credit?.status === 'settled' || check.state === 'clear') return 'done'
  if (check.problem || check.state === 'owed' || (!check.arrivedAt && check.deliveryDate && check.deliveryDate < today())) return 'attention'
  if (!check.arrivedAt && check.deliveryDate === today()) return 'today'
  return check.arrivedAt ? 'attention-soft' : 'coming'
}

const GROUPS = [
  { key: 'attention', title: tk('Needs you') }, { key: 'today', title: tk('Due today') }, { key: 'coming', title: tk('On the way') },
  { key: 'attention-soft', title: tk('Arrived, invoice to come') }, { key: 'done', title: tk('Done') },
]

/** In these groups the heading already says what a chip would. */
const SAYS_ITS_STATE = ['today', 'coming']

/** Where an order has got to, each step with its date, so nobody has to ring round to find out. */
function Timeline({ check }: { check: any }) {
  const steps = [
    { label: t('Ordered'), done: true, when: check.orderedOn ? dayWords(check.orderedOn) : check.orderedAt ? whenWords(check.orderedAt) : null },
    { label: t('Confirmation emailed'), done: !!check.emailedAt, when: check.emailedAt ? whenWords(check.emailedAt) : null },
    { label: t('Arrived'), done: !!check.arrivedAt, when: check.arrivedAt ? whenWords(check.arrivedAt) : t('Due {when}', { when: niceDate(check.deliveryDate) }) },
    { label: t('Invoice matched'), done: !!check.invoice, when: check.invoice?.number ?? null },
    { label: check.state === 'owed' ? t('Money claimed back') : t('All clear'), done: check.state === 'clear' || check.credit?.status === 'settled', when: null },
  ]
  return (
    <ol className="timeline">
      {steps.map((step) => <li key={step.label} data-done={step.done || undefined}><i aria-hidden="true">{step.done ? <Check size={14} weight="bold" /> : null}</i><span>{step.label}</span>{step.when ? <small>{step.when}</small> : null}</li>)}
    </ol>
  )
}

const BLANK_LINE = { name: '', quantity: '', unit: 'kg' }
const NEW_SUPPLIER = 'new'

function AddDelivery({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [form, setForm] = useState({ supplierId: '', orderedOn: today(), deliveryDate: today(), lines: [{ ...BLANK_LINE }] })
  const [fresh, setFresh] = useState({ name: '', phone: '', email: '' })
  const [here, setHere] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/suppliers').then((list) => { setSuppliers(list); setForm((now) => ({ ...now, supplierId: String(list[0]?.id ?? NEW_SUPPLIER) })) }).catch((e) => setError(e.message)) }, [])
  const adding = form.supplierId === NEW_SUPPLIER
  const line = (index: number, change: object) => setForm({ ...form, lines: form.lines.map((row, at) => (at === index ? { ...row, ...change } : row)) })
  const save = async () => {
    setError(null)
    try {
      const { id } = await api('/api/orders', { body: { ...form, ...(adding ? { newSupplier: fresh } : {}) } })
      if (here) window.location.hash = `#/checks/${id}/receive`
      else onDone()
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <Sheet title={t('Add a delivery')} onClose={onClose}>
      <label className="field">{t('Supplier')}
        <select value={form.supplierId} onChange={(event) => setForm({ ...form, supplierId: event.target.value })}>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          <option value={NEW_SUPPLIER}>{t('Add a supplier')}</option>
        </select>
      </label>
      {adding ? (
        <div className="stack inset-fields">
          <label className="field">{t('Name')}<input value={fresh.name} onChange={(event) => setFresh({ ...fresh, name: event.target.value })} /></label>
          <label className="field">{t('Phone')}<input type="tel" value={fresh.phone} onChange={(event) => setFresh({ ...fresh, phone: event.target.value })} /></label>
          <label className="field">{t('Email')}<input type="email" value={fresh.email} onChange={(event) => setFresh({ ...fresh, email: event.target.value })} /></label>
        </div>
      ) : null}
      <div className="date-pair">
        <label className="field">{t('Order date')}<input type="date" value={form.orderedOn} onChange={(event) => setForm({ ...form, orderedOn: event.target.value })} /></label>
        <label className="field">{t('Delivery date')}<input type="date" value={form.deliveryDate} onChange={(event) => setForm({ ...form, deliveryDate: event.target.value })} /></label>
      </div>
      <h3>{t('What is coming?')}</h3>
      <ul className="recipe-lines">
        {form.lines.map((row, index) => (
          <li key={index}>
            <input aria-label={t('Item')} placeholder={t('Item')} value={row.name} onChange={(event) => line(index, { name: event.target.value })} />
            <input aria-label={t('Quantity')} placeholder={t('Qty')} inputMode="decimal" className="num" value={row.quantity} onChange={(event) => line(index, { quantity: event.target.value })} />
            <select aria-label={t('Unit')} value={row.unit} onChange={(event) => line(index, { unit: event.target.value })}>
              {['kg', 'g', 'l', 'ml', 'each'].map((unit) => <option key={unit} value={unit}>{unit === 'each' ? t('each') : unit}</option>)}
            </select>
            <button className="icon-btn" type="button" aria-label={t('Remove')} onClick={() => setForm({ ...form, lines: form.lines.filter((_, at) => at !== index) })}><Trash size={20} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      <button className="btn text small" type="button" onClick={() => setForm({ ...form, lines: [...form.lines, { ...BLANK_LINE }] })}><Plus size={20} aria-hidden="true" />{t('Add an item')}</button>
      <label className="tick-field"><input type="checkbox" checked={here} onChange={(event) => setHere(event.target.checked)} />{t('It has already arrived')}</label>
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" onClick={save}>{t('Save')}</button>
    </Sheet>
  )
}

export function Checks() {
  const [checks, setChecks] = useState<any[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/checks').then(setChecks).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])
  return (
    <Screen title={t('Deliveries')} lead={t('Every order, from the call to the invoice.')}>
      <ErrorNote message={error} />
      {!checks && !error ? <Loading /> : null}
      {checks?.length === 0 ? <Empty title={t('No deliveries yet.')}><p className="muted">{t('They appear here after a call, or you can add one.')}</p></Empty> : null}
      {GROUPS.map((group) => {
        const rows = checks?.filter((check) => groupOf(check) === group.key) ?? []
        if (!rows.length) return null
        return (
          <section className="stack" key={group.key}>
            <h2>{t(group.title)}</h2>
            <ul className="feature-list">
              {rows.map((check) => (
                <li key={check.orderId}>
                  <a className="feature-row delivery-row" href={`#/checks/${check.orderId}`}>
                    <Truck size={24} aria-hidden="true" />
                    <strong>{check.supplier}</strong>
                    {SAYS_ITS_STATE.includes(group.key) ? <span /> : <span className="note">{stateChip(check)}</span>}
                    <small>{check.arrivedAt ? `${t('Arrived {when}', { when: whenWords(check.arrivedAt) })}${check.storedAt ? `, ${t(check.storedAt)}` : ''}` : t('Due {when}', { when: niceDate(check.deliveryDate) })}</small>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <Dock><button className="btn primary block" type="button" onClick={() => setAdding(true)}><Plus size={24} aria-hidden="true" />{t('Add a delivery')}</button></Dock>
      {adding ? <AddDelivery onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load() }} /> : null}
    </Screen>
  )
}

/** What to say on the call: the words are drafted, and every number comes from the check. */
function WhatToSay({ id, onClose }: { id: string; onClose: () => void }) {
  const [words, setWords] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api(`/api/checks/${id}/what-to-say`, { method: 'POST' }).then(setWords).catch((e) => setError(e.message)) }, [id])
  return (
    <Sheet title={t('What to say')} onClose={onClose}>
      <ErrorNote message={error} />
      {!words && !error ? <Loading /> : null}
      {words ? (
        <>
          <ol className="say-list">
            <li><small>{t('Start with')}</small><p>{words.opening}</p></li>
            {words.facts.length ? <li><small>{t('The facts')}</small><ul>{words.facts.map((fact: string) => <li key={fact}>{fact}</li>)}</ul></li> : null}
            <li><small>{t('Ask for')}</small><p>{words.ask}</p></li>
            <li><small>{t('If they push back')}</small><p>{words.pushback}</p></li>
          </ol>
          {words.phone ? <a className="btn primary block" href={`tel:${words.phone.replace(/[^\d+]/g, '')}`}><PhoneCall size={24} aria-hidden="true" />{t('Call {name}', { name: words.contact ?? words.supplier })}</a> : null}
        </>
      ) : null}
    </Sheet>
  )
}

export function CheckDetail({ id, say = false }: { id: string; say?: boolean }) {
  const [sent, setSent] = useState(false)
  const [saying, setSaying] = useState(say)
  const [check, setCheck] = useState<any>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [copied, setCopied] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clip = useClip(check?.callId)

  const load = (value: any) => {
    setCheck(value)
    if (value.credit) { setSubject(value.credit.subject); setBody(value.credit.body) }
  }
  useEffect(() => { api(`/api/checks/${id}`).then(load).catch((e) => setError(e.message)) }, [id])
  if (!check) return <Screen title={t('Delivery')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const act = async (path: string, payload?: unknown) => {
    setError(null)
    try { load(await api(`/api/checks/${id}/${path}`, payload ? { body: payload } : { method: 'POST' })) } catch (problem) { setError((problem as Error).message) }
  }
  const sendGmail = async () => {
    setError(null)
    try {
      await api(`/api/checks/${id}/email`, { method: 'POST' })
      setSent(true)
    } catch (problem) { setError((problem as Error).message) }
  }

  const addMedia = async (file: File) => {
    setPicking(false)
    setError(null)
    try {
      await api(`/api/staff/deliveries/${id}/media`, { form: await evidenceForm(file, { addedBy: t('Owner') }) })
      load(await api(`/api/checks/${id}`))
    } catch (problem) { setError((problem as Error).message) }
  }

  const copy = async () => { await navigator.clipboard.writeText(`${subject}\n\n${body}`); setCopied(true) }
  const proofLines = check.lines.filter((line: any) => line.owedPence > 0 || line.issue)
  const trouble = check.problem || check.state === 'owed'

  return (
    <Screen title={check.supplier} lead={t('Delivery {deliveryDate}', { deliveryDate: niceDate(check.deliveryDate) })}>
      {check.state === 'owed' ? (
        <section className="claim"><strong>{pounds(check.owedPence)}</strong><p>{t('to claim back')}</p></section>
      ) : <div>{stateChip(check)}</div>}

      <div className="actions">
        {trouble ? <button className="btn primary block" type="button" onClick={() => setSaying(true)}><PhoneCall size={24} aria-hidden="true" />{t('What to say')}</button> : null}
        {check.phone ? <a className="btn block" href={`tel:${check.phone.replace(/[^\d+]/g, '')}`}><PhoneCall size={24} aria-hidden="true" />{t('Call {name}', { name: check.supplier })}</a> : <a className="btn block" href="#/settings/suppliers">{t('Add their phone number')}</a>}
      </div>

      {saying ? <WhatToSay id={id} onClose={() => setSaying(false)} /> : null}

      <Timeline check={check} />

      {!check.arrivedAt ? <a className="btn primary block" href={`#/checks/${id}/receive`}><Package size={24} aria-hidden="true" />{t('Check in delivery')}</a> : null}

      {proofLines.length ? (
        <section className="stack">
          <h2>{t('The proof')}</h2>
          {proofLines.map((line: any) => {
            const film = check.media.find((row: any) => row.itemId === line.itemId && row.video)
            return (
              <div className="stack" key={line.itemId}>
                <h3>{line.item}</h3>
                <ol className="proof-trio">
                  {line.evidence ? (
                    <li>
                      <button className="proof-step" type="button" onClick={() => clip.play(line.evidence.turn, line.evidence.startMs, line.evidence.endMs)}>
                        <i>{clip.playing === line.evidence.turn ? <Pause size={22} weight="fill" aria-hidden="true" /> : <Play size={22} weight="fill" aria-hidden="true" />}</i>
                        <span><small>{t('Heard on the call')}</small><q>{line.evidence.text}</q></span>
                      </button>
                    </li>
                  ) : null}
                  <li>
                    <a className="proof-step" href={film ? `/api/staff/delivery-media/${film.video}` : '#'} target={film ? '_blank' : undefined} rel="noreferrer" onClick={(event) => { if (!film) event.preventDefault() }}>
                      <i><Truck size={22} aria-hidden="true" /></i>
                      <span><small>{film ? t('SAM counted {count}', { count: film.counted }) : t('Delivered')}</small><b>{t('{received} of {ordered}', { received: qty(line.received, line.unit), ordered: qty(line.ordered, line.unit) })}</b></span>
                    </a>
                  </li>
                  {line.billed !== null ? (
                    <li>
                      <a className="proof-step" href={check.invoice?.file ? `/api/files/${check.invoice.file}` : '#'} target="_blank" rel="noreferrer">
                        <i><Receipt size={22} aria-hidden="true" /></i>
                        <span><small>{check.invoice?.number ?? t('Invoice')}</small><b>{qty(line.billed, line.unit)} × {pounds(line.billedPence)}</b></span>
                      </a>
                    </li>
                  ) : null}
                  {line.owedPence > 0 ? <li className="proof-owed"><span>{t('to claim back')}</span><strong>{pounds(line.owedPence)}</strong></li> : null}
                </ol>
              </div>
            )
          })}
          <div className="proof">
            {check.deliveryPhoto ? <a href={`/api/files/${check.deliveryPhoto}`} target="_blank" rel="noreferrer"><img src={`/api/files/${check.deliveryPhoto}`} alt={t('Delivery note')} /></a> : null}
            {check.invoice?.file ? <a href={`/api/files/${check.invoice.file}`} target="_blank" rel="noreferrer"><img src={`/api/files/${check.invoice.file}`} alt={t('Invoice')} /></a> : null}
          </div>
        </section>
      ) : null}

      {check.arrivedAt ? (
        <section className="card">
          <div className="section-head"><h2>{t('When it arrived')}</h2><a className="link-btn" href={`#/checks/${id}/receive`}>{t('Change')}</a></div>
          <ul className="list">
            {check.receivedBy ? <li><span>{t('Received by')}</span><strong>{check.receivedBy}</strong></li> : null}
            <li><span>{t('Where it was put')}</span><strong>{check.storedAt ? t(check.storedAt) : t('Not recorded')}</strong></li>
            {check.lines.filter((line: any) => line.issue).map((line: any) => <li key={line.itemId}><span>{line.item}</span><Chip tone="urgent">{t(ISSUES[line.issue])}</Chip></li>)}
          </ul>
          {check.deliveryNote ? <p>{check.deliveryNote}</p> : null}
          {check.issuePhoto ? <img className="evidence" src={`/api/files/${check.issuePhoto}`} alt={t('Photo from staff')} /> : null}
          {check.deliveryPhoto ? <a className="link-btn" href={`/api/files/${check.deliveryPhoto}`}>{t('See the delivery note')}</a> : null}
        </section>
      ) : null}

      <section className="stack">
        <MediaGrid media={check.media} />
        <button className="btn block" type="button" onClick={() => setPicking(true)}><Camera size={24} aria-hidden="true" />{t('Add a photo or video')}</button>
        {picking ? <EvidenceSheet title={t('Add a photo or video')} onFile={addMedia} onClose={() => setPicking(false)} /> : null}
      </section>

      <section className="card">
        <table className="compare">
          <thead><tr><th scope="col">{t('Item')}</th><th scope="col">{t('Agreed on call')}</th><th scope="col">{t('Delivered')}</th><th scope="col">{t('Billed')}</th></tr></thead>
          <tbody>
            {check.lines.map((line: any) => (
              <tr key={line.itemId}>
                <td>{line.item}</td>
                <td>{qty(line.ordered, line.unit)}<br />{pounds(line.agreedPence)}</td>
                <td className={line.shortPence > 0 ? 'bad' : ''}>{qty(line.received, line.unit)}</td>
                <td className={line.owedPence > 0 ? 'bad' : ''}>{line.billed === null ? t('No invoice') : <>{qty(line.billed, line.unit)}<br />{pounds(line.billedPence)}</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {check.unordered.map((line: any) => <p key={line.description}>{t("{description} wasn't on the order: {pence}.", { description: line.description, pence: pounds(line.pence) })}</p>)}
      </section>

      <ErrorNote message={error} />

      {check.state === 'owed' && !check.credit ? (
        <div className="actions"><button className="btn primary block" type="button" onClick={() => act('credit')}>{t('Draft credit request')}</button></div>
      ) : null}

      {check.credit ? (
        <section className="stack">
          <h2>{t('Credit request')}</h2>
          {check.credit.status === 'draft' ? <p className="muted">{t('Nothing is sent until you approve it.')}</p> : <Chip tone={check.credit.status === 'settled' ? 'good' : 'brand'}>{check.credit.status === 'settled' ? t('Settled') : t('Approved')}</Chip>}
          <label className="field">{t('Subject')}<input value={subject} disabled={check.credit.status !== 'draft'} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="field">{t('Message')}<textarea value={body} disabled={check.credit.status !== 'draft'} onChange={(e) => setBody(e.target.value)} /></label>
          <div className="actions">
            {check.credit.status === 'draft' ? <button className="btn primary block" type="button" onClick={() => act('approve', { subject, body })}>{t('Approve request')}</button> : null}
            {check.credit.status === 'approved' ? (
              <>
                {check.gmail ? <button className="btn primary block" type="button" disabled={sent} onClick={sendGmail}><EnvelopeSimple size={24} aria-hidden="true" />{sent ? t('Sent') : t('Send with Gmail')}</button> : null}
                <a className={`btn${check.gmail ? '' : ' primary'} block`} href={`mailto:${check.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}><EnvelopeSimple size={24} aria-hidden="true" />{t('Open in email')}</a>
                <button className="btn block" type="button" onClick={copy}><Copy size={24} aria-hidden="true" />{copied ? t('Copied') : t('Copy')}</button>
                <button className="btn text block" type="button" onClick={() => act('settled')}>{t('Mark as settled')}</button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </Screen>
  )
}
