import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { ArrowRight, CheckCircle, FileText, GoogleLogo, Plus, Sparkle } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { t, tn } from '../lib/i18n'
import { Mascot } from '../components/Mascot'
import { LanguageButton } from '../components/Language'
import { InviteForm } from './Settings'
import { ErrorNote } from '../components/ui'
import { estimateDish, estimateLine } from '../components/Estimate'
import { inTurns, MENU_FILES, mergeDishes, readEach, readMenuFile, type FileProblem } from '../lib/reading'

const STEPS = 5

function Step({ number, say, children, onNext, nextLabel, canSkip = true }: { number: number; say: string; children: ReactNode; onNext: () => void; nextLabel: string; canSkip?: boolean }) {
  return (
    <main className="onboard" key={number}>
      <div className="onboard-top">
        <ol className="onboard-dots" aria-label={t('Step {number} of {total}', { number, total: STEPS })}>
          {Array.from({ length: STEPS }, (_, index) => <li key={index} data-on={index < number || undefined} />)}
        </ol>
        <LanguageButton />
      </div>
      <div className="onboard-say arrive">
        <Mascot size={64} />
        <h1>{say}</h1>
      </div>
      <div className="onboard-body arrive">{children}</div>
      <div className="onboard-foot">
        <button className="btn primary block" type="button" onClick={onNext}>{nextLabel}<ArrowRight size={22} aria-hidden="true" /></button>
        {canSkip ? <button className="btn text block" type="button" onClick={onNext}>{t('Skip for now')}</button> : null}
      </div>
    </main>
  )
}

