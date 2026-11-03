import { useEffect, useState, type ReactNode } from 'react'
import { CaretLeft, CaretRight, Microphone, PhoneCall, Siren } from '@phosphor-icons/react'
import { Count, Phone, Stage, States, type Act } from '../kit'
import { t, tk } from '../i18n'
import { Mascot } from '../Mascot'
import './stories.css'

/**
 * One order from start to finish: the shoebox, the call, the delivery, the invoice and what it
 * all saved. Each scene is one thing happening on a full colour ground, the stage stays one
 * size so nothing jumps, and the money saved carries from scene to scene.
 */

const WIDTH = 358
const HEIGHT = 440
const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`

function Scene<S extends object>({ initial, poster, script, children }: { initial: S; poster: S; script: (a: Act<S>) => Promise<void>; children: (state: S) => ReactNode }) {
  return <Stage<S> width={WIDTH} height={HEIGHT} initial={initial} poster={poster} script={script} play="once" className="story-stage">{(state) => children(state)}</Stage>
}

const ORDER = { kilos: 20, arrived: 16, boxes: 5, boxesArrived: 4, offered: 690, agreed: 640, lastWeek: 590, billed: 13800, right: 10240 }
const TALKED_DOWN = (ORDER.offered - ORDER.agreed) * ORDER.kilos
const CLAIMED = ORDER.billed - ORDER.right
const TOTAL = TALKED_DOWN + CLAIMED

const SLIPS = [
  ['HARROW LANE FOODS', '£138.00', -8, 12, 34], ['NORTHGATE', '£46.20', 6, 160, 8], ['OAKFIELD DAIRY', '£19.20', -3, 76, 88],
  ['HARROW LANE FOODS', '£91.40', 11, 172, 102], ['NORTHGATE', '£12.75', -13, 8, 138], ['OAKFIELD DAIRY', '£38.40', 4, 112, 168],
] as const

type Pile = { slips: number }
const pileScript = async (a: Act<Pile>) => {
  await a.wait(400)
  for (let slips = 1; slips <= SLIPS.length; slips += 1) {
    a.set({ slips })
    await a.wait(420)
  }
  await a.wait(1800)
}

function PileScene() {
  return (
    <Scene<Pile> initial={{ slips: 0 }} poster={{ slips: SLIPS.length }} script={pileScript}>
      {(s) => (
        <div className="sc-pile">
          <p className="sc-clock">23:07</p>
          {SLIPS.map(([name, total, turn, left, top], index) => (
            <div className="sc-slip" key={index} data-show={s.slips > index || undefined} style={{ left, top, ['--turn' as string]: `${turn}deg` }}>
              <b>{name}</b><i /><i /><i /><span>{total}</span>
            </div>
          ))}
        </div>
      )}
    </Scene>
  )
}

type Call = { said: boolean; agreed: boolean }
const callScript = async (a: Act<Call>) => {
  await a.wait(900)
  a.set({ said: true })
  await a.wait(2800)
  a.mark('agreed')
  a.set({ agreed: true })
  await a.wait(2800)
}

function CallScene() {
  return (
    <Scene<Call> initial={{ said: false, agreed: false }} poster={{ said: true, agreed: true }} script={callScript}>
      {(s) => (
        <div className="sc-call">
          <p className="sc-live"><i />{t('On a call')}</p>
          <p className="sc-item">{t('Chicken thighs')}</p>
          <div className="sc-price">
            <Count value={s.agreed ? ORDER.agreed : s.said ? ORDER.offered : ORDER.lastWeek} duration={700} format={pounds} />
            <small>{t('a kilo')}</small>
          </div>
          <div className="sc-flag" data-show={s.said || undefined} data-good={s.agreed || undefined}>
            <States value={s.agreed ? 'on' : 'off'} states={{ off: t('You paid {price} last week', { price: pounds(ORDER.lastWeek) }), on: t('Agreed, 50p a kilo less') }} />
          </div>
        </div>
      )}
    </Scene>
  )
}

type Film = { seen: number; done: boolean }
const filmScript = async (a: Act<Film>) => {
  await a.wait(600)
  for (let seen = 1; seen <= ORDER.boxesArrived; seen += 1) {
    a.set({ seen })
    await a.wait(1000)
  }
  a.mark('short')
  a.set({ done: true })
  await a.wait(2800)
}

function FilmScene() {
  return (
    <Scene<Film> initial={{ seen: 0, done: false }} poster={{ seen: 4, done: true }} script={filmScript}>
      {(s) => (
        <div className="sc-film">
          <div className="sc-viewfinder">
            <p className="sc-rec"><i />00:0{Math.max(1, s.seen)}</p>
            <div className="sc-strip" style={{ transform: `translateX(${-Math.max(0, s.seen - 2) * 104}px)` }}>
              {Array.from({ length: ORDER.boxesArrived }, (_, index) => (
                <div className="sc-box" key={index} data-on={s.seen > index || undefined}><u /><em />{s.seen > index ? <b>{index + 1}</b> : null}</div>
              ))}
            </div>
          </div>
          <div className="sc-tally">
            <Count className="sc-tally-count" value={s.seen} duration={260} format={(value: number) => String(Math.round(value))} />
            <p>{t('of {total} boxes', { total: ORDER.boxes })}</p>
            <span className="sc-short" data-show={s.done || undefined}>{t('{arrived} kg, not {ordered} kg', { arrived: ORDER.arrived, ordered: ORDER.kilos })}</span>
          </div>
        </div>
      )}
    </Scene>
  )
}

type Alert = { said: boolean; task: boolean }
const alertScript = async (a: Act<Alert>) => {
  await a.wait(500)
  a.set({ said: true })
  await a.wait(2000)
  a.mark('task')
  a.set({ task: true })
  await a.wait(3400)
}

function AlertScene() {
  return (
    <Scene<Alert> initial={{ said: false, task: false }} poster={{ said: true, task: true }} script={alertScript}>
      {(s) => (
        <Phone width={306} frame="pro" time="07:42" className="story-phone">
          <div className="sc-owner">
            <p className="sc-bubble" data-show={s.said || undefined}><Microphone size={18} weight="fill" />Brakuje jednego pudełka</p>
            <div className="sc-task" data-show={s.task || undefined}>
              <span className="sc-urgent"><Siren size={16} weight="fill" />{t('Urgent')}</span>
              <p>{t('Chicken thighs: short, {arrived} of {ordered} kg', { arrived: ORDER.arrived, ordered: ORDER.kilos })}</p>
              <span className="sc-call-btn"><PhoneCall size={20} weight="fill" />{t('Call Dave')}</span>
            </div>
          </div>
        </Phone>
      )}
    </Scene>
  )
}

type Paper = { rows: number; found: boolean }
const paperScript = async (a: Act<Paper>) => {
  await a.wait(600)
  for (const rows of [1, 2, 3]) {
    a.set({ rows })
    await a.wait(800)
  }
  a.mark('found')
  a.set({ found: true })
  await a.wait(3000)
}

function PaperScene() {
  const rows = [
    [t('Billed'), `${ORDER.kilos} kg × ${pounds(ORDER.offered)}`],
    [t('Agreed on call'), pounds(ORDER.agreed)],
    [t('Delivered'), `${ORDER.arrived} kg`],
  ]
  return (
    <Scene<Paper> initial={{ rows: 0, found: false }} poster={{ rows: 3, found: true }} script={paperScript}>
      {(s) => (
        <div className="sc-paper">
          <div className="sc-rows">
            {rows.map(([label, value], index) => <div className="sc-row" key={label} data-show={s.rows > index || undefined}><span>{label}</span><b>{value}</b></div>)}
          </div>
          <div className="sc-owed" data-show={s.found || undefined}>
            <Count value={s.found ? CLAIMED : 0} duration={800} format={pounds} />
            <p>{t('to claim back')}</p>
          </div>
        </div>
      )}
    </Scene>
  )
}

type Payoff = { shown: boolean; split: boolean }
const payoffScript = async (a: Act<Payoff>) => {
  await a.wait(400)
  a.set({ shown: true })
  await a.wait(1500)
  a.mark('split')
  a.set({ split: true })
  await a.wait(3400)
}

function PayoffScene() {
  return (
    <Scene<Payoff> initial={{ shown: false, split: false }} poster={{ shown: true, split: true }} script={payoffScript}>
      {(s) => (
        <div className="sc-payoff">
          <Mascot size={72} tone="light" />
          <Count className="sc-total" value={s.shown ? TOTAL : 0} duration={1000} format={pounds} />
          <ul data-show={s.split || undefined}>
            <li><b>{pounds(TALKED_DOWN)}</b> {t('talked down on calls')}</li>
            <li><b>{pounds(CLAIMED)}</b> {t('found on invoices')}</li>
          </ul>
          <p className="sc-more" data-show={s.split || undefined}>{t('And checklists, crisis cards and {count} languages.', { count: 18 })}</p>
        </div>
      )}
    </Scene>
  )
}

const STORIES = [
  { title: tk("It's 11pm. The receipts are still in a shoebox."), seconds: 5, ground: 'ink', saved: null, picture: () => <PileScene /> },
  { title: tk('Dave puts the price up. Stockpot catches it.'), seconds: 7, ground: 'plum', saved: TALKED_DOWN, picture: () => <CallScene /> },
  { title: tk('Maria films the delivery. Stockpot counts the boxes.'), seconds: 8, ground: 'saffron', saved: TALKED_DOWN, picture: () => <FilmScene /> },
  { title: tk('She says it in Polish. You read it in English.'), seconds: 7, ground: 'chilli', saved: TALKED_DOWN, picture: () => <AlertScene /> },
  { title: tk('The invoice still bills the full 20 kg.'), seconds: 7, ground: 'cream', saved: TOTAL, picture: () => <PaperScene /> },
  { title: tk('One order. All of it found for you.'), seconds: 7, ground: 'herb', saved: null, picture: () => <PayoffScene /> },
]

/** What this order has saved so far. It only moves once the story has shown why. */
function Saved({ pence }: { pence: number | null }) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (pence === null) return void setShown(0)
    const timer = setTimeout(() => setShown(pence), 4200)
    return () => clearTimeout(timer)
  }, [pence])
  return <p className="story-saved" data-off={pence === null || undefined}><span>{t('Money saved')}</span><Count value={shown} duration={700} format={pounds} /></p>
}

/** The demo as a set of short stories: they play by themselves, and a tap moves on or back. */
export function Stories() {
  const [index, setIndex] = useState(0)
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const story = STORIES[index]
  useEffect(() => {
    if (calm) return
    const timer = setTimeout(() => setIndex((index + 1) % STORIES.length), story.seconds * 1000)
    return () => clearTimeout(timer)
  }, [index])

  return (
    <section className="stories" data-ground={story.ground} aria-roledescription={t('Stories')} aria-label={t('What Stockpot does')}>
      <ol className="story-bars" aria-hidden="true">
        {STORIES.map((item, at) => <li key={at} data-state={at < index ? 'done' : at === index ? 'on' : undefined} style={{ ['--seconds' as string]: `${item.seconds}s` }}><i key={at === index ? index : 'idle'} /></li>)}
      </ol>
      <h2 key={index} className="story-title arrive" aria-live="polite">{t(story.title)}</h2>
      <Saved pence={story.saved} />
      <div className="story-picture" dir="ltr" aria-hidden="true" key={`picture-${index}`}>{story.picture()}</div>
      <button className="story-tap back" type="button" aria-label={t('Earlier')} onClick={() => setIndex((index + STORIES.length - 1) % STORIES.length)}><CaretLeft size={22} aria-hidden="true" /></button>
      <button className="story-tap next" type="button" aria-label={t('Later')} onClick={() => setIndex((index + 1) % STORIES.length)}><CaretRight size={22} aria-hidden="true" /></button>
    </section>
  )
}
