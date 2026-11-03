import { TrackedVideo } from '../components/Tracked'
import { locale, t, tk } from '../lib/i18n'
import { EvidenceSheet } from '../components/Evidence'
import { evidenceForm } from '../lib/media'
import { useEffect, useRef, useState } from 'react'
import { Camera, CaretLeft, CaretRight, Check, CheckCircle, Microphone, PaperPlaneRight, Plus, Stop, WarningCircle, WhatsappLogo } from '@phosphor-icons/react'
import { api, niceDate } from '../lib/api'
import { atWords, clockWords, inSentence, momentWords } from '../lib/dates'
import { useRecorder } from '../lib/recorder'
import { Chip, Dock, Empty, ErrorNote, Loading, Screen, Segment } from '../components/ui'

const dueWords = (dueAt: string) => t('Due {when}', { when: inSentence(atWords(dueAt)) })

function RunChip({ state, done, total }: { state: string; done?: number; total?: number }) {
  if (state === 'done') return <Chip tone="good">{t('Done')}</Chip>
  if (state === 'overdue') return <Chip tone="urgent">{t('Overdue')}</Chip>
  return <Chip tone="plain">{done !== undefined ? t('{done} of {total}', { done, total }) : t('To do')}</Chip>
}

const byWhom = (entry: any) => (!entry.by ? '' : entry.source === 'whatsapp' ? t(' by {name} on WhatsApp', { name: entry.by }) : t(' by {name}', { name: entry.by }))

const SAMPLE_REPLIES = ['Fridge one 4', 'Fridge two 9', 'yes', 'no', 'done']

/** Sample mode only. Each reply takes the same path as a real WhatsApp message. */
function TryReply({ onSent }: { onSent: (team: any) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (body: object) => {
    setBusy(true)
    try { onSent(await api('/api/sample/whatsapp', { body })) } finally { setBusy(false); setText('') }
  }
  return (
    <section className="card">
      <h2>{t('Try a reply from Maria')}</h2>
      <p className="muted">{t("Send a checklist above first. WhatsApp isn't linked in sample mode, so this stands in for her phone.")}</p>
      <div className="ask-chips">
        {SAMPLE_REPLIES.map((reply) => <button key={reply} type="button" disabled={busy} onClick={() => send({ text: reply })}>{reply}</button>)}
        <button type="button" disabled={busy} onClick={() => send({ voice: true })}>{t('Voice note in Polish')}</button>
        <button type="button" disabled={busy} onClick={() => send({ photo: true })}>{t('Thermometer photo')}</button>
      </div>
      <form className="ask-form" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void send({ text }) }}>
        <input aria-label={t('Reply as Maria')} placeholder={t('Or type what Maria says')} value={text} onChange={(event) => setText(event.target.value)} />
        <button className="btn" type="submit" disabled={busy || !text.trim()} aria-label={t('Send')}><PaperPlaneRight size={22} aria-hidden="true" /></button>
      </form>
    </section>
  )
}

function Thread({ messages }: { messages: any[] }) {
  if (!messages.length) return <Empty title={t('No messages yet.')}><p className="muted">{t('Send a checklist and every reply shows up here.')}</p></Empty>
  return (
    <ol className="thread" aria-label={t('Team messages')}>
      {[...messages].reverse().map((message) => (
        <li className={`bubble ${message.direction} arrive`} key={message.id}>
          <span>{message.body ?? (message.kind === 'photo' ? t('Sent a photo.') : message.kind === 'voice' ? t('Sent a voice note.') : t('Sent a message.'))}</span>
          {message.status === 'failed' ? <Chip tone="broken">{t('Not delivered')}</Chip> : null}
          {message.detail ? <span className="caption">{message.detail}</span> : null}
          <span className="caption">{message.direction === 'in' ? message.contact : t('To {contact}', { contact: message.contact })}, {clockWords(message.at)}{message.status === 'simulated' ? t(', simulated') : ''}{message.kind === 'voice' ? t(', voice note') : ''}{message.kind === 'buttons' ? t(', with Save and Change buttons') : ''}</span>
        </li>
      ))}
    </ol>
  )
}

