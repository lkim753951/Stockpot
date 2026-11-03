import { t, tk } from '../lib/i18n'
import { EvidenceSheet } from '../components/Evidence'
import { evidenceForm } from '../lib/media'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { MediaGrid } from '../components/MediaGrid'
import { CountVideo } from '../components/CountVideo'
import { Camera, Minus, Plus, VideoCamera } from '@phosphor-icons/react'
import { api, niceDate } from '../lib/api'
import { Chip, Dock, Empty, ErrorNote, Loading, Screen } from '../components/ui'

const ISSUES = [{ value: 'damaged', label: tk('Damaged') }, { value: 'wrong', label: tk('Wrong item') }, { value: 'missing', label: tk('Missing') }]
const PLACES = [tk('Walk-in fridge'), tk('Freezer'), tk('Dry store'), tk('Kitchen')]
const NAME_KEY = 'stockpot-received-by'
const savedName = () => { try { return localStorage.getItem(NAME_KEY) ?? '' } catch { return '' } }
const saveName = (name: string) => { try { localStorage.setItem(NAME_KEY, name) } catch { /* the name just won't be remembered */ } }
const todayDate = () => new Date().toISOString().slice(0, 10)

export function StaffList() {
  const [orders, setOrders] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/staff/deliveries').then(setOrders).catch((e) => setError(e.message)) }, [])
  return (
    <Screen title={t('Deliveries')}>
      <ErrorNote message={error} />
      {!orders && !error ? <Loading /> : null}
      {orders?.length === 0 ? <Empty title={t('No deliveries due.')} /> : null}
      {orders?.map((order) => (
        <a className="card" key={order.id} href={`#/staff/${order.id}`}>
          <div className="row between"><strong>{order.supplier}</strong><Chip tone={order.status === 'done' ? 'good' : 'due'}>{order.status === 'done' ? t('Checked in') : t('To check in')}</Chip></div>
          <p className="caption">{niceDate(order.deliveryDate)}</p>
        </a>
      ))}
    </Screen>
  )
}