/** Five short questions from Stockpot. Each answer is saved as real setup, so there is nothing to redo. */
export function Onboarding({ onDone }: { onDone?: () => Promise<unknown> }) {
  const [step, setStep] = useState(1)
  const [restaurant, setRestaurant] = useState('')
  const [suppliers, setSuppliers] = useState([{ name: '', email: '' }])
  const [dishes, setDishes] = useState<any[] | null>(null)
  const [reading, setReading] = useState(false)
  const [problems, setProblems] = useState<FileProblem[]>([])
  const [estimates, setEstimates] = useState<Record<number, any>>({})
  const [estimating, setEstimating] = useState(false)
  const [menuSaved, setMenuSaved] = useState(false)
  const [gmail, setGmail] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api('/api/setup').then((setup) => setRestaurant(setup.restaurant)).catch(() => undefined)
    api('/api/connections').then((status) => setGmail(status.gmail)).catch(() => undefined)
  }, [])

  const next = () => { setError(null); setStep(step + 1) }

  const saveName = async () => {
    if (restaurant.trim()) await api('/api/setup/restaurant', { body: { name: restaurant } }).catch(() => undefined)
    next()
  }

  const saveSuppliers = async () => {
    setError(null)
    try {
      for (const supplier of suppliers.filter((row) => row.name.trim())) await api('/api/setup/suppliers', { body: supplier })
      next()
    } catch (problem) { setError((problem as Error).message) }
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, 20)
    event.target.value = ''
    if (!files.length) return
    setReading(true)
    setError(null)
    const { found, problems } = await readEach(files, readMenuFile)
    setProblems(problems)
    const read = found.flatMap(({ result }) => result)
    if (found.length && !read.length) setError(t('Stockpot found no dishes in that menu.'))
    if (read.length) { setDishes(mergeDishes(dishes ?? [], read)); setEstimates({}) }
    setReading(false)
  }

  const estimateAll = async () => {
    setEstimating(true)
    await inTurns((dishes ?? []).map((dish, index) => ({ dish, index })), async ({ dish, index }) => {
      const result = await estimateDish({ name: dish.name, pricePence: dish.pricePence, lines: dish.lines.filter((line: any) => line.quantity !== null) }).catch((problem) => ({ error: (problem as Error).message }))
      setEstimates((current) => ({ ...current, [index]: result }))
    })
    setEstimating(false)
  }

  /** Every dish with a price is saved on its own. Any that can't be are named, and the owner can carry on and fix them later. */
  const saveMenu = async () => {
    if (menuSaved || !dishes?.length) return next()
    setError(null)
    const failed: string[] = []
    for (const dish of dishes.filter((row) => row.pricePence)) {
      await api('/api/setup/dishes', { body: { name: dish.name, pricePence: dish.pricePence, targetMargin: 70, lines: dish.lines.filter((line: any) => line.quantity !== null) } })
        .catch((problem) => failed.push(`${dish.name}: ${(problem as Error).message}`))
    }
    const unpriced = dishes.filter((row) => !row.pricePence).length
    if (!failed.length && !unpriced) return next()
    setMenuSaved(true)
    setError([
      ...failed,
      unpriced ? t('Dishes with no price were not saved. Add them in Settings, Menu and recipes.') : '',
    ].filter(Boolean).join('\n'))
  }

  const finish = async () => {
    await api('/api/setup/onboarded', { method: 'POST' })
    await onDone?.()
    window.location.hash = '#/home'
  }

  if (step === 1) {
    return (
      <Step number={1} say={t("Hi, I'm Stockpot. What's your restaurant called?")} onNext={saveName} nextLabel={t('Next')} canSkip={false}>
        <label className="field">{t('Restaurant name')}<input autoFocus value={restaurant} onChange={(event) => setRestaurant(event.target.value)} /></label>
      </Step>
    )
  }
  if (step === 2) {
    return (
      <Step number={2} say={t('Who do you buy from?')} onNext={saveSuppliers} nextLabel={t('Next')}>
        <p className="muted">{t('With their email, invoices can come in by themselves.')}</p>
        {suppliers.map((row, index) => (
          <div className="two" key={index}>
            <label className="field">{t('Name')}<input value={row.name} onChange={(event) => setSuppliers(suppliers.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)))} /></label>
            <label className="field">{t('Email')}<input type="email" value={row.email} onChange={(event) => setSuppliers(suppliers.map((item, at) => (at === index ? { ...item, email: event.target.value } : item)))} /></label>
          </div>
        ))}
        <button className="btn text small" type="button" onClick={() => setSuppliers([...suppliers, { name: '', email: '' }])}><Plus size={20} aria-hidden="true" />{t('Add another')}</button>
        <ErrorNote message={error} />
      </Step>
    )
  }
  if (step === 3) {
    return (
      <Step number={3} say={t('Show me your menu.')} onNext={saveMenu} nextLabel={menuSaved ? t('Next') : dishes?.length ? t('Save and continue') : t('Next')}>
        <p className="muted">{t('Photos, PDFs, Word or text files are fine, and you can choose several. Then I can work out your costs.')}</p>
        <input ref={input} type="file" multiple accept={MENU_FILES} hidden onChange={upload} />
        {dishes ? (
          <ul className="list">
            {dishes.map((dish, index) => (
              <li key={index}>
                <span>{dish.name}
                  {dish.notes?.map((note: any, at: number) => <span className="when" key={at}><br />{t(note.text, note.values)}</span>)}
                  {estimates[index] ? <span className="when"><br />{estimates[index].error ?? estimateLine(estimates[index])}</span> : null}
                </span>
                <span className="num">{dish.pricePence === null ? t('No price') : `£${(dish.pricePence / 100).toFixed(2)}`}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {dishes ? <p className="notice">{tn(dishes.length, 'I found {n} dish.', 'I found {n} dishes.')}</p> : null}
        {dishes?.length ? <button className="btn block" type="button" disabled={estimating} onClick={estimateAll}><Sparkle size={24} aria-hidden="true" />{estimating ? t('Estimating') : t('Estimate costs and prices with AI')}</button> : null}
        {dishes?.length && !estimating && Object.keys(estimates).length ? <p className="caption">{t('AI estimates use typical UK wholesale prices before VAT. They are a guide, and they are never saved. Prices from your receipts replace them.')}</p> : null}
        <button className="btn block" type="button" disabled={reading || menuSaved} onClick={() => input.current?.click()}><FileText size={24} aria-hidden="true" />{reading ? t('Reading your menu') : t('Upload menu')}</button>
        {problems.map((problem, index) => <p className="error" role="alert" key={index}><strong>{problem.file}</strong>: {problem.message}</p>)}
        {error ? error.split('\n').map((line, index) => <ErrorNote key={index} message={line} />) : null}
      </Step>
    )
  }
  if (step === 4) {
    return (
      <Step number={4} say={t('Sign in with Google, and I can handle your supplier emails.')} onNext={next} nextLabel={t('Next')}>
        <p className="muted">{t('I bring in invoices from your suppliers, and send order emails from your address. I read nothing else.')}</p>
        {gmail?.connected ? <p className="notice"><CheckCircle size={20} aria-hidden="true" />{gmail.account}</p> : <a className="btn block" href="/api/google/login"><GoogleLogo size={24} aria-hidden="true" />{t('Sign in with Google')}</a>}
      </Step>
    )
  }
  return (
    <Step number={5} say={t('Last one. Who is on your team?')} onNext={finish} nextLabel={t('Finish')}>
      <p className="muted">{t('Send them a link. They tap it, and they get their checklists on WhatsApp.')}</p>
      <InviteForm />
    </Step>
  )
}