/** The owner's view: what's due, what went out on WhatsApp and what came back. */
export function OwnerChecklists({ sample }: { sample: boolean }) {
  const [team, setTeam] = useState<any>(null)
  const [sending, setSending] = useState<number | null>(null)
  const [view, setView] = useState('today')
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/team').then(setTeam).catch((e) => setError(e.message))
  useEffect(() => {
    void load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  if (!team) return <Screen title={t('Checklists')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const send = async (id: number) => {
    setSending(id)
    setError(null)
    try {
      const result = await api(`/api/team/send/${id}`, { method: 'POST' })
      if (!result.ok) setError(result.detail ?? t("That didn't send."))
      await load()
    } catch (problem) { setError((problem as Error).message) } finally { setSending(null) }
  }

  const open = team.runs.filter((run: any) => run.state !== 'done').length
  const people = [...new Set<string>(team.runs.map((run: any) => run.assignee ?? ''))].sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1))
  const line = (run: any) => (
    <li className="run-line" key={run.id}>
      <a href={`#/run/${run.id}`}>{t(run.name)}</a>
      <RunChip state={run.state} done={run.done} total={run.total} />
      <span className="when">{dueWords(run.dueAt)}{run.flagged ? t(', {flagged} flagged', { flagged: run.flagged }) : ''}</span>
      {run.state === 'done' ? <span /> : run.sentAt
        ? <span className="when">{t('Sent {sentAt}', { sentAt: clockWords(run.sentAt) })}</span>
        : <button className="btn text small" type="button" disabled={sending === run.id || (!team.connected && !sample)} onClick={() => send(run.id)} aria-label={t('Send {name} on WhatsApp', { name: t(run.name) })}><WhatsappLogo size={20} aria-hidden="true" />{sending === run.id ? t('Sending') : t('Send')}</button>}
    </li>
  )

  return (
    <Screen wide title={t('Checklists')} lead={open ? t('{open} to finish.', { open }) : t('All done for now.')}>
      <Segment label={t('View')} fill value={view} onChange={setView} options={[{ value: 'today', label: t('Today') }, { value: 'month', label: t('Calendar') }, { value: 'messages', label: t('Messages') }]} />
      <ErrorNote message={error} />
      {view === 'today' ? (
        <>
          {people.map((person) => {
            const runs = team.runs.filter((run: any) => (run.assignee ?? '') === person)
            const done = runs.reduce((sum: number, run: any) => sum + run.done, 0)
            const total = runs.reduce((sum: number, run: any) => sum + run.total, 0)
            return (
              <section className="stack" key={person || 'everyone'}>
                <div className="person-head">
                  <h2>{person || t('Everyone')}</h2>
                  <span className="num when">{t('{done} of {total}', { done, total })}</span>
                  <i className="person-meter" aria-hidden="true"><b style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></i>
                </div>
                <ul className="feature-list">{runs.map(line)}</ul>
              </section>
            )
          })}
        </>
      ) : null}
      {view === 'month' ? <MonthCalendar /> : null}
      {view === 'messages' ? (
        <div className="split">
          <div className="split-main"><Thread messages={team.messages} /></div>
          {sample ? <div className="split-side"><TryReply onSent={(next) => setTeam({ ...team, ...next })} /></div> : null}
        </div>
      ) : null}
      <Dock><a className="btn primary block" href="#/settings/checklists"><Plus size={24} aria-hidden="true" />{t('Create or change checklists')}</a></Dock>
    </Screen>
  )
}

const STATE_WORD: Record<string, string> = { done: tk('Done'), overdue: tk('Overdue'), due: tk('To do'), planned: tk('Planned') }

function MonthCalendar() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [days, setDays] = useState<any[] | null>(null)
  const [chosen, setChosen] = useState(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api(`/api/checklists/calendar?month=${month}`).then(setDays).catch((e) => setError(e.message)) }, [month])

  const shift = (by: number) => {
    const date = new Date(`${month}-15T12:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() + by)
    setMonth(date.toISOString().slice(0, 7))
  }
  const first = new Date(`${month}-01T12:00:00Z`)
  const lead = (first.getUTCDay() + 6) % 7
  const headers = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 10, 2 + index)).toLocaleDateString(locale(), { weekday: 'narrow', timeZone: 'UTC' }))
  const today = new Date().toISOString().slice(0, 10)
  const picked = days?.find((day) => day.date === chosen)

  return (
    <section className="stack" aria-label={t('Calendar')}>
      <div className="period-step">
        <button className="icon-btn" type="button" aria-label={t('Earlier')} onClick={() => shift(-1)}><CaretLeft size={22} aria-hidden="true" /></button>
        <strong>{first.toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong>
        <button className="icon-btn" type="button" aria-label={t('Later')} onClick={() => shift(1)}><CaretRight size={22} aria-hidden="true" /></button>
      </div>
      <ErrorNote message={error} />
      {days ? (
        <div className="month">
          {headers.map((name, index) => <span className="month-head" key={index} aria-hidden="true">{name}</span>)}
          {Array.from({ length: lead }, (_, index) => <span key={`gap-${index}`} />)}
          {days.map((day) => {
            const late = day.items.filter((item: any) => item.state === 'overdue').length
            const finished = day.items.length > 0 && day.items.every((item: any) => item.state === 'done')
            return (
              <button className="month-day" type="button" key={day.date} aria-pressed={day.date === chosen} data-today={day.date === today || undefined}
                aria-label={t('{date}: {count} checklists', { date: niceDate(day.date), count: day.items.length })} onClick={() => setChosen(day.date)}>
                <span className="num">{Number(day.date.slice(8))}</span>
                {late ? <i className="late"><WarningCircle size={14} weight="fill" aria-hidden="true" /></i> : finished ? <i className="done"><CheckCircle size={14} weight="fill" aria-hidden="true" /></i> : day.items.length ? <b className="num">{day.items.length}</b> : null}
              </button>
            )
          })}
        </div>
      ) : <Loading />}
      {picked ? (
        <section className="stack">
          <h2>{niceDate(picked.date)}</h2>
          {picked.items.length ? (
            <ul className="feature-list">
              {picked.items.map((item: any, index: number) => {
                const row = <><strong>{t(item.name)}</strong><span className="when">{item.time}{item.assignee ? `, ${item.assignee}` : ''}</span><Chip tone={item.state === 'done' ? 'good' : item.state === 'overdue' ? 'urgent' : 'plain'}>{t(STATE_WORD[item.state])}</Chip></>
                return <li key={index}>{item.runId ? <a className="day-line" href={`#/run/${item.runId}`}>{row}</a> : <div className="day-line">{row}</div>}</li>
              })}
            </ul>
          ) : <p className="muted">{t('Nothing planned.')}</p>}
        </section>
      ) : null}
    </section>
  )
}

