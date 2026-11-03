import { useRef, useState, type ChangeEvent } from 'react'
import { UploadSimple } from '@phosphor-icons/react'
import { api, niceDate, pounds } from '../lib/api'
import { t, tn } from '../lib/i18n'
import { Chip, Dock, ErrorNote, Screen, Segment } from '../components/ui'
import { DishSheet, formFromRecipe } from './MenuSettings'

const SHOWN = 12
const FILES = '.csv,.xlsx,.pdf,.docx,.txt,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'

const Notes = ({ notes }: { notes: any[] }) => <>{notes.map((note, index) => <p className="notice" key={index}>{t(note.text, note.values)}</p>)}</>
const Flags = ({ flags }: { flags: any[] }) => <>{flags.map((flag, index) => <span className="when" key={index}><br />{t(flag.text, flag.values)}</span>)}</>

/** A dish that's missing from the menu can flag hundreds of rows, so each problem shows once with its count. */
function problemCounts(rows: any[]) {
  const counts = new Map<string, number>()
  for (const row of rows) for (const flag of row.flags) counts.set(t(flag.text, flag.values), (counts.get(t(flag.text, flag.values)) ?? 0) + 1)
  return [...counts]
}

function SalesPreview({ preview, onSave, onCancel }: { preview: any; onSave: (body: object) => void; onCancel: () => void }) {
  const { summary, ready, problems } = preview
  const toSave = ready.filter((row: any) => row.status !== 'same')
  return (
    <>
      <p>{tn(summary.rows, '{n} row read, with {sold} sold and {net} net.', '{n} rows read, with {sold} sold and {net} net.', { sold: summary.quantity, net: pounds(summary.netPence) })}</p>
      <ul className="list">
        <li><span>{t('New')}</span><strong className="num">{summary.new}</strong></li>
        {summary.replace ? <li><span>{t('Replaces what is saved')}</span><strong className="num">{summary.replace}</strong></li> : null}
        {summary.same ? <li><span>{t('Already saved, so skipped')}</span><strong className="num">{summary.same}</strong></li> : null}
        {summary.problems ? <li><span>{t('Flagged and left out')}</span><strong className="num">{summary.problems}</strong></li> : null}
      </ul>
      {problems.length ? (
        <section className="stack">
          <h3>{t('Check these')}</h3>
          <ul className="list">
            {problemCounts(problems).slice(0, SHOWN).map(([problem, rows]) => <li key={problem}><span>{problem}</span><span className="when num">{tn(rows, '{n} row', '{n} rows')}</span></li>)}
          </ul>
        </section>
      ) : null}
      <details className="worked">
        <summary>{t('See the rows')}</summary>
        <ul className="list">
          {ready.slice(0, SHOWN).map((row: any) => <li key={`${row.date}${row.dish}`}><span>{row.dish}<span className="when"><br />{niceDate(row.date)}</span></span><span className="num cost-cell">{pounds(row.netPence)}<span className="when"><br />{t('{sold} sold', { sold: row.quantity })}</span></span></li>)}
        </ul>
        {ready.length > SHOWN ? <p className="caption">{t('And {more} more.', { more: ready.length - SHOWN })}</p> : null}
      </details>
      <button className="btn primary block" type="button" disabled={!toSave.length} onClick={() => onSave({ kind: 'sales', rows: toSave.map(({ date, dish, quantity, netPence }: any) => ({ date, dish, quantity, netPence })) })}>{tn(toSave.length, 'Save {n} row', 'Save {n} rows')}</button>
      <button className="btn text block" type="button" onClick={onCancel}>{t('Cancel')}</button>
    </>
  )
}

