import { t } from '../lib/i18n'
import { Bar, Bubble, Count, Stage, States, Text, Thread, type Act } from '../kit'
import { Siren } from '@phosphor-icons/react'
import './feature-grid.css'

// A bento of the five features, hero and strip: the call is the one idea no till
// has, so it leads. Only about half the tiles are UI, each picture is its own
// Stage, the copy is page type outside it, and no string appears twice.

type Call = { agreed: boolean }

const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`

const callScript = async (a: Act<Call>) => {
  await a.wait(1800)
  a.mark('agreed')
  a.set({ agreed: true })
  await a.wait(1400)
}

export function CallPicture() {
  return (
    <Stage<Call> width={520} height={216} compact={{ below: 480, width: 326, height: 216 }} initial={{ agreed: false }} poster={{ agreed: true }} script={callScript} play="once" className="fg-call">
      {(s) => (
        <div className="fg-quote">
          <span className="fg-live"><i aria-hidden="true" />{t('On a call')}</span>
          <Text className="fg-item">{t('Chicken thighs')}</Text>
          <div className="fg-figure">
            <Count className="fg-price" value={s.agreed ? 640 : 690} duration={700} format={pounds} />
            <Text className="fg-unit">{t('a kilo')}</Text>
          </div>
          <States className="fg-note" value={s.agreed ? 'on' : 'off'} states={{ off: t('You paid £6.40 last week'), on: t('Agreed, 50p a kilo less') }} />
        </div>
      )}
    </Stage>
  )
}

type Chat = { saved: boolean }

const chatScript = async (a: Act<Chat>) => {
  await a.wait(1600)
  a.mark('saved')
  a.set({ saved: true })
  await a.wait(1400)
}

export function ChatPicture() {
  return (
    <Stage<Chat> width={358} height={190} compact={{ below: 300, width: 234, height: 190 }} initial={{ saved: false }} poster={{ saved: true }} script={chatScript} play="once" className="fg-chat">
      {(s) => (
        <div className="fg-thread">
          <Thread>
            <Bubble from="me">{t('Lodówka jeden, 4 stopnie')}</Bubble>
            <Bubble from="them">{t('Fridge one: 4°C. Save this?')}</Bubble>
          </Thread>
          <div className="fg-reply" data-saved={s.saved || undefined}>
            <States value={s.saved ? 'on' : 'off'} states={{ off: t('Save'), on: t('Saved') }} />
          </div>
        </div>
      )}
    </Stage>
  )
}

export function ReceiptPicture() {
  return (
    <Stage width={358} height={190} compact={{ below: 300, width: 234, height: 190 }} initial={{}} className="fg-pile">
      {() => (
        <div className="fg-stack">
          <section className="fg-paper fg-paper--back" />
          <section className="fg-paper fg-paper--mid"><Bar w={96} h={8} r={4} tone={3} /></section>
          <section className="fg-paper fg-paper--top">
            <Text className="fg-merchant">{t('Harrow Lane Foods')}</Text>
            <div className="fg-line"><Text>{t('Chicken thighs')}</Text><Text>£138.00</Text></div>
            <div className="fg-line"><Text>{t('Brown onions')}</Text><Text>£8.50</Text></div>
            <div className="fg-line fg-total"><Text>{t('Total')}</Text><Text>£146.50</Text></div>
          </section>
        </div>
      )}
    </Stage>
  )
}

export function FeatureGrid() {
  return (
    <section className="fg" aria-label={t('What Stockpot does')}>
      <article className="fg-tile fg-tile--wide fg-tile--stage">
        <div aria-hidden="true"><CallPicture /></div>
        <p className="fg-copy"><strong>{t('Calls.')}</strong>{' '}{t('See the last price you paid while the supplier is still talking.')}</p>
      </article>
      <article className="fg-tile fg-tile--stat">
        <p className="fg-lead">{t('Food cost')}</p>
        <p className="fg-stat">+1.0<span>{' '}{t('point')}</span></p>
        <p className="fg-why">{t('Chicken thighs went from £5.90 to £6.40.')}</p>
        <p className="fg-copy"><strong>{t('AI analyst.')}</strong>{' '}{t('Finds the one price that moved it.')}</p>
      </article>
      <article className="fg-tile fg-tile--picture">
        <div aria-hidden="true"><ReceiptPicture /></div>
        <p className="fg-copy"><strong>{t('Receipts.')}</strong>{' '}{t('A pile of photos becomes rows.')}</p>
      </article>
      <article className="fg-tile fg-tile--picture">
        <div aria-hidden="true"><ChatPicture /></div>
        <p className="fg-copy"><strong>{t('Checklists.')}</strong>{' '}{t('Staff answer on WhatsApp, in any language.')}</p>
      </article>
      <article className="fg-tile fg-tile--alarm">
        <Siren size={40} aria-hidden="true" />
        <p className="fg-big">{t('Gas smell')}</p>
        <p className="fg-step">{t('1. Open windows and doors.')}</p>
        <p className="fg-copy"><strong>{t('Crisis cards.')}</strong>{' '}{t('The right steps in two taps, with no signal.')}</p>
      </article>
    </section>
  )
}