function Proposal({ proposal, onSaved, onClose, runId, needsPicture, onPicture }: { proposal: any; runId: string; onSaved: (run: any) => void; onClose: () => void; needsPicture: boolean; onPicture: (itemId: number, value: string) => void }) {
  const [value, setValue] = useState(String(proposal.value ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!proposal.matched) {
    return (
      <section className="card proposal" aria-live="polite">
        {proposal.transcript ? <p>{t('We heard:')}{' '}<q>{proposal.transcript}</q></p> : null}
        <p>{t("We couldn't match that to a check. Try again, or type it in below.")}</p>
        <button className="btn block" type="button" onClick={onClose}>{t('OK')}</button>
      </section>
    )
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = await api(`/api/staff/runs/${runId}/entries`, {
        body: { itemId: proposal.itemId, value: Number(value), source: proposal.photoFile ? 'photo' : 'voice', transcript: proposal.transcript, photoFile: proposal.photoFile },
      })
      onSaved(saved.run)
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  return (
    <section className="card proposal arrive" aria-live="polite">
      <div className="row between">
        <strong>{t(proposal.label)}</strong>
        {proposal.outOfRange ? <Chip tone="urgent">{t('Should be {range}', { range: proposal.range })}</Chip> : <Chip tone="good">{t('In range')}</Chip>}
      </div>
      {proposal.transcript ? <p className="caption">{t('We heard:')}{' '}<q>{proposal.transcript}</q></p> : <p className="caption">{t('Read from your photo.')}</p>}
      {proposal.needsCheck ? <p className="notice">{t('Check this number before you confirm it.')}</p> : null}
      <label className="field">{t('Reading{v}', { v: proposal.unit ? ` (${proposal.unit})` : '' })}
        <input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <ErrorNote message={error} />
      <div className="actions">
        {needsPicture
          ? <button className="btn primary block" type="button" disabled={value === ''} onClick={() => onPicture(proposal.itemId, value)}><Camera size={24} aria-hidden="true" />{t('Add a photo or video')}</button>
          : <button className="btn primary block" type="button" disabled={busy || value === ''} onClick={confirm}>{t('Confirm reading')}</button>}
        <button className="btn text" type="button" onClick={onClose}>{t('Cancel')}</button>
      </div>
    </section>
  )
}

/** Colour never carries the verdict alone, and the words say it is a suggestion. */
function ProofResult({ proof, preview }: { proof: any; preview?: string | null }) {
  const src = preview ?? (proof.file ? `/api/files/${proof.file}` : null)
  const clip = proof.localVideo ?? (proof.video ? `/api/files/${proof.video}` : null)
  if (proof.track && clip) {
    return (
      <>
        <Chip tone={proof.verdict === 'ok' ? 'good' : 'attention'}>{proof.verdict === 'ok' ? t('Looks right') : t('Look again')}</Chip>
        <p>{proof.reason}</p>
        <TrackedVideo src={clip} path={proof.track.path} label={t('Video of {name}', { name: proof.target ?? t('the check') })} />
        <p className="caption">{proof.track.path.length ? t('SAM followed {target} through {percent}% of the video.', { target: proof.target, percent: proof.track.share }) : t('SAM could not find: {target}', { target: proof.target })}</p>
      </>
    )
  }
  return (
    <>
      <Chip tone={proof.verdict === 'ok' ? 'good' : 'attention'}>{proof.verdict === 'ok' ? t('Looks right') : t('Look again')}</Chip>
      <p>{proof.reason}</p>
      {src ? (
        <div className="proof-image">
          <img src={src} alt={t('Photo of {name}', { name: proof.target ?? t('the check') })} />
          {proof.boxes.map((box: any, index: number) => (
            <i key={index} aria-hidden="true" style={{ left: `${(box.x1 / box.w) * 100}%`, top: `${(box.y1 / box.h) * 100}%`, width: `${((box.x2 - box.x1) / box.w) * 100}%`, height: `${((box.y2 - box.y1) / box.h) * 100}%` }} />
          ))}
        </div>
      ) : null}
      {proof.target ? <p className="caption">{proof.boxes.length ? t('SAM found: {target}', { target: proof.target }) : t('SAM could not find: {target}', { target: proof.target })}</p> : null}
    </>
  )
}

/** Nothing is saved until the worker says so, even when the model is happy. */
function ProofCard({ proof, preview, value, onValue, onSave, onRetake }: { proof: any; preview: string | null; value: string; onValue: (value: string) => void; onSave: () => void; onRetake: () => void }) {
  const reading = proof.type !== 'tick'
  return (
    <section className="card proposal arrive" aria-live="polite">
      <strong>{t(proof.label)}</strong>
      <ProofResult proof={proof} preview={preview} />
      {reading ? <label className="field">{t('Reading{unit}', { unit: proof.unit ? ` (${proof.unit})` : '' })}<input inputMode="decimal" value={value} onChange={(event) => onValue(event.target.value)} /></label> : null}
      <div className="actions">
        <button className={`btn${proof.verdict === 'ok' ? ' primary' : ''} block`} type="button" disabled={reading && value === ''} onClick={onSave}>{proof.verdict === 'ok' ? t('Save') : t('Save anyway, and tell the owner')}</button>
        <button className={`btn${proof.verdict === 'ok' ? ' text' : ' primary'} block`} type="button" onClick={onRetake}>{t('Take it again')}</button>
      </div>
    </section>
  )
}

function ItemRow({ item, runId, readOnly, onSaved, onProof, busy }: any) {
  const [value, setValue] = useState(item.entry?.value === null || item.entry?.value === undefined ? '' : String(item.entry.value))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setValue(item.entry?.value === null || item.entry?.value === undefined ? '' : String(item.entry.value)) }, [item.entry?.value])

  const save = async (body: object) => {
    setError(null)
    try { onSaved((await api(`/api/staff/runs/${runId}/entries`, { body: { itemId: item.id, ...body } })).run) } catch (problem) { setError((problem as Error).message) }
  }
  const clear = async () => {
    setError(null)
    try { onSaved((await api(`/api/staff/runs/${runId}/entries/${item.id}`, { method: 'DELETE' })).run) } catch (problem) { setError((problem as Error).message) }
  }
  const unit = item.unit ? ` ${item.unit}` : ''
  const tick = item.type === 'tick'
  const addPicture = <button className={`btn${item.needsProof ? '' : ' text'} small`} type="button" disabled={busy} onClick={() => onProof(item)}><Camera size={22} aria-hidden="true" />{t('Add a photo or video')}</button>

  return (
    <li className="item-row" data-done={item.entry ? true : undefined}>
      <div className="row between">
        {tick && !item.needsProof ? (
          <label className="check">
            <input type="checkbox" checked={!!item.entry} disabled={readOnly} onChange={() => (item.entry ? clear() : save({ source: 'tick' }))} />
            <span>{t(item.label)}</span>
          </label>
        ) : <span className="item-name">{item.entry ? <CheckCircle size={22} weight="fill" aria-hidden="true" /> : null}{t(item.label)}</span>}
        {item.entry && !tick ? <Chip tone={item.entry.flagged ? 'urgent' : 'good'}>{item.entry.value}{unit}</Chip> : null}
      </div>
      {item.proofHint && !item.entry ? <p className="caption">{item.proofHint}</p> : null}
      {item.entry ? <p className="when">{t('Done {at}{entry}', { at: inSentence(momentWords(item.entry.at)), entry: byWhom(item.entry) })}</p> : null}
      {item.entry?.transcript ? <p className="caption">{t('Said:')}{' '}<q>{item.entry.transcript}</q></p> : null}
      {readOnly && item.entry?.proof ? <ProofResult proof={item.entry.proof} /> : null}
      {readOnly && item.entry?.proof?.video ? <video className="evidence" controls preload="metadata" src={`/api/files/${item.entry.proof.video}`} aria-label={t('Video from staff')} /> : null}
      {readOnly && item.entry?.photo ? <img className="evidence" src={`/api/files/${item.entry.photo}`} alt={t('Photo from staff')} /> : null}
      {!readOnly && item.entry ? <button className="btn text small" type="button" onClick={clear}>{t('Undo')}</button> : null}
      {!readOnly && !item.entry && !tick && !item.needsProof ? (
        <div className="reading-row">
          <input className="input" inputMode="decimal" aria-label={t('{label} reading{unit}', { label: t(item.label), unit })} placeholder={unit.trim() || t('Value')} value={value} onChange={(event) => setValue(event.target.value)} />
          <button className="btn small" type="button" disabled={value === '' || busy} onClick={() => save({ value: Number(value), source: 'typed' })}><Check size={22} aria-hidden="true" />{t('Save')}</button>
          <span />
        </div>
      ) : null}
      {!readOnly && !item.entry ? addPicture : null}
      <ErrorNote message={error} />
    </li>
  )
}