function PricePreview({ preview, onSave, onCancel }: { preview: any; onSave: (body: object) => void; onCancel: () => void }) {
  const [supplier, setSupplier] = useState(preview.supplier.name ?? '')
  const [date, setDate] = useState(preview.date ?? '')
  const toSave = preview.rows.filter((row: any) => row.status === 'new')
  const flagged = preview.rows.filter((row: any) => row.flags.length)
  return (
    <>
      <div className="two">
        <label className="field">{t('Supplier')}<input value={supplier} onChange={(event) => setSupplier(event.target.value)} /></label>
        <label className="field">{t('Date of these prices')}<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      </div>
      <ul className="list">
        <li><span>{t('New prices')}</span><strong className="num">{preview.summary.new}</strong></li>
        {preview.summary.newItems ? <li><span>{t('New ingredients')}</span><strong className="num">{preview.summary.newItems}</strong></li> : null}
        {preview.summary.same ? <li><span>{t('Already saved, so skipped')}</span><strong className="num">{preview.summary.same}</strong></li> : null}
        {preview.summary.problems ? <li><span>{t('Flagged and left out')}</span><strong className="num">{preview.summary.problems}</strong></li> : null}
      </ul>
      {flagged.length ? (
        <section className="stack">
          <h3>{t('Check these')}</h3>
          <ul className="list">{flagged.slice(0, SHOWN).map((row: any) => <li key={row.row}><span>{row.name}<Flags flags={row.flags} /></span></li>)}</ul>
          {flagged.length > SHOWN ? <p className="caption">{t('And {more} more.', { more: flagged.length - SHOWN })}</p> : null}
        </section>
      ) : null}
      <details className="worked" open={preview.rows.length <= SHOWN}>
        <summary>{t('See the prices')}</summary>
        <ul className="list">
          {toSave.slice(0, SHOWN * 3).map((row: any) => (
            <li key={row.row}>
              <span>{row.name}<span className="when"><br />{row.pack}</span></span>
              <span className="num cost-cell">{t('{price} a {unit}', { price: pounds(row.basePricePence), unit: row.unit === 'each' ? t('each') : row.unit })}{row.isNew ? <span className="when"><br />{t('New')}</span> : null}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className="caption">{t('Old prices stay in your history. These become the newest prices from this date, so your costs update.')}</p>
      <button className="btn primary block" type="button" disabled={!toSave.length || !supplier.trim() || !date} onClick={() => onSave({ kind: 'ingredients', supplier, date, rows: toSave.map(({ name, unit, basePricePence }: any) => ({ name, unit, basePricePence })) })}>{tn(toSave.length, 'Save {n} price', 'Save {n} prices')}</button>
      <button className="btn text block" type="button" onClick={onCancel}>{t('Cancel')}</button>
    </>
  )
}

const needsWork = (recipe: any) => recipe.lines.some((line: any) => line.flags.length) || !recipe.lines.length

function RecipePreview({ preview, onSave, onCancel, onChanged }: { preview: any; onSave: (body: object) => void; onCancel: () => void; onChanged: (recipes: any[]) => void }) {
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [form, setForm] = useState<any>(null)
  const [dishes, setDishes] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const priceOf = (recipe: any) => recipe.pricePence ?? Math.round(Number(prices[recipe.name] ?? 0) * 100)
  const ready = preview.recipes.filter((recipe: any) => !needsWork(recipe) && priceOf(recipe) > 0)
  const check = async (recipe: any) => {
    setError(null)
    try {
      const rows = await api<any[]>('/api/setup/dishes')
      setDishes(rows)
      const dish = rows.find((row) => row.id === recipe.dishId)
      setForm({ ...formFromRecipe(recipe, dish, { notes: [], changes: recipe.changes, more: 0 }), id: dish?.id, photo: dish?.photo, recipeFileName: dish?.recipeFileName, pounds: dish ? (dish.pricePence / 100).toFixed(2) : prices[recipe.name] ?? '', source: recipe.name })
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <>
      <ErrorNote message={error} />
      <div className="stack">
        {preview.recipes.map((recipe: any) => (
          <article className="card" key={recipe.name}>
            <div>
              <strong>{recipe.name}</strong>
              <p className="when">{recipe.portions ? tn(recipe.portions, 'Makes {n} portion', 'Makes {n} portions') : t('Portions not stated')}, {tn(recipe.lines.length, '{n} ingredient', '{n} ingredients')}</p>
            </div>
            <div className="card-actions">
              <Chip tone={recipe.dishId ? 'neutral' : 'brand'}>{recipe.dishId ? tn(recipe.changes.length, '{n} change', '{n} changes') : t('New dish')}</Chip>
              {needsWork(recipe) ? <Chip tone="attention">{t('Needs you')}</Chip> : null}
            </div>
            <Notes notes={recipe.flags} />
            {recipe.dishId ? null : <label className="field">{t('Menu price (£)')}<input inputMode="decimal" className="num" value={prices[recipe.name] ?? ''} onChange={(event) => setPrices({ ...prices, [recipe.name]: event.target.value })} /></label>}
            <button className="btn block" type="button" onClick={() => check(recipe)}>{t('Check this recipe')}</button>
          </article>
        ))}
      </div>
      <button className="btn primary block" type="button" disabled={!ready.length} onClick={() => onSave({ kind: 'recipes', recipes: ready.map((recipe: any) => ({ ...recipe, pricePence: priceOf(recipe) })) })}>{tn(ready.length, 'Save {n} recipe', 'Save {n} recipes')}</button>
      <button className="btn text block" type="button" onClick={onCancel}>{t('Cancel')}</button>
      {form ? <DishSheet form={form} setForm={setForm} dish={dishes.find((dish) => dish.id === form.id)} onClose={() => setForm(null)} onSaved={() => { onChanged(preview.recipes.filter((recipe: any) => recipe.name !== form.source)); setForm(null) }} /> : null}
    </>
  )
}

/** One way in for what a restaurant keeps in files. A preview is all that happens until the owner confirms. */
export function ImportSettings() {
  const [kind, setKind] = useState('sales')
  const [preview, setPreview] = useState<any>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setError(null)
    setDone(null)
    setPreview(null)
    const form = new FormData()
    form.append('kind', kind)
    form.append('file', file)
    try { setPreview(await api('/api/ingest/read', { form })) } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }

  const words = (result: any) => {
    if (result.kind === 'recipes') return tn(result.saved, 'Saved {n} recipe.', 'Saved {n} recipes.')
    return [
      tn(result.saved, 'Saved {n} row.', 'Saved {n} rows.'),
      result.replaced ? t('{replaced} replaced what was saved.', { replaced: result.replaced }) : '',
      result.skipped ? t('{skipped} rows were already saved, so they were skipped.', { skipped: result.skipped }) : '',
      result.left ? t('{left} rows were left out because they failed a check.', { left: result.left }) : '',
    ].filter(Boolean).join(' ')
  }

  const save = async (body: object) => {
    setError(null)
    setBusy(true)
    try {
      const result = await api('/api/ingest/save', { body })
      setDone(`${words(result)}${result.problems?.length ? ` ${result.problems.map((problem: any) => `${problem.name}: ${t(problem.message)}`).join(' ')}` : ''}`)
      setPreview(null)
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }

  const cancel = () => { setPreview(null); setError(null) }
  const shared = { preview, onSave: save, onCancel: cancel }

  return (
    <Screen title={t('Import a file')} lead={t('Sales, recipes or a supplier price list. CSV, Excel, PDF, Word, text or a photo. You see a preview, and nothing is saved until you confirm.')}>
      {preview ? null : <Segment fill label={t('What this file holds')} value={kind} onChange={(value) => { setKind(value); setDone(null) }} options={[{ value: 'sales', label: t('Sales') }, { value: 'recipes', label: t('Recipes') }, { value: 'ingredients', label: t('Ingredients') }]} />}
      <ErrorNote message={error} />
      {done ? <p className="notice" role="status">{done}</p> : null}
      {preview ? (
        <section className="card arrive">
          <h2>{preview.file}</h2>
          <Notes notes={preview.checks} />
          {preview.kind === 'sales' ? <SalesPreview {...shared} /> : null}
          {preview.kind === 'ingredients' ? <PricePreview {...shared} /> : null}
          {preview.kind === 'recipes' ? <RecipePreview {...shared} onChanged={(recipes) => setPreview({ ...preview, recipes })} /> : null}
        </section>
      ) : null}
      <input ref={input} type="file" accept={FILES} hidden onChange={upload} />
      {preview ? null : <Dock><button className="btn primary block" type="button" disabled={busy} onClick={() => input.current?.click()}><UploadSimple size={24} aria-hidden="true" />{busy ? t('Reading') : t('Choose a file')}</button></Dock>}
    </Screen>
  )
}
