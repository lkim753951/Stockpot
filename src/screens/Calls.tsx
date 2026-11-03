import { t, tk } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { EnvelopeSimple, PhoneCall, Record, UploadSimple } from '@phosphor-icons/react'
import { OrderEmailSheet } from './OrderEmail'
import { api } from '../api'
import { toCallWav } from '../audioFile'
import { dayWords, inSentence, momentWords, whenWords } from '../dates'
import { Chip, Dock, Empty, ErrorNote, Loading, Screen, Sheet } from '../ui'

const PRIORITY: Record<string, { tone: 'urgent' | 'due' | 'neutral'; word: string }> = {
  urgent: { tone: 'urgent', word: tk('Urgent') },
  not_important: { tone: 'neutral', word: tk('Not important') },
}

function UploadSheet({ sample, onClose, onDone }: { sample: boolean; onClose: () => void; onDone: () => void }) {
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api('/api/suppliers').then((list) => { setSuppliers(list); setSupplierId(list[0]?.id ?? null) }).catch((e) => setError(e.message))
  }, [])

  const send = async () => {
    setError(null)
    try {
      if (sample) {
        setBusy(t('Reading the call'))
        await api('/api/calls/upload-sample', { body: { supplierId } })
      } else {
        setBusy(t('Preparing the recording'))
        const wav = await toCallWav(file!)
        setBusy(t('Sending'))
        const form = new FormData()
        form.append('supplierId', String(supplierId))
        form.append('consent', 'true')
        form.append('audio', wav, 'recording.wav')
        await api('/api/calls/upload', { form })
      }
      onDone()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(null)
    }
  }

  return (
    <Sheet title={t('Upload a recording')} onClose={onClose}>
      <label className="field">{t('Who was the call with?')}
        <select value={supplierId ?? ''} onChange={(event) => setSupplierId(Number(event.target.value))}>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
        </select>
      </label>
      {sample ? <p className="muted">{t('Sample mode uses the sample supplier call.')}</p> : (
        <>
          <button className="btn block" type="button" onClick={() => input.current?.click()}><UploadSimple size={24} aria-hidden="true" />{file ? file.name : t('Choose a recording')}</button>
          <input ref={input} type="file" accept="audio/*,.m4a,.mp3,.wav,.ogg" hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <p className="caption">{t('Up to 30 minutes. It stays on your Stockpot and you can delete it later.')}</p>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>{t('The other person knew this call was being recorded.')}</span>
      </label>
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" disabled={!!busy || !consent || !supplierId || (!sample && !file)} onClick={send}>{busy ?? t('Turn into tasks')}</button>
    </Sheet>
  )
}

export function Calls({ sample }: { sample: boolean }) {
  const [calls, setCalls] = useState<any[] | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/calls').then(setCalls).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  const writing = calls?.some((call) => call.status === 'processing')
  useEffect(() => {
    if (!writing) return
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [writing])

  const retry = async (id: number) => {
    await api(`/api/calls/${id}/retry`, { method: 'POST' }).catch((e) => setError(e.message))
    await load()
  }

  return (
    <Screen title={t('Calls')} lead={t('You phone your supplier as usual, on speaker. Stockpot listens from this device, checks prices and writes it all up.')}>
      <ErrorNote message={error} />
      {!calls && !error ? <Loading /> : null}
      {calls?.length === 0 ? <Empty title={t('No calls yet.')}><p className="muted">{t('Each call becomes a transcript, an order and tasks.')}</p></Empty> : null}
      {calls?.length ? (
        <ul className="feature-list" aria-label={t('Calls')}>
          {calls.map((call) => (
            <li key={call.id}>
              <a className="feature-row call-row" href={`#/calls/${call.id}`}>
                <PhoneCall size={24} aria-hidden="true" />
                <strong>{call.supplier}</strong>
                <span className="when note">{whenWords(call.date)}</span>
                <small>{call.status === 'processing' ? t('Writing up the call') : call.status === 'failed' ? t('Needs a retry') : call.summary ?? t('Stockpot is listening to the recording.')}</small>
              </a>
              {call.status === 'failed' ? <button className="btn small" type="button" onClick={() => retry(call.id)}>{t('Try again')}</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <button className="btn text block" type="button" onClick={() => setUploading(true)}><UploadSimple size={22} aria-hidden="true" />{t('Already have a recording? Upload it')}</button>
      <Dock><a className="btn primary block" href="#/call"><Record size={24} weight="fill" aria-hidden="true" />{t('Record a call')}</a></Dock>
      {uploading ? <UploadSheet sample={sample} onClose={() => setUploading(false)} onDone={() => { setUploading(false); void load() }} /> : null}
    </Screen>
  )
}

export function CallDetail({ id }: { id: string }) {
  const [call, setCall] = useState<any>(null)
  const [emailing, setEmailing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => api(`/api/calls/${id}`).then(setCall).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [id])
  useEffect(() => {
    if (call?.status !== 'processing') return
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [call?.status])
  if (!call) return <Screen title={t('Call')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const tick = async (task: any) => {
    await api(`/api/tasks/${task.id}/done`, { body: { done: !task.done } })
    await load()
  }
  const speaker = (turn: any) => (turn.role === 'supplier' ? call.supplier : turn.role === 'owner' ? t('You') : t('Speaker {speaker}', { speaker: turn.speaker ?? '' }))

  return (
    <Screen title={call.supplier} lead={momentWords(call.date)}>
      <ErrorNote message={error} />
      {call.status === 'processing' ? <Chip tone="neutral">{t('Writing up the call')}</Chip> : null}
      {call.summary ? <section className="card"><h2>{t('Summary')}</h2><p>{call.summary}</p></section> : null}
      {call.tasks.length ? (
        <section className="stack">
          <h2>{t('Tasks')}</h2>
          <ul className="done-list">
            {call.tasks.map((task: any) => (
              <li key={task.id}>
                <label className="check">
                  <input type="checkbox" checked={task.done} onChange={() => tick(task)} />
                  <span>
                    {task.title}
                    {task.dueDate ? <span className="when">{' '}{t('Due {dueDate}', { dueDate: inSentence(dayWords(task.dueDate)) })}</span> : null}
                    {PRIORITY[task.urgency] ? <><br /><Chip tone={PRIORITY[task.urgency].tone}>{t(PRIORITY[task.urgency].word)}</Chip></> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {call.orderId ? (
        <div className="actions">
          <a className="btn primary block" href={`#/order/${call.orderId}`}>{call.orderStatus === 'draft' ? t('Check the order') : t('Open the order')}</a>
          {call.orderStatus === 'confirmed' ? <button className="btn block" type="button" onClick={() => setEmailing(true)}><EnvelopeSimple size={24} aria-hidden="true" />{t('Email the confirmation')}</button> : null}
        </div>
      ) : null}
      {call.turns.length ? (
        <section className="stack">
          <h2>{t('Transcript')}</h2>
          <ol className="transcript">
            {call.turns.map((turn: any) => <li key={turn.turn}><strong>{speaker(turn)}</strong><span>{turn.text}</span></li>)}
          </ol>
        </section>
      ) : null}
      {call.hasAudio ? <audio controls preload="none" src={`/api/calls/${call.id}/audio`} aria-label={t('Play the recording')} /> : null}
      {emailing ? <OrderEmailSheet orderId={call.orderId} onClose={() => setEmailing(false)} /> : null}
    </Screen>
  )
}