export function RunDetail({ id, sample, readOnly = false }: { id: string; sample: boolean; readOnly?: boolean }) {
  const [run, setRun] = useState<any>(null)
  const [proposal, setProposal] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proof, setProof] = useState<any>(null)
  const [proofValue, setProofValue] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [picking, setPicking] = useState<any>(null)
  const spoken = useRef<string | null>(null)

  useEffect(() => { api(`/api/staff/runs/${id}`).then(setRun).catch((e) => setError(e.message)) }, [id])

  const propose = async (work: () => Promise<any>) => {
    setBusy(true)
    setError(null)
    setProposal(null)
    try { setProposal(await work()) } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }

  const recorder = useRecorder(20, (clip) => {
    const form = new FormData()
    form.append('audio', clip, 'clip.wav')
    void propose(() => api(`/api/staff/runs/${id}/voice`, { form }))
  })

  const sendProof = async (file: File) => {
    const item = picking
    setPicking(null)
    setBusy(true)
    setError(null)
    setProof(null)
    try {
      const form = await evidenceForm(file, { itemId: String(item.id) })
      setPreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null)
      const checked = await api(`/api/staff/runs/${id}/proof`, { form })
      setProof({ ...checked, returnTo: item, localVideo: file.type.startsWith('video/') ? URL.createObjectURL(file) : null })
      setProofValue(spoken.current ?? (checked.reading === null ? '' : String(checked.reading)))
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }

  const saveProof = async () => {
    try {
      const reading = proof.type === 'tick' ? {} : { value: Number(proofValue) }
      const saved = await api(`/api/staff/runs/${id}/entries`, { body: { itemId: proof.itemId, proofId: proof.proofId, source: 'photo', ...reading } })
      setRun(saved.run)
      setProof(null)
      spoken.current = null
    } catch (problem) { setError((problem as Error).message) }
  }

  /** A reading said aloud still needs its picture, so the number waits while the camera opens. */
  const needPicture = (itemId: number, value: string) => {
    spoken.current = value
    setProposal(null)
    setPicking(run.items.find((item: any) => item.id === itemId))
  }

  if (!run) return <Screen title={t('Check')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const saved = (next: any) => { setRun(next); setProposal(null); setBusy(false) }
  const hasReadings = run.items.some((item: any) => item.type !== 'tick')

  return (
    <Screen title={t(run.name)} lead={<>{dueWords(run.dueAt)}{hasReadings && !readOnly ? t('. Tap Voice note and say the check and the number, such as "fridge two is at 4".') : ''}</>}>
      <div className="row">
        <RunChip state={run.state} />
        {run.assignee ? <Chip tone="plain">{t('For {name}', { name: run.assignee })}</Chip> : null}
      </div>
      <ErrorNote message={error ?? recorder.error} />
      {proposal ? <Proposal key={JSON.stringify(proposal)} proposal={proposal} runId={id} needsPicture={!!run.items.find((item: any) => item.id === proposal.itemId)?.needsProof} onPicture={needPicture} onSaved={saved} onClose={() => setProposal(null)} /> : null}
      {busy && !proposal ? <p className="thinking" role="status">{t('Checking the picture')}</p> : null}
      {proof ? <ProofCard proof={proof} preview={preview} value={proofValue} onValue={setProofValue} onSave={saveProof} onRetake={() => { setPicking(proof.returnTo); setProof(null) }} /> : null}
      {picking ? <EvidenceSheet title={t(picking.label)} hint={picking.proofHint} sample={sample} live={!sample && picking.proofTarget ? { what: '', item: picking.proofTarget } : undefined} onFile={sendProof} onClose={() => setPicking(null)} /> : null}
      <ul className="items">
        {run.items.map((item: any) => <ItemRow key={item.id} item={item} runId={id} readOnly={readOnly} sample={sample} busy={busy} onSaved={saved} onProof={setPicking} />)}
      </ul>
      {run.state === 'done' ? <a className="btn block" href={readOnly ? '#/checklists' : '#/staff'}>{t('Back to checklists')}</a> : null}
      {hasReadings && !readOnly && run.state !== 'done' && !proof ? (
        <Dock>
          {sample ? (
            <button className="btn primary block" type="button" disabled={busy} onClick={() => propose(() => api(`/api/staff/runs/${id}/sample-voice`, { method: 'POST' }))}>
              <Microphone size={24} aria-hidden="true" />{busy ? t('Listening') : t('Voice note: sample clip')}
            </button>
          ) : recorder.recording ? (
            <button className="btn primary block" type="button" onClick={recorder.stop}><Stop size={24} weight="fill" aria-hidden="true" />{t('Stop, {seconds}s', { seconds: recorder.seconds })}</button>
          ) : (
            <button className="btn primary block" type="button" disabled={busy} onClick={recorder.start}><Microphone size={24} aria-hidden="true" />{busy ? t('Listening') : t('Voice note')}</button>
          )}
        </Dock>
      ) : null}
    </Screen>
  )
}
