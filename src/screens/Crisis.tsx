import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ArrowDown, ArrowUp, Camera, Drop, Fire, Lightning, PencilSimple, PhoneCall, Plus, Siren, Thermometer, Trash, WifiSlash, type Icon } from '@phosphor-icons/react'
import { api } from '../api'
import { currentLanguage, t } from '../i18n'
import { CRISIS_CARDS } from '../../server/crisis'
import { Dock, ErrorNote, Screen, Sheet } from '../ui'

const ICONS: Record<string, Icon> = { gas: Fire, power: Lightning, water: Drop, fridge: Thermometer, wifi: WifiSlash }
const SAVED = 'stockpot-crisis-cards'

const standard = CRISIS_CARDS.map((card) => ({ ...card, call: card.call ?? null, steps: card.steps.map((text) => ({ text, photo: null as string | null })), edited: false, custom: false }))

function remembered() {
  try { return JSON.parse(localStorage.getItem(SAVED) ?? 'null') as typeof standard | null } catch { return null }
}

/** The cards ship in the app, and the owner's versions are kept on the device, so all of them open with no connection. */
function useCards() {
  const [cards, setCards] = useState(() => remembered() ?? standard)
  const load = () => api<typeof standard>('/api/crisis').then((latest) => {
    setCards(latest)
    try { localStorage.setItem(SAVED, JSON.stringify(latest)) } catch { /* private window */ }
  }).catch(() => undefined)
  useEffect(() => { void load() }, [])
  return { cards, load }
}

function CardEditor({ card, onClose, onDone }: { card: any | null; onClose: () => void; onDone: (key?: string) => void }) {
  const [title, setTitle] = useState(card ? t(card.title) : '')
  const [number, setNumber] = useState(card?.call?.number ?? '')
  const [steps, setSteps] = useState<Array<{ text: string; photo: string | null }>>(card ? card.steps.map((step: any) => ({ ...step, text: t(step.text) })) : [{ text: '', photo: null }])
  const [error, setError] = useState<string | null>(null)
  const picking = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const change = (index: number, next: object) => setSteps(steps.map((step, at) => (at === index ? { ...step, ...next } : step)))
  const move = (index: number, by: number) => {
    const list = [...steps]
    const [step] = list.splice(index, 1)
    list.splice(index + by, 0, step)
    setSteps(list)
  }
  const photo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    try { change(picking.current, { photo: (await api('/api/crisis/photo', { form })).photo }) } catch (problem) { setError((problem as Error).message) }
  }
  const save = async () => {
    setError(null)
    try {
      const body = { title, number, steps }
      const saved = await api(card ? `/api/crisis/${card.key}` : '/api/crisis', { method: card ? 'PUT' : 'POST', body })
      onDone(saved.key)
    } catch (problem) { setError((problem as Error).message) }
  }
  const reset = async () => {
    await api(`/api/crisis/${card.key}`, { method: 'DELETE' })
    onDone()
  }
  return (
    <Sheet title={card ? t('Edit this card') : t('New crisis card')} onClose={onClose}>
      <label className="field">{t('Title')}<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field">{t('Number to call')}<input type="tel" value={number} onChange={(event) => setNumber(event.target.value)} /></label>
      <h3>{t('Steps')}</h3>
      <ol className="step-editors">
        {steps.map((step, index) => (
          <li key={index}>
            <textarea aria-label={t('Step {number}', { number: index + 1 })} rows={2} value={step.text} onChange={(event) => change(index, { text: event.target.value })} />
            {step.photo ? <img className="evidence" src={`/api/crisis/photo/${step.photo}`} alt="" /> : null}
            <div className="step-tools">
              <button className="btn text small" type="button" onClick={() => { picking.current = index; input.current?.click() }}><Camera size={20} aria-hidden="true" />{step.photo ? t('Change photo') : t('Add a photo')}</button>
              <span>
                <button className="icon-btn" type="button" disabled={index === 0} aria-label={t('Move up')} onClick={() => move(index, -1)}><ArrowUp size={20} aria-hidden="true" /></button>
                <button className="icon-btn" type="button" disabled={index === steps.length - 1} aria-label={t('Move down')} onClick={() => move(index, 1)}><ArrowDown size={20} aria-hidden="true" /></button>
                <button className="icon-btn" type="button" aria-label={t('Remove')} onClick={() => setSteps(steps.filter((_, at) => at !== index))}><Trash size={20} aria-hidden="true" /></button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={photo} />
      <button className="btn text small" type="button" onClick={() => setSteps([...steps, { text: '', photo: null }])}><Plus size={20} aria-hidden="true" />{t('Add a step')}</button>
      <p className="caption">{t('You are changing safety steps. Get them checked by someone qualified.')}</p>
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" onClick={save}>{t('Save')}</button>
      {card?.custom ? <button className="btn text block" type="button" onClick={reset}>{t('Delete this card')}</button> : null}
      {card?.edited ? <button className="btn text block" type="button" onClick={reset}>{t('Go back to the standard card')}</button> : null}
    </Sheet>
  )
}

export function CrisisList({ base, owner = false }: { base: string; owner?: boolean }) {
  const { cards, load } = useCards()
  const [adding, setAdding] = useState(false)
  return (
    <Screen title={t('Crisis cards')} lead={t("Choose what's happening.")}>
      <div className="crisis-grid">
        {cards.map((card) => {
          const Glyph = ICONS[card.key] ?? Siren
          return <a className="crisis-tile" key={card.key} href={`${base}/${card.key}`}><Glyph size={32} aria-hidden="true" />{t(card.title)}</a>
        })}
      </div>
      {owner ? <Dock><button className="btn block" type="button" onClick={() => setAdding(true)}><Plus size={24} aria-hidden="true" />{t('New crisis card')}</button></Dock> : null}
      {adding ? <CardEditor card={null} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void load() }} /> : null}
    </Screen>
  )
}

export function CrisisCardView({ cardKey, base, owner = false }: { cardKey: string; base: string; owner?: boolean }) {
  const { cards, load } = useCards()
  const [editing, setEditing] = useState(false)
  const card = cards.find((candidate) => candidate.key === cardKey)
  if (!card) return <CrisisList base={base} owner={owner} />
  return (
    <Screen title={t(card.title)}>
      {card.call ? <a className="btn danger block" href={`tel:${card.call.number}`}><PhoneCall size={24} aria-hidden="true" />{card.edited || card.custom ? t('Call {number}', { number: card.call.number }) : t(card.call.label)}</a> : null}
      <ol className="crisis-steps">
        {card.steps.map((step) => <li key={step.text}><span>{t(step.text)}{step.photo ? <img className="evidence" src={`/api/crisis/photo/${step.photo}`} alt="" /> : null}</span></li>)}
      </ol>
      {owner ? <button className="btn block" type="button" onClick={() => setEditing(true)}><PencilSimple size={22} aria-hidden="true" />{t('Edit this card')}</button> : null}
      <a className="btn block" href={base}>{t('All cards')}</a>
      {currentLanguage() === 'en' || card.edited || card.custom ? null : <p className="notice">{t('This card was translated by AI. Ask someone to check it before you rely on it.')}</p>}
      {card.edited || card.custom ? <p className="caption">{t('Written by the owner.')}</p> : <p className="caption">{t('Sample wording. Get these cards checked by a qualified person before real use.')}</p>}
      {editing ? <CardEditor card={card} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void load() }} /> : null}
    </Screen>
  )
}
