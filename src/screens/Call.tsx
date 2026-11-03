import { t } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Megaphone, Phone, Stop } from '@phosphor-icons/react'
import { api, niceDate, pounds } from '../lib/api'
import { CallLink } from '../lib/callLink'
import { Chip, ErrorNote, Loading, Screen } from '../components/ui'

interface Card {
  itemId: number; itemName: string; unit: string; kind: 'offer' | 'agreed' | 'reference'; pricePence: number
  quantityBase: number | null; lastPaid: { pence: number; date: string; supplier: string } | null
  deltaPence: number | null; deltaPercent: number | null; cheaper: { pence: number; date: string; supplier: string } | null
  extraCostPence: number | null; sayThis: string | null; latencyMs: number | null
  dishes: Array<{ name: string; marginNow: number; marginNew: number; target: number; belowTarget: boolean }>
}

/** Spoken to a UK supplier, so it stays in English whatever language the app is in. */
const NOTICE = 'This call is being recorded by Stockpot for our order records.'

function playNotice() {
  const voice = new SpeechSynthesisUtterance(NOTICE)
  voice.lang = 'en-GB'
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(voice)
}

const unitWord = (unit: string) => (unit === 'kg' ? t('a kilo') : unit === 'l' ? t('a litre') : t('each'))
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function Verdict({ card, saved }: { card: Card; saved: number | null }) {
  if (card.kind === 'agreed') {
    return <p className="verdict">{saved ? t('Agreed. That saves you {saved} on this order.', { saved: pounds(saved) }) : t('Agreed.')}</p>
  }
  if (card.deltaPence === null) return <p className="verdict">{t('First price for this item.')}</p>
  if (card.deltaPence === 0) return <p className="verdict">{t('Same as you last paid.')}</p>
  const rise = card.deltaPence > 0
  const Icon = rise ? ArrowUp : ArrowDown
  return (
    <p className="verdict" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <Icon size={22} weight="bold" aria-hidden="true" />
      {t(rise ? '{amount} more than last time ({percent}%)' : '{amount} less than last time ({percent}%)', { amount: pounds(Math.abs(card.deltaPence)), percent: Math.abs(card.deltaPercent ?? 0) })}
    </p>
  )
}

function Steam({ level }: { level: number }) {
  const lift = (weight: number) => ({ transform: `scaleY(${Math.max(0.28, Math.min(1, level * weight)).toFixed(2)})` })
  return <div className="steam" role="img" aria-label={level > 0.05 ? t('Hearing sound') : t('Quiet')}><b style={lift(2.6)} /><b style={lift(1.9)} /><b style={lift(1.4)} /></div>
}

function Quote({ card, firstOffer }: { card: Card; firstOffer: number | null }) {
  const saved = card.kind === 'agreed' && firstOffer !== null && card.quantityBase ? Math.round((firstOffer - card.pricePence) * card.quantityBase) : null
  const dish = card.dishes.find((candidate) => candidate.belowTarget) ?? null
  return (
    <>
      <div>
        <p className="quote-name">{card.itemName}</p>
        <div className="price"><strong>{pounds(card.pricePence)}</strong><span>{unitWord(card.unit)}</span></div>
      </div>
      <Verdict card={card} saved={saved} />
      <ul className="facts">
        {card.lastPaid ? <li>{t('You paid {amount} on {date}', { amount: pounds(card.lastPaid.pence), date: niceDate(card.lastPaid.date) })}</li> : null}
        {card.cheaper ? <li>{t('{supplier} charged {amount} on {date}', { supplier: card.cheaper.supplier, amount: pounds(card.cheaper.pence), date: niceDate(card.cheaper.date) })}</li> : null}
        {card.kind === 'offer' && card.extraCostPence && card.extraCostPence > 0 ? <li>{t('Costs {amount} more on this order', { amount: pounds(card.extraCostPence) })}</li> : null}
        {dish ? <li>{t('{name} falls to {margin}%, under your {target}% target', { name: dish.name, margin: dish.marginNew, target: dish.target })}</li> : null}
      </ul>
      {card.sayThis && card.kind === 'offer' ? <p className="say"><small>{t('You could say')}</small>{card.sayThis}</p> : null}
    </>
  )
}

