import { useEffect, useState, type ReactNode } from 'react'
import { CaretLeft, CaretRight, Checks, Microphone, PhoneCall, Receipt, UserPlus, WhatsappLogo } from '@phosphor-icons/react'
import { Count, Phone, Stage, States, type Act } from '../kit'
import { t, tk } from '../lib/i18n'
import { Mascot } from '../components/Mascot'
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
          <Owner frantic={s.slips >= 3} />
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

/**
 * The owner at the end of a long night, drawn flat in the app's own colours: hands on their head, and once the
 * pile gets big, the scribble of stress above them. An original figure, nobody in particular.
 */
function Owner({ frantic }: { frantic: boolean }) {
  return (
    <svg className="sc-owner-figure" data-frantic={frantic || undefined} viewBox="0 0 150 170" width="150" height="170" aria-hidden="true">
      <g className="sc-stress" fill="none" stroke="#f2a93b" strokeWidth="5" strokeLinecap="round">
        <path d="M44 22 l-10 -14" /><path d="M75 12 v-12" /><path d="M106 22 l10 -14" />
        <path d="M120 40 q8 -6 4 -14 q-4 -8 6 -12" />
      </g>
      <path d="M22 170 q0 -58 53 -58 q53 0 53 58 z" fill="#4a2d6e" />
      <path d="M58 112 l17 18 l17 -18" fill="#eee7f6" />
      <g className="sc-arms" fill="none" stroke="#4a2d6e" strokeWidth="17" strokeLinecap="round">
        <path d="M32 132 q-14 -36 8 -60" /><path d="M118 132 q14 -36 -8 -60" />
      </g>
      <circle cx="75" cy="72" r="34" fill="#e8b48c" />
      <path d="M41 66 q2 -34 34 -34 q34 0 34 34 q-8 -14 -22 -16 q-14 8 -34 2 q-8 4 -12 14 z" fill="#2d1a45" />
      <circle cx="42" cy="72" r="8" fill="#e8b48c" /><circle cx="108" cy="72" r="8" fill="#e8b48c" />
      <g className="sc-face" stroke="#1d1a22" strokeWidth="3.5" strokeLinecap="round" fill="none">
        <path d="M60 70 l8 6 M68 70 l-8 6" /><path d="M82 70 l8 6 M90 70 l-8 6" />
        <ellipse cx="75" cy="91" rx="7" ry="9" fill="#1d1a22" stroke="none" />
      </g>
    </svg>
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

/** One week's list as the kitchen reads it: the same rows, then in Polish, then sent to the supplier. */
const LIST = [
  { supplier: 'Harrow Lane Foods', rows: [['Chicken thighs', 'Udka z kurczaka', '18 kg']] },
  { supplier: 'Northgate Wholesale', rows: [['Brown onions', 'Cebula', '12 kg'], ['Tomatoes', 'Pomidory', '8 kg'], ['Basmati rice', 'Ryż basmati', '10 kg']] },
] as const

type List = { rows: number; polish: boolean; sent: boolean }
const listScript = async (a: Act<List>) => {
  await a.wait(500)
  for (const rows of [1, 2, 3, 4]) {
    a.set({ rows })
    await a.wait(380)
  }
  await a.wait(900)
  a.mark('polish')
  a.set({ polish: true })
  await a.wait(1900)
  a.mark('sent')
  a.set({ sent: true })
  await a.wait(2400)
}

/** Where each row sits in the whole list, so they arrive one after another across suppliers. */
const ORDER_OF = new Map(LIST.flatMap((group) => group.rows.map(([english]) => english)).map((name, index) => [name, index + 1]))

function ListScene() {
  return (
    <Scene<List> initial={{ rows: 0, polish: false, sent: false }} poster={{ rows: 4, polish: true, sent: true }} script={listScript}>
      {(s) => (
        <div className="sc-list">
          <div className="sc-sheet">
            <div className="sc-sheet-head">
              <States align="start" className="sc-sheet-title" value={s.polish ? 'pl' : 'en'} states={{ en: 'This week', pl: 'Ten tydzień' }} />
              <span className="sc-langs"><span className="sc-lang" data-on={s.polish || undefined}><b>EN</b><b>PL</b></span><em>+16</em></span>
            </div>
            {LIST.map((group) => (
              <div className="sc-group" key={group.supplier}>
                <p className="sc-supplier">{group.supplier}</p>
                {group.rows.map(([english, polish, amount]) => (
                  <div className="sc-line" key={english} data-show={s.rows >= ORDER_OF.get(english)! || undefined}>
                    <States align="start" value={s.polish ? 'pl' : 'en'} states={{ en: english, pl: polish }} />
                    <b>{amount}</b>
                  </div>
                ))}
              </div>
            ))}
            <div className="sc-send" data-sent={s.sent || undefined}>
              <States value={s.sent ? 'sent' : 'send'} states={{ send: <><WhatsappLogo size={20} weight="fill" />Wyślij do Northgate</>, sent: <><Checks size={20} weight="bold" />Wysłano</> }} />
            </div>
          </div>
        </div>
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
          <p className="sc-saved-label">{t('saved on one order')}</p>
          <ul data-show={s.split || undefined}>
            <li style={{ ['--share' as string]: TALKED_DOWN / TOTAL }}><span><PhoneCall size={18} weight="fill" />{t('On the call')}</span><b>{pounds(TALKED_DOWN)}</b><i /></li>
            <li style={{ ['--share' as string]: CLAIMED / TOTAL }}><span><Receipt size={18} weight="fill" />{t('On the receipt')}</span><b>{pounds(CLAIMED)}</b><i /></li>
          </ul>
        </div>
      )}
    </Scene>
  )
}


type Crisis = { said: boolean; card: boolean; pressed: boolean; sent: boolean }
const crisisScript = async (a: Act<Crisis>) => {
  await a.wait(500)
  a.set({ said: true })
  await a.wait(1600)
  a.mark('card')
  a.set({ card: true })
  await a.wait(2000)
  a.set({ pressed: true })
  await a.wait(260)
  a.mark('sent')
  a.set({ pressed: false, sent: true })
  await a.wait(3200)
}

/**
 * The card exactly as the owner's Tasks screen shows it: what staff said, the order Stockpot wrote, and the three
 * buttons. Staff say it in Polish; one tap on WhatsApp orders more from the supplier.
 */
function CrisisScene() {
  return (
    <Scene<Crisis> initial={{ said: false, card: false, pressed: false, sent: false }} poster={{ said: true, card: true, pressed: false, sent: true }} script={crisisScript}>
      {(s) => (
        <Phone width={306} frame="pro" time="16:10" className="story-phone">
          <div className="sc-owner sc-tasks">
            <p className="sc-bubble from-staff" data-show={s.said || undefined}><Microphone size={18} weight="fill" />Skończyła się cebula!</p>
            <div className="sc-confirm" data-show={s.card || undefined}>
              <p className="sc-confirm-label">{t('To confirm')}</p>
              <p className="sc-confirm-title">{t('Ran out of onions')}</p>
              <small>{t('{name} reported this in {language}', { name: t('Staff'), language: t('Polish') })}, 16:10</small>
              <p className="sc-note">{t('Order {amount} of {item} from {supplier} today', { amount: '7 kg', item: t('Brown onions'), supplier: 'Fresh Fields Produce' })}</p>
              <span className="sc-wa-btn" data-pressed={s.pressed || undefined} data-sent={s.sent || undefined}>
                <States value={s.sent ? 'sent' : 'send'} states={{ send: <><WhatsappLogo size={20} weight="fill" />{t('WhatsApp {name}', { name: 'Fresh Fields Produce' })}</>, sent: <><Checks size={20} weight="bold" />{t('Sent to {name}', { name: 'Fresh Fields Produce' })}</> }} />
              </span>
              <div className="sc-pair">
                <span><PhoneCall size={18} />{t('Call')}</span>
                <span><UserPlus size={18} />{t('Give to staff')}</span>
              </div>
              <div className="sc-decide"><b>{t('Confirm')}</b><span>{t('Dismiss')}</span></div>
            </div>
          </div>
        </Phone>
      )}
    </Scene>
  )
}

const STORIES = [
  { title: tk("It's 11pm. The receipts are still in a shoebox."), seconds: 6, ground: 'ink', saved: null, picture: () => <PileScene /> },
  { title: tk('Dave puts the price up. Stockpot catches it.'), seconds: 7, ground: 'plum', saved: TALKED_DOWN, picture: () => <CallScene /> },
  { title: tk('Maria films the delivery. Stockpot counts the boxes.'), seconds: 8, ground: 'saffron', saved: TALKED_DOWN, picture: () => <FilmScene /> },
  { title: tk('Your shopping list writes itself, in 18 languages.'), seconds: 8, ground: 'mint', saved: TALKED_DOWN, picture: () => <ListScene /> },
  { title: tk('The invoice still bills the full 20 kg.'), seconds: 7, ground: 'cream', saved: TOTAL, picture: () => <PaperScene /> },
  { title: tk('What one order saved, from the call and the receipt.'), seconds: 7, ground: 'herb', saved: null, picture: () => <PayoffScene /> },
  { title: tk('Staff run out of onions. You order more in one tap.'), seconds: 9, ground: 'chilli', saved: null, picture: () => <CrisisScene /> },
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
