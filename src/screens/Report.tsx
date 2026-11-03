import { t, tk } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { evidenceForm } from '../lib/media'
import { EvidenceSheet } from '../components/Evidence'
import { Camera, CheckCircle, DotsThree, Drop, Fire, Lightning, Microphone, Package, Siren, Stop, Wrench } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { CRISIS_CARDS } from '../../server/operations/crisis'
import { useRecorder } from '../lib/recorder'
import { Chip, Dock, ErrorNote, Loading, Screen } from '../components/ui'

const TONE: Record<string, 'urgent' | 'due' | 'neutral'> = { now: 'urgent', today: 'due', soon: 'neutral' }
const WORD: Record<string, string> = { now: tk('Urgent'), today: tk('Due today'), soon: tk('Not important') }

const KINDS = [
  { key: 'stock', label: tk('Ran out'), Icon: Package, ask: tk('What ran out?') },
  { key: 'broken', label: tk('Broken'), Icon: Wrench, ask: tk("What's broken?") },
  { key: 'power', label: tk('Power'), Icon: Lightning, quick: true },
  { key: 'water', label: tk('Water'), Icon: Drop, quick: true },
  { key: 'gas', label: tk('Gas'), Icon: Fire, quick: true },
  { key: 'other', label: tk('Other'), Icon: DotsThree, ask: tk('What happened?') },
]

export function StaffReport({ sample }: { sample: boolean }) {
  const [kind, setKind] = useState<(typeof KINDS)[number] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [media, setMedia] = useState<File | null>(null)
  const [picking, setPicking] = useState(false)
  const [filed, setFiled] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const send = async (work: () => Promise<any>) => {
    setBusy(true)
    setError(null)
    try {
      const report = await work()
      if (media) await api(`/api/staff/reports/${report.id}/media`, { form: await evidenceForm(media) })
      setFiled(report)
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const recorder = useRecorder(90, (clip) => {
    const form = new FormData()
    form.append('audio', clip, 'report.wav')
    void send(() => api('/api/staff/reports', { form }))
  })

  const choose = async (next: (typeof KINDS)[number]) => {
    setKind(next)
    if (next.quick) await send(() => api('/api/staff/reports/quick', { body: { kind: next.key } }))
  }

  if (filed) {
    const card = CRISIS_CARDS.find((candidate) => candidate.key === filed.crisisKey)
    return (
      <Screen title={t('Owner told at {toldAt}', { toldAt: filed.toldAt })} lead={t('They have it in English, with your own words kept.')}>
        <Chip tone="good">{filed.title}</Chip>
        {card ? <a className="btn danger block" href={`#/staff/crisis/${card.key}`}><Siren size={24} aria-hidden="true" />{t('Open the {value} card', { value: card.title.toLowerCase() })}</a> : null}
        <button className="btn block" type="button" onClick={() => { setFiled(null); setText(''); setKind(null) }}>{t('Send another')}</button>
      </Screen>
    )
  }

  const typed = kind && text.trim() ? `${kind.label}: ${text.trim()}` : text.trim()
  return (
    <Screen title={t('Report a problem')} lead={t('Tap what happened. Say the rest in your own language, and the owner gets it in English.')}>
      <section className="staff-tiles" aria-label={t('What happened')}>
        {KINDS.map((option) => (
          <button className={`tile-btn${option.quick ? ' danger' : ''}`} type="button" key={option.key} aria-pressed={kind?.key === option.key} disabled={busy} onClick={() => choose(option)}>
            <option.Icon size={32} aria-hidden="true" />{t(option.label)}
          </button>
        ))}
      </section>
      <ErrorNote message={recorder.error ?? error} />
      <label className="field">{kind?.ask ? t(kind.ask) : t('Or type it')}
        <textarea className="short" value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <button className="btn block" type="button" disabled={busy} onClick={() => setPicking(true)}><Camera size={24} aria-hidden="true" />{media ? media.name : t('Add a photo or video')}</button>
      {picking ? <EvidenceSheet title={t('Add a photo or video')} sample={sample} onFile={(file) => { setMedia(file); setPicking(false) }} onClose={() => setPicking(false)} /> : null}
      {text.trim() ? <button className="btn block" type="button" disabled={busy} onClick={() => send(() => api('/api/staff/reports', { body: { text: typed } }))}>{t('Send')}</button> : null}
      <Dock>
        {sample ? (
          <button className="btn primary block" type="button" disabled={busy} onClick={() => send(() => api('/api/staff/reports/sample', { method: 'POST' }))}>
            <Microphone size={24} aria-hidden="true" />{busy ? t('Sending') : t('Send the sample report in Polish')}
          </button>
        ) : recorder.recording ? (
          <button className="btn primary block" type="button" onClick={recorder.stop}><Stop size={24} weight="fill" aria-hidden="true" />{t('Stop and send, {seconds}s', { seconds: recorder.seconds })}</button>
        ) : (
          <button className="btn primary block" type="button" disabled={busy} onClick={recorder.start}><Microphone size={24} aria-hidden="true" />{busy ? t('Sending') : t('Start speaking')}</button>
        )}
      </Dock>
    </Screen>
  )
}

export function OwnerReport({ id }: { id: string }) {
  const [report, setReport] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api(`/api/reports/${id}`).then(setReport).catch((e) => setError(e.message)) }, [id])
  if (!report) return <Screen title={t('Staff report')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const done = async () => {
    await api(`/api/actions/${report.actionId}/done`, { method: 'POST' })
    window.location.hash = '#/home'
  }

  return (
    <Screen title={report.title} lead={report.language ? t('{name}, in {language}', { name: report.reporter ?? t('Staff'), language: t(report.language) }) : (report.reporter ?? t('Staff'))}>
      <Chip tone={TONE[report.urgency]}>{t(WORD[report.urgency])}</Chip>
      {report.english ? <section className="stack"><h2>{t('In English')}</h2><p>{report.english}</p></section> : <p className="notice">{t("This one couldn't be translated, so here are the words as they were heard.")}</p>}
      <section className="stack">
        <h2>{t('Their words')}</h2>
        <blockquote className="original" lang={report.language === 'Polish' ? 'pl' : undefined}>{report.original}</blockquote>
        {report.audio ? <audio controls preload="none" src={`/api/files/${report.audio}`} aria-label={t('Play the original report')} /> : null}
        {report.photo && !report.video ? <img className="evidence" src={`/api/files/${report.photo}`} alt={t('Photo from staff')} /> : null}
        {report.video ? <video className="evidence" controls preload="metadata" src={`/api/files/${report.video}`} aria-label={t('Video from staff')} /> : null}
      </section>
      {report.crisisKey ? <a className="btn block" href={`#/crisis/${report.crisisKey}`}><Siren size={24} aria-hidden="true" />{t('Open the crisis card')}</a> : null}
      {report.open ? <button className="btn primary block" type="button" onClick={done}><CheckCircle size={24} aria-hidden="true" />{t('Mark as done')}</button> : null}
    </Screen>
  )
}