export function Call({ sample }: { sample: boolean }) {
  const [suppliers, setSuppliers] = useState<any[] | null>(null)
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<'setup' | 'connecting' | 'live' | 'writing'>('setup')
  const [turns, setTurns] = useState<Array<{ turn: number; text: string }>>([])
  const [partial, setPartial] = useState('')
  const [cards, setCards] = useState<Card[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const firstOffers = useRef(new Map<number, number>())
  const stopAudio = useRef<() => void>(() => undefined)
  const link = useRef<CallLink | null>(null)

  useEffect(() => {
    api('/api/suppliers').then((list) => { setSuppliers(list); setSupplierId(list[0]?.id ?? null) }).catch((e) => setError(e.message))
    return () => { stopAudio.current(); link.current?.close() }
  }, [])

  useEffect(() => {
    if (phase !== 'live') return
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [phase])

  const finishPlayback = () => { stopAudio.current(); stopAudio.current = () => undefined; setLevel(0) }

  const start = async () => {
    setError(null)
    setPhase('connecting')
    try {
      const { id } = await api('/api/calls', { body: { supplierId, consent, source: sample ? 'sample' : 'microphone' } })
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      let capture: { start: (send: (pcm: ArrayBuffer) => void) => void } | null = null
      if (!sample) capture = await openMicrophone(setLevel, stopAudio)
      let listening = false
      // The link keeps the call going across connections, so it stays on one screen from start to end.
      link.current = new CallLink(`${scheme}://${window.location.host}/ws/call/${id}`, (event) => {
        if (event.type === 'listening' && !listening) {
          listening = true
          setPhase('live')
          if (sample) playSample(setLevel, stopAudio)
          capture?.start((pcm) => link.current?.send(pcm))
        }
        if (event.type === 'partial') setPartial(event.text)
        if (event.type === 'turn') { setPartial(''); setTurns((list) => [...list, { turn: event.turn, text: event.text }]) }
        if (event.type === 'card') {
          const card: Card = event.card
          if (card.kind === 'offer' && !firstOffers.current.has(card.itemId)) firstOffers.current.set(card.itemId, card.pricePence)
          setCards((list) => [card, ...list.filter((existing) => existing.itemId !== card.itemId)])
        }
        if (event.type === 'warning') setWarning(event.message)
        if (event.type === 'reconnecting') setWarning(t('The connection dropped. Reconnecting, and the recording is safe.'))
        if (event.type === 'reconnected') setWarning(null)
        if (event.type === 'status') { setPhase('writing'); finishPlayback() }
        if (event.type === 'done') {
          link.current?.close()
          window.location.hash = event.orderId ? `#/order/${event.orderId}` : '#/home'
        }
        if (event.type === 'lost') {
          // The write-up carries on without this screen, and the call shows on the list when it's ready.
          finishPlayback()
          link.current?.close()
          window.location.hash = '#/calls'
        }
      }, { rotateMs: sample ? 0 : undefined })
    } catch (problem) {
      finishPlayback()
      setPhase('setup')
      setError(problem instanceof DOMException ? t('Allow the microphone in your browser, then try again.') : (problem as Error).message)
    }
  }

  const end = () => {
    setPhase('writing')
    finishPlayback()
    link.current?.end()
  }

  if (phase === 'setup' || phase === 'connecting') {
    if (!suppliers) return <Screen title={t('Record a call')}><ErrorNote message={error} /><Loading /></Screen>
    return (
      <Screen title={t('Record a call')} lead={sample ? t('Plays a scripted call, so you can see how the live checks work.') : t('Stockpot does not dial. Phone your supplier on your own phone, on speaker, next to this device. Prices show up as they are said.')}>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: 8 }}><h2>{t('Who are you calling?')}</h2></legend>
          {suppliers.length ? null : <a className="btn block" href="#/settings/suppliers">{t('Add a supplier first')}</a>}
          {suppliers.map((supplier) => (
            <label className="choice" key={supplier.id}>
              <input type="radio" name="supplier" checked={supplierId === supplier.id} onChange={() => setSupplierId(supplier.id)} />
              {supplier.name}
            </label>
          ))}
        </fieldset>
        <section className="stack">
          <button className="btn" type="button" onClick={playNotice}><Megaphone size={24} aria-hidden="true" />{t('Play recording notice')}</button>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{t("I've told the supplier this call is being recorded.")}</span>
          </label>
        </section>
        <ErrorNote message={error} />
        <div className="actions">
          <button className="btn primary block" type="button" disabled={!consent || !supplierId || phase === 'connecting'} onClick={start}>
            <Phone size={24} aria-hidden="true" />{phase === 'connecting' ? t('Connecting') : sample ? t('Play sample call') : t('Start listening')}
          </button>
        </div>
      </Screen>
    )
  }

  const [top, ...earlier] = cards
  return (
    <div className="live-grid">
      <section className="stage" aria-live="polite">
        <div className="stage-inner">
          <div className="stage-top">
            <img src="/brand/stockpot-logo-reversed.svg" alt="Stockpot" />
            <div className="row" style={{ gap: 16 }}>
              <span className="rec num"><i aria-hidden="true" />{t('Recording {seconds}', { seconds: clock(seconds) })}</span>
              <Steam level={level} />
            </div>
          </div>
          {top ? <Quote card={top} firstOffer={firstOffers.current.get(top.itemId) ?? null} /> : <p className="listening">{phase === 'writing' ? t('Writing up the call.') : t('Listening for prices.')}</p>}
          {earlier.length ? (
            <div className="more-cards">{earlier.map((card) => <span key={card.itemId}>{card.itemName} {pounds(card.pricePence)}</span>)}</div>
          ) : null}
        </div>
      </section>
      <main className="screen" style={{ paddingTop: 16, paddingBottom: 120 }}>
        {warning ? <Chip tone="attention">{warning}</Chip> : null}
        <ErrorNote message={error} />
        <ol className="lines-live" aria-label={t('Transcript')}>
          {turns.slice(-6).map((turn) => <li key={turn.turn}>{turn.text}</li>)}
          {partial ? <li className="partial">{partial}</li> : null}
        </ol>
      </main>
      <div className="end-bar">
        <div>
          <button className="btn primary block" type="button" disabled={phase === 'writing'} onClick={end}>
            <Stop size={24} weight="fill" aria-hidden="true" />{phase === 'writing' ? t('Writing up the call') : t('End call')}
          </button>
        </div>
      </div>
    </div>
  )
}

async function openMicrophone(setLevel: (value: number) => void, stop: { current: () => void }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    // The phone is a separate device, so echo cancelling would only remove the supplier's voice.
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  })
  const context = new AudioContext({ sampleRate: 24000 })
  await context.audioWorklet.addModule('/pcm-worklet.js')
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'pcm-sender')
  source.connect(node)
  stop.current = () => { stream.getTracks().forEach((track) => track.stop()); void context.close() }
  return {
    start(send: (pcm: ArrayBuffer) => void) {
      node.port.onmessage = ({ data }) => { send(data.pcm); setLevel(data.level) }
    },
  }
}

function playSample(setLevel: (value: number) => void, stop: { current: () => void }) {
  const audio = new Audio('/samples/sample-call.wav')
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  const source = context.createMediaElementSource(audio)
  source.connect(analyser)
  analyser.connect(context.destination)
  const data = new Uint8Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(data)
    setLevel(Math.max(...data.map((value) => Math.abs(value - 128))) / 128)
  }, 90)
  stop.current = () => { clearInterval(timer); audio.pause(); void context.close() }
  void audio.play()
}
