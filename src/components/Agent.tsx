import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { PaperPlaneRight, PhoneCall, Receipt, Tray } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { t, tk } from '../lib/i18n'
import { Mascot } from './Mascot'
import type { Period } from './Period'
import { ErrorNote, Loading, Sheet, Sk } from './ui'

const AnswerView = lazy(() => import('../screens/AnswerView'))

const SUGGESTIONS = [tk('Which dish sells the most?'), tk('What went up in price?'), tk('How is food cost going week by week?')]

const SHORTCUTS = [
  { href: '#/receipts', label: tk('Add a receipt'), Icon: Receipt },
  { href: '#/call', label: tk('Record a call'), Icon: PhoneCall },
  { href: '#/actions', label: tk('Add a task'), Icon: Tray },
]

/** The dates on the Dashboard, so "this month" there means the same here. */
let shownPeriod: Period | undefined
export const setAgentPeriod = (period?: Period) => { shownPeriod = period }

/** Words arrive at reading pace and push the card down as they come, the way a person types. */
function Streamed({ text }: { text: string }) {
  const words = text.split(' ')
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = useState(calm ? words.length : 0)
  useEffect(() => {
    if (shown >= words.length) return
    const timer = setTimeout(() => setShown(shown + 1), 28)
    return () => clearTimeout(timer)
  }, [shown, words.length])
  return <p aria-label={text}><span aria-hidden="true">{words.slice(0, shown).join(' ')}</span></p>
}

interface Turn { question: string; reply: any | null }

/** The chat stays while the app is open, so a question can follow on from the last one. */
let kept: Turn[] = []

export function Agent({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>(kept)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [turns, busy])

  const ask = async (text: string) => {
    const earlier = turns.filter((turn) => turn.reply).slice(-3).map((turn) => ({ question: turn.question, answer: turn.reply.answer }))
    const asking = [...turns, { question: text, reply: null }]
    setTurns(asking)
    setBusy(true)
    setError(null)
    setQuestion('')
    try {
      const reply = await api('/api/analyst/ask', { body: { question: text, earlier, ...shownPeriod } })
      const done = asking.map((turn, index) => (index === asking.length - 1 ? { ...turn, reply } : turn))
      setTurns(done)
      kept = done
    } catch (problem) {
      setTurns(turns)
      setError((problem as Error).message)
    } finally { setBusy(false) }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (question.trim()) void ask(question.trim())
  }

  return (
    <Sheet className="agent-dialog" title={t('Ask Stockpot')} onClose={onClose}>
      <div className="agent-log" aria-live="polite">
        {turns.length ? null : (
          <div className="agent-hello">
            <Mascot size={72} />
            <p>{t('Ask me anything about your restaurant, or tell me what to do.')}</p>
            <div className="ask-chips">
              {SUGGESTIONS.map((text) => <button key={text} type="button" disabled={busy} onClick={() => ask(t(text))}>{t(text)}</button>)}
            </div>
          </div>
        )}
        {turns.map((turn, index) => (
          <div className="agent-turn" key={index}>
            <p className="asked">{turn.question}</p>
            {turn.reply ? (
              <div className="ask-reply">
                <Mascot size={32} />
                <div className="stack">
                  <Streamed text={turn.reply.answer} />
                  {turn.reply.surface ? <Suspense fallback={<Loading />}><AnswerView surface={turn.reply.surface} /></Suspense> : null}
                  {turn.reply.steps.length ? (
                    <details className="worked">
                      <summary>{t('How I worked this out')}</summary>
                      <ul>{turn.reply.steps.map((step: string) => <li key={step}>{step}</li>)}</ul>
                      <p className="caption">{t('Figures come straight from your data.')}</p>
                    </details>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="ask-reply" aria-busy="true">
                <Mascot size={32} thinking />
                <div className="stack"><p className="thinking">{t('Checking your numbers')}</p><div className="sk-group"><Sk width="90%" /><Sk width="60%" /></div></div>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <ErrorNote message={error} />
      <nav className="agent-shortcuts" aria-label={t('Shortcuts')}>
        {SHORTCUTS.map(({ href, label, Icon }) => <a key={href} href={href} onClick={onClose}><Icon size={20} aria-hidden="true" />{t(label)}</a>)}
      </nav>
      <form className="ask-form" onSubmit={submit}>
        <input aria-label={t('Your question')} placeholder={t('Ask Stockpot')} value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button className="btn primary" type="submit" disabled={busy || !question.trim()} aria-label={t('Ask')}><PaperPlaneRight size={22} aria-hidden="true" /></button>
      </form>
    </Sheet>
  )
}