/** Whoever takes the delivery in uses this, owner or staff. */
export function StaffDelivery({ id, sample, owner = false }: { id: string; sample: boolean; owner?: boolean }) {
  const [order, setOrder] = useState<any>(null)
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [issues, setIssues] = useState<Record<number, string>>({})
  const [place, setPlace] = useState('')
  const [note, setNote] = useState('')
  const [receivedBy, setReceivedBy] = useState(savedName)
  const [arrivedOn, setArrivedOn] = useState(todayDate)
  const [media, setMedia] = useState<any[]>([])
  const [counting, setCounting] = useState<any>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = (value: any) => {
    setOrder(value)
    setNotes(value.notes ?? [])
    setCounts(Object.fromEntries(value.lines.map((line: any) => [line.itemId, String(line.received ?? line.expected)])))
    setMedia(value.media ?? [])
    setIssues(Object.fromEntries(value.lines.filter((line: any) => line.issue && line.issue !== 'short').map((line: any) => [line.itemId, line.issue])))
    setPlace(value.storedAt ?? '')
    setNote(value.note ?? '')
    if (value.receivedBy) setReceivedBy(value.receivedBy)
    if (value.arrivedAt) setArrivedOn(value.arrivedAt.slice(0, 10))
    setDone(value.status === 'done')
  }
  useEffect(() => { api(`/api/staff/deliveries/${id}`).then(load).catch((e) => setError(e.message)) }, [id])
  if (!order) return <Screen title={t('Delivery')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const read = async (work: () => Promise<any>) => {
    setBusy(true)
    setError(null)
    try { load(await work()) } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const photo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const form = new FormData()
    form.append('photo', file)
    void read(() => api(`/api/staff/deliveries/${id}/photo`, { form }))
  }
  const bump = (itemId: number, by: number) =>
    setCounts((all) => ({ ...all, [itemId]: String(Math.max(0, Number(all[itemId] || 0) + by)) }))
  const addMedia = async (file: File) => {
    setPicking(false)
    setBusy(true)
    setError(null)
    try {
      const added = await api(`/api/staff/deliveries/${id}/media`, { form: await evidenceForm(file, { addedBy: receivedBy }) })
      setMedia(added.media)
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const finish = () => read(() => {
    saveName(receivedBy)
    return api(`/api/staff/deliveries/${id}/counts`, { body: {
      stored: place, note, receivedBy, arrivedOn,
      lines: order.lines.map((line: any) => ({ itemId: line.itemId, received: Number(counts[line.itemId]), issue: issues[line.itemId] ?? null })),
    } })
  })

  if (done) {
    return (
      <Screen title={t('Delivery checked in')} lead={order.supplier}>
        <Chip tone="good">{t('Owner told')}</Chip>
        {order.storedAt ? <p>{t('Put in: {place}', { place: t(order.storedAt) })}</p> : null}
        <MediaGrid media={media} />
        <button className="btn block" type="button" onClick={() => setDone(false)}>{t('Change')}</button>
        <a className="btn block" href={owner ? `#/checks/${id}` : '#/staff/deliveries'}>{t('Back to deliveries')}</a>
        {sample && !owner ? <a className="btn primary block" href={`#/checks/${id}`}>{t("Go to the owner's view")}</a> : null}
      </Screen>
    )
  }

  return (
    <Screen title={t('Check in delivery')} lead={`${order.supplier}, ${niceDate(order.deliveryDate)}`}>
      <div className="date-pair">
        <label className="field">{t('Arrived on')}<input type="date" value={arrivedOn} max={todayDate()} onChange={(event) => setArrivedOn(event.target.value)} /></label>
        <label className="field">{t('Received by')}<input value={receivedBy} autoComplete="name" onChange={(event) => setReceivedBy(event.target.value)} /></label>
      </div>
      <div className="stack">
        {sample
          ? <button className="btn" type="button" disabled={busy} onClick={() => read(() => api(`/api/staff/deliveries/${id}/sample-photo`, { method: 'POST' }))}><Camera size={24} aria-hidden="true" />{busy ? t('Reading the note') : t('Read the sample delivery note')}</button>
          : <button className="btn" type="button" disabled={busy} onClick={() => input.current?.click()}><Camera size={24} aria-hidden="true" />{busy ? t('Reading the note') : t('Photograph the delivery note')}</button>}
        <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={photo} />
        {notes.map((note) => <p className="notice" key={note}>{t('Note on the paper: {note}', { note })}</p>)}
      </div>
      {order.lines.map((line: any) => (
        <section className="stack" key={line.itemId}>
          <div className="row between"><h2>{line.item}</h2><span className="muted num">{t('Expected {expected} {unit}', { expected: line.expected, unit: line.unit })}</span></div>
          <div className="counter">
            <button className="btn" type="button" aria-label={t('One less {item}', { item: line.item })} onClick={() => bump(line.itemId, -1)}><Minus size={24} aria-hidden="true" /></button>
            <input inputMode="decimal" aria-label={t('{item} received, in {unit}', { item: line.item, unit: line.unit })} value={counts[line.itemId] ?? ''} onChange={(e) => setCounts({ ...counts, [line.itemId]: e.target.value })} />
            <button className="btn" type="button" aria-label={t('One more {item}', { item: line.item })} onClick={() => bump(line.itemId, 1)}><Plus size={24} aria-hidden="true" /></button>
          </div>
          <button className="btn block" type="button" disabled={busy} onClick={() => setCounting(line)}><VideoCamera size={24} aria-hidden="true" />{t('Count on video')}</button>
          <div className="issue-picks" role="group" aria-label={t('Problem with {item}', { item: line.item })}>
            {ISSUES.map((issue) => <button type="button" key={issue.value} aria-pressed={issues[line.itemId] === issue.value} onClick={() => setIssues({ ...issues, [line.itemId]: issues[line.itemId] === issue.value ? '' : issue.value })}>{t(issue.label)}</button>)}
          </div>
          {Number(counts[line.itemId]) < line.expected ? <p className="notice">{t('Short by {count} {unit}. The owner will be told.', { count: Number((line.expected - Number(counts[line.itemId])).toFixed(3)), unit: line.unit === 'each' ? '' : line.unit })}</p> : null}
        </section>
      ))}
      <section className="stack">
        <h2>{t('Where did you put it?')}</h2>
        <div className="issue-picks place-picks" role="group" aria-label={t('Where did you put it?')}>
          {PLACES.map((label) => <button type="button" key={label} aria-pressed={place === label} onClick={() => setPlace(label)}>{t(label)}</button>)}
        </div>
        <label className="field">{t('Or type it')}<input value={PLACES.includes(place) ? '' : place} onChange={(event) => setPlace(event.target.value)} /></label>
      </section>
      <label className="field">{t('Anything else?')}<textarea className="short" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <section className="stack">
        <h2>{t('Photos of the delivery')}</h2>
        <MediaGrid media={media} />
        <button className="btn block" type="button" disabled={busy} onClick={() => setPicking(true)}><Camera size={24} aria-hidden="true" />{t('Add a photo or video')}</button>
        {picking ? <EvidenceSheet title={t('Add a photo or video')} sample={sample} onFile={addMedia} onClose={() => setPicking(false)} /> : null}
      </section>
      {counting ? <CountVideo orderId={id} line={counting} sample={sample} addedBy={receivedBy} onMedia={setMedia} onClose={() => setCounting(null)} onUse={(quantity) => { setCounts({ ...counts, [counting.itemId]: String(quantity) }); setCounting(null) }} /> : null}
      <ErrorNote message={error} />
      <Dock><button className="btn primary block" type="button" disabled={busy} onClick={finish}>{t('Confirm delivery')}</button></Dock>
    </Screen>
  )
}
