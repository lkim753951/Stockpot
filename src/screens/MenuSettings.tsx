import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Camera, CookingPot, FileText, Plus, Sparkle, Trash, UploadSimple } from '@phosphor-icons/react'
import { marginPercent, prepPerPortion, priceForMargin } from '../../shared/costing'
import { api, ApiError, niceDate, portionAmount, pounds } from '../lib/api'
import { t, tn } from '../lib/i18n'
import { Chip, Dock, Empty, ErrorNote, Loading, Screen, Segment, Sheet, Tile } from '../components/ui'
import { EstimatePanel, estimateDish, estimateLine } from '../components/Estimate'
import { inTurns, MENU_FILES, mergeDishes, readableImage, readEach, readMenuFile, type FileProblem } from '../lib/reading'

const BLANK = { name: '', pounds: '', targetMargin: '70', portions: '', prepMinutes: '', serviceMinutes: '', method: '', lines: [{ name: '', quantity: '', unit: 'g' }] }

const number = (value: unknown) => (value === null || value === undefined ? '' : String(value))

const toForm = (dish: any) => ({
  ...dish, pounds: (dish.pricePence / 100).toFixed(2), targetMargin: String(dish.targetMargin), portions: number(dish.portions), prepMinutes: number(dish.prepMinutes), serviceMinutes: number(dish.serviceMinutes),
  lines: dish.lines.length ? dish.lines.map((line: any) => ({ name: line.name, quantity: String(line.quantity), unit: line.unit })) : BLANK.lines,
})

const toBody = (form: any) => ({
  method: form.method, name: form.name, pricePence: Math.round(Number(form.pounds) * 100), targetMargin: Number(form.targetMargin),
  portions: form.portions === '' ? null : Number(form.portions), prepMinutes: form.prepMinutes === '' ? null : Number(form.prepMinutes), serviceMinutes: form.serviceMinutes === '' ? null : Number(form.serviceMinutes),
  lines: form.lines.filter((line: any) => line.name.trim()).map((line: any) => ({ name: line.name, unit: line.unit, quantity: Number(line.quantity) })),
})

/** Puts what a file said into the form. A saved dish keeps any figure the file leaves out, and Stockpot saves nothing yet. */
export const formFromRecipe = (recipe: any, dish: any, reading: object) => ({
  ...(dish ? toForm(dish) : BLANK),
  name: dish?.name ?? recipe.name,
  portions: number(recipe.portions ?? dish?.portions), prepMinutes: number(recipe.prepMinutes ?? dish?.prepMinutes), serviceMinutes: number(recipe.serviceMinutes ?? dish?.serviceMinutes),
  method: recipe.steps.length ? recipe.steps.join('\n') : dish?.method ?? '',
  lines: recipe.lines.map((line: any) => ({ ...line, quantity: number(line.quantity) })),
  reading: { flags: recipe.flags, prepQuote: recipe.prepQuote, serviceQuote: recipe.serviceQuote, batchKnown: !!recipe.portions, ...reading },
})

const Notes = ({ notes }: { notes: any[] }) => <>{notes.map((note, index) => <p className="notice" key={index}>{t(note.text, note.values)}</p>)}</>

const changeAmount = (amount: any) => (amount ? `${amount.quantity} ${amount.unit === 'each' ? t('each') : amount.unit}` : t('Not set'))

function Changes({ changes }: { changes: any[] }) {
  const fields: Record<string, string> = { portions: t('Portions'), prep: t('Prep time (minutes)'), service: t('Service time (minutes)'), method: t('How to make it') }
  if (!changes.length) return <p className="caption">{t('The file matches what is saved.')}</p>
  return (
    <section className="stack">
      <h3>{t('What would change')}</h3>
      <ul className="list">
        {changes.map((change, index) => (
          <li key={index}>
            <span>{change.kind === 'field' ? fields[change.name] : change.name}</span>
            <span className="num cost-cell">
              {change.kind === 'field' ? (change.to === null ? t('New wording') : `${change.from ?? t('Not set')} → ${change.to}`) : null}
              {change.kind === 'added' ? t('Added: {amount}', { amount: changeAmount(change.to) }) : null}
              {change.kind === 'removed' ? t('Removed') : null}
              {change.kind === 'changed' ? `${changeAmount(change.from)} → ${changeAmount(change.to)}` : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Margin moves as the owner types and nothing is saved. Every figure uses the same costing as the Dashboard. */
function CostPanel({ dish, onUsePrice }: { dish: any; onUsePrice: (pence: number) => Promise<void> }) {
  const [price, setPrice] = useState((dish.pricePence / 100).toFixed(2))
  const typed = Math.round(Number(price.replace(/[£\s]/g, '').replace(/,/g, '.')) * 100)
  const known = dish.exactCostPence !== null
  const margin = known && typed > 0 ? marginPercent(typed, dish.exactCostPence) : null
  return (
    <section className="stack" aria-label={t('Cost and margin')}>
      {dish.lines.length ? null : <p className="muted">{t('No recipe yet. Add the ingredients to see the cost.')}</p>}
      {dish.unpriced.length ? <p className="notice">{t('This cost is incomplete. It needs a price for {items}.', { items: dish.unpriced.join(', ') })}</p> : null}
      <div className="tiles">
        <Tile label={t('Food cost a portion')} value={known ? pounds(dish.costPence) : t('Incomplete')} note={!known && dish.knownCostPence ? t('At least {cost}', { cost: pounds(dish.knownCostPence) }) : undefined} />
        <Tile label={t('Margin')} value={margin === null ? t('Not known') : `${margin}%`} change={margin === null ? null : { text: t('Target {target}%', { target: dish.targetMargin }), good: margin >= dish.targetMargin, up: null, compare: '' }} />
      </div>
      <label className="field">{t('Try a menu price (£)')}<input inputMode="decimal" className="num" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
      <ul className="list">
        <li><span>{t('Menu price to hit your target')}</span><strong className="num">{dish.pricePenceForTarget === null ? t('Not known') : pounds(dish.pricePenceForTarget)}</strong></li>
        {known && dish.targetMargin !== 80 ? <li><span>{t('Menu price for an {margin}% margin', { margin: 80 })}</span><strong className="num">{pounds(priceForMargin(dish.exactCostPence, 80))}</strong></li> : null}
        <li>
          <span>{t('Prep time')}{dish.prepPerPortion ? <span className="when"><br />{t('{minutes} min a portion', { minutes: dish.prepPerPortion })}</span> : null}</span>
          <strong className="num">{dish.prepMinutes ? t('{minutes} min', { minutes: dish.prepMinutes }) : t('Not set')}</strong>
        </li>
        <li><span>{t('Service time')}</span><strong className="num">{dish.serviceMinutes ? t('{minutes} min a plate', { minutes: dish.serviceMinutes }) : t('Not set')}</strong></li>
      </ul>
      {dish.lines.length ? (
        <>
          <h3>{t('Ingredient costs for one portion')}</h3>
          <ul className="list">
            {dish.lines.map((line: any) => (
              <li key={line.name}>
                <span>{line.name}<span className="when"><br />{portionAmount(line)}{line.pricePence === null ? '' : `, ${t('{price} a {unit}', { price: pounds(line.pricePence), unit: line.unit === 'each' ? t('each') : line.unit })}`}{line.priceDate ? `, ${niceDate(line.priceDate)}` : ''}</span></span>
                {line.pricePence === null ? <Chip tone="attention">{t('No price yet')}</Chip> : <span className="num cost-cell"><strong>{line.costPence < 0.5 ? t('Under 1p') : pounds(line.costPence)}</strong>{line.sharePercent === null ? null : <span className="when"><br />{`${line.sharePercent}%`}</span>}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="caption">{t("This uses your saved recipe and the newest price paid, the same as the Dashboard. Labour isn't included, because Stockpot has no wage data, so prep and service time don't change the cost. Waste and other costs aren't included either.")}</p>
      {known ? null : <EstimatePanel dish={{ name: dish.name, pricePence: dish.pricePence, lines: dish.lines }} onUsePrice={onUsePrice} />}
    </section>
  )
}

const FILE_TYPES = 'application/pdf,image/jpeg,image/png,image/webp,text/plain,.pdf,.docx,.txt,.jpg,.jpeg,.png,.webp'
/** The recipe reader takes spreadsheets too, when they come in through Add a recipe. */
const RECIPE_FILES = `${FILE_TYPES},.csv,.xlsx`

export function DishSheet({ form, setForm, onClose, onSaved, dish }: { form: any; setForm: (next: any) => void; onClose: () => void; onSaved: (id: number, stay?: boolean) => void; dish?: any }) {
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState(form.id && !form.reading ? 'cost' : 'recipe')
  // Saving a file takes the owner from checking the recipe to seeing what it costs.
  useEffect(() => { setTab(form.id && !form.reading ? 'cost' : 'recipe') }, [form.reading])
  const [busy, setBusy] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [held, setHeld] = useState<string | null>(null)
  useEffect(() => {
    if (!form.heldPhoto) return setHeld(null)
    const url = URL.createObjectURL(form.heldPhoto)
    setHeld(url)
    return () => URL.revokeObjectURL(url)
  }, [form.heldPhoto])
  const photoSrc = held ?? (form.photo ? `/api/files/${form.photo}` : null)

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    return file
  }
  const pickPhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = chosen(event)
    if (file) setForm({ ...form, heldPhoto: file })
  }
  const read = async (request: () => Promise<any>, heldRecipe?: File) => {
    setBusy(true)
    setError(null)
    try {
      const found = await request()
      setForm({ ...formFromRecipe(found.recipe, dish, { notes: found.notes, changes: found.changes, more: found.more }), heldPhoto: form.heldPhoto, heldRecipe, id: form.id, photo: form.photo, recipeFileName: form.recipeFileName })
      setTab('recipe')
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = chosen(event)
    if (!picked) return
    const file = await readableImage(picked)
    const data = new FormData()
    data.append('dishId', String(form.id))
    data.append('file', file)
    void read(() => api('/api/setup/recipes/read', { form: data }), file)
  }
  /** The suggested price, saved on the dish as it stands. The recipe and everything else stay the same. */
  const usePrice = async (pence: number) => {
    await api(`/api/setup/dishes/${dish.id}`, { method: 'PUT', body: { ...toBody(toForm(dish)), pricePence: pence } })
    onSaved(dish.id, true)
  }
  const line = (index: number, change: object) => setForm({
    ...form,
    lines: form.lines.map((row: any, at: number) => {
      if (at !== index) return row
      const next = { ...row, ...change }
      return 'quantity' in change ? { ...next, batch: Number(next.quantity) * (Number(form.portions) || 1) } : next
    }),
  })
  /** Quantities from a file are worked out per portion, so a change to the portions carries through. */
  const setPortions = (portions: string) => {
    const lines = form.reading && Number(portions) > 0
      ? form.lines.map((row: any) => (row.batch ? { ...row, quantity: String(Number((row.batch / Number(portions)).toFixed(3))) } : row))
      : form.lines
    setForm({ ...form, portions, lines })
  }
  const [clash, setClash] = useState<{ name: string; to: string } | null>(null)
  /** The owner chose to measure this ingredient the recipe's way. Stockpot refuses if it already has prices. */
  const remeasure = async () => {
    setError(null)
    try {
      await api('/api/setup/items/unit', { body: { name: clash!.name, unit: clash!.to } })
      setClash(null)
      await save()
    } catch (problem) { setError((problem as Error).message) }
  }
  const save = async () => {
    setError(null)
    setClash(null)
    setBusy(true)
    try {
      const { id } = await api(form.id ? `/api/setup/dishes/${form.id}` : '/api/setup/dishes', { method: form.id ? 'PUT' : 'POST', body: toBody(form) })
      setForm({ ...form, id })
      if (form.heldRecipe || form.heldPhoto) {
        const data = new FormData()
        if (form.heldRecipe) data.append('recipe', form.heldRecipe)
        if (form.heldPhoto) data.append('photo', form.heldPhoto)
        await api(`/api/setup/dishes/${id}/files`, { form: data })
      }
      onSaved(id)
    } catch (problem) {
      setError((problem as Error).message)
      const values = (problem as ApiError).values
      if (values?.clash) setClash({ name: String(values.clash), to: String(values.to) })
    } finally { setBusy(false) }
  }
  const remove = async () => {
    setError(null)
    try {
      await api(`/api/setup/dishes/${form.id}`, { method: 'DELETE' })
      onSaved(form.id)
    } catch (problem) { setError((problem as Error).message) }
  }
  const { reading } = form
  return (
    <Sheet title={form.id ? form.name : t('Add a dish')} onClose={onClose}>
      {form.id && !reading ? <Segment fill label={t('Dish')} value={tab} onChange={setTab} options={[{ value: 'cost', label: t('Cost and margin') }, { value: 'recipe', label: t('Recipe') }]} /> : null}
      {tab === 'cost' ? <CostPanel key={`${dish?.id}-${dish?.pricePence}`} dish={dish} onUsePrice={usePrice} /> : (
        <>
          {reading ? (
            <>
              <p className="muted">{t('Check everything. Nothing is saved until you press Save.')}</p>
              <Notes notes={[...reading.notes, ...reading.flags]} />
              {reading.more ? <p className="notice">{tn(reading.more, 'This file holds {n} more recipe. Use Import a file in Settings to read them all.', 'This file holds {n} more recipes. Use Import a file in Settings to read them all.')}</p> : null}
              {form.id ? <Changes changes={reading.changes} /> : null}
            </>
          ) : null}
          <label className="field">{t('Dish')}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <div className="two">
            <label className="field">{t('Menu price (£)')}<input inputMode="decimal" className="num" value={form.pounds} onChange={(event) => setForm({ ...form, pounds: event.target.value })} /></label>
            <label className="field">{t('Target margin (%)')}<input inputMode="numeric" className="num" value={form.targetMargin} onChange={(event) => setForm({ ...form, targetMargin: event.target.value })} /></label>
          </div>
          <label className="field">{t('Portions this recipe makes')}<input inputMode="numeric" className="num" value={form.portions} onChange={(event) => setPortions(event.target.value)} /></label>
          <div className="two">
            <label className="field">{t('Prep time (minutes)')}<input inputMode="numeric" className="num" value={form.prepMinutes} onChange={(event) => setForm({ ...form, prepMinutes: event.target.value })} /></label>
            <label className="field">{t('Service time (minutes)')}<input inputMode="numeric" className="num" value={form.serviceMinutes} onChange={(event) => setForm({ ...form, serviceMinutes: event.target.value })} /></label>
          </div>
          <p className="caption">{t('Prep time is for the whole recipe. Service time is for one plate. Labour isn\'t included in the cost.')}</p>
          {prepPerPortion(Number(form.prepMinutes), Number(form.portions)) ? <p className="caption">{t('{minutes} min a portion', { minutes: prepPerPortion(Number(form.prepMinutes), Number(form.portions))! })}</p> : null}
          {reading?.prepQuote ? <p className="caption">{t('Prep, from the file: {words}', { words: reading.prepQuote })}</p> : null}
          {reading?.serviceQuote ? <p className="caption">{t('Service, from the file: {words}', { words: reading.serviceQuote })}</p> : null}
          <h3>{t('Recipe for one portion')}</h3>
          <ul className="recipe-lines">
            {form.lines.map((row: any, index: number) => (
              <li key={index}>
                <input aria-label={t('Ingredient')} placeholder={t('Ingredient')} value={row.name} onChange={(event) => line(index, { name: event.target.value })} />
                <input aria-label={t('Quantity')} placeholder={t('Qty')} inputMode="decimal" className="num" value={row.quantity} onChange={(event) => line(index, { quantity: event.target.value })} />
                <select aria-label={t('Unit')} value={row.unit} onChange={(event) => line(index, { unit: event.target.value })}>
                  {row.unit ? null : <option value="">{t('Unit')}</option>}
                  {['g', 'kg', 'ml', 'l', 'each'].map((unit) => <option key={unit} value={unit}>{unit === 'each' ? t('each') : unit}</option>)}
                </select>
                <button className="icon-btn" type="button" aria-label={t('Remove {name}', { name: row.name || t('Ingredient') })} onClick={() => setForm({ ...form, lines: form.lines.filter((_: any, at: number) => at !== index) })}><Trash size={20} aria-hidden="true" /></button>
                {row.flags?.length || row.noPrice ? (
                  <div className="line-note">
                    {row.noPrice ? <Chip tone="neutral">{t('No price yet')}</Chip> : null}
                    {row.flags?.map((flag: any, at: number) => <p className="caption" key={at}>{t(flag.text, flag.values)}</p>)}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <button className="btn text small" type="button" onClick={() => setForm({ ...form, lines: [...form.lines, { name: '', quantity: '', unit: 'g' }] })}><Plus size={20} aria-hidden="true" />{t('Add an ingredient')}</button>
          {form.id && !reading ? null : (
            <EstimatePanel
              dish={{ name: form.name, pricePence: Math.round(Number(String(form.pounds).replace(/[£\s]/g, '').replace(/,/g, '.')) * 100) || null, lines: form.lines }}
              onUsePrice={(pence) => setForm({ ...form, pounds: (pence / 100).toFixed(2) })}
              onUseRecipe={(lines) => setForm({ ...form, lines })}
            />
          )}
          <label className="field">{t('How to make it')}<textarea rows={5} placeholder={t('One step on each line. Staff can read this on their phones.')} value={form.method ?? ''} onChange={(event) => setForm({ ...form, method: event.target.value })} /></label>
          {photoSrc ? <img className="evidence dish-photo" src={photoSrc} alt={form.name} /> : null}
          <button className="btn text small" type="button" onClick={() => photoInput.current?.click()}><Camera size={20} aria-hidden="true" />{photoSrc ? t('Change photo') : t('Add a photo')}</button>
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pickPhoto} />
          {form.heldRecipe ? <p className="caption">{t('Recipe file: {name}', { name: form.heldRecipe.name })}</p> : null}
          {!form.heldRecipe && form.recipeFileName ? <a className="btn text small" href={`/api/files/${dish?.recipeFile}`} target="_blank" rel="noreferrer"><FileText size={20} aria-hidden="true" />{form.recipeFileName}</a> : null}
          {form.id ? (
            <div className="card-actions">
              <button className="btn text small" type="button" disabled={busy} onClick={() => fileInput.current?.click()}><UploadSimple size={20} aria-hidden="true" />{form.recipeFileName ? t('Use a new recipe file') : t('Add a recipe file')}</button>
              {form.recipeFileName && !form.heldRecipe ? <button className="btn text small" type="button" disabled={busy} onClick={() => read(() => api(`/api/setup/dishes/${form.id}/read-again`, { method: 'POST' }))}>{busy ? t('Reading') : t('Read the file again')}</button> : null}
            </div>
          ) : null}
          <input ref={fileInput} type="file" accept={FILE_TYPES} hidden onChange={pickFile} />
          <ErrorNote message={error} />
          {clash ? <button className="btn block" type="button" disabled={busy} onClick={remeasure}>{t('Measure {name} in {units} from now on, and save', { name: clash.name, units: clash.to === 'each' ? t('each') : clash.to === 'kg' ? 'g / kg' : 'ml / l' })}</button> : null}
          <button className="btn primary block" type="button" disabled={busy} onClick={save}>{t('Save')}</button>
          {form.id ? <button className="btn text block" type="button" onClick={remove}>{t('Remove this dish')}</button> : null}
        </>
      )}
      {tab === 'cost' ? <ErrorNote message={error} /> : null}
    </Sheet>
  )
}

const needsWork = (recipe: any) => recipe.lines.some((line: any) => line.flags.length) || !recipe.lines.length

/** Several recipes at once, from one file or many. Each can be checked on its own, and only ready ones are saved. */
export function RecipePreview({ preview, onSave, onCancel, onChanged }: { preview: any; onSave: (body: object) => void; onCancel: () => void; onChanged: (recipes: any[]) => void }) {
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

const Problems = ({ problems }: { problems: FileProblem[] }) => (problems.length ? (
  <div className="error stack" role="alert">
    {problems.map((problem, index) => <p key={index}><strong>{problem.file}</strong>: {problem.message}</p>)}
  </div>
) : null)

/** Reads every file the owner picks. One recipe opens on its own, and several are shown together to check. */
function AddRecipe({ sample, onRead, onMany, onClose }: { sample: boolean; onRead: (found: any, file: File, photo: File | null) => void; onMany: (preview: any) => void; onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<FileProblem[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const read = async (chosen: File[], image: File | null) => {
    const { found, problems } = await readEach(chosen, (file) => {
      const data = new FormData()
      data.append('kind', 'recipes')
      data.append('file', file)
      return api('/api/ingest/read', { form: data }).then((preview) => ({ preview, file }))
    })
    setProblems(problems)
    // The same dish in two files is shown once, as the last file has it.
    const byName = new Map<string, any>()
    for (const { result } of found) for (const recipe of result.preview.recipes) byName.set(recipe.name.trim().toLowerCase(), recipe)
    const recipes = [...byName.values()]
    const checks = found.flatMap(({ file, result }) => result.preview.checks.filter((note: any) => note.text !== 'Stockpot found nothing to import in this file.').map((note: any) => (found.length > 1 ? { ...note, text: `${file}: ${t(note.text, note.values)}`, values: undefined } : note)))
    if (!recipes.length) {
      if (!problems.length) setError(t('Stockpot found no recipe in that file.'))
      return
    }
    if (recipes.length === 1 && found.length === 1 && !problems.length) {
      const [recipe] = recipes
      return onRead({ recipe, notes: checks, changes: recipe.changes, dishId: recipe.dishId, more: 0 }, found[0].result.file, image)
    }
    onMany({ recipes, checks, problems })
  }
  const go = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setProblems([])
    try { await work() } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const trySample = () => go(async () => {
    const [pdf, png] = await Promise.all(['sample-recipe.pdf', 'sample-dish.png'].map(async (name) => new File([await (await fetch(`/samples/${name}`)).blob()], name)))
    await read([pdf], png)
  })
  const label = files.length === 1 ? files[0].name : t('Choose the recipe file')
  return (
    <Sheet title={t('Add a recipe')} onClose={onClose}>
      <p className="muted">{t('Upload PDFs, photos, Word or text files. You can choose several at once. Stockpot reads them and you check them. Nothing is saved until you do.')}</p>
      <button className="btn block" type="button" onClick={() => fileInput.current?.click()}><UploadSimple size={24} aria-hidden="true" />{label}</button>
      {files.length > 1 ? <ul className="list">{files.map((file, index) => <li key={index}><span>{file.name}</span><button className="icon-btn" type="button" aria-label={t('Remove {name}', { name: file.name })} onClick={() => setFiles(files.filter((_, at) => at !== index))}><Trash size={20} aria-hidden="true" /></button></li>)}</ul> : null}
      {files.length > 1 ? null : <button className="btn block" type="button" onClick={() => photoInput.current?.click()}><Camera size={24} aria-hidden="true" />{photo ? photo.name : t('Add a dish photo (optional)')}</button>}
      <input ref={fileInput} type="file" multiple accept={RECIPE_FILES} hidden onChange={(event) => { const picked = [...(event.target.files ?? [])]; setFiles(picked.length ? [...files, ...picked].slice(0, 20) : files); event.target.value = '' }} />
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { setPhoto(event.target.files?.[0] ?? null); event.target.value = '' }} />
      <ErrorNote message={error} />
      <Problems problems={problems} />
      <button className="btn primary block" type="button" disabled={!files.length || busy} onClick={() => go(() => read(files, files.length > 1 ? null : photo))}>{busy ? t('Reading') : files.length > 1 ? t('Read the recipes') : t('Read the recipe')}</button>
      {sample ? <button className="btn text block" type="button" disabled={busy} onClick={trySample}>{t('Try the sample recipe')}</button> : null}
    </Sheet>
  )
}

export function MenuSettings({ sample = false }: { sample?: boolean }) {
  const [dishes, setDishes] = useState<any[] | null>(null)
  const [form, setForm] = useState<any>(null)
  const [adding, setAdding] = useState(false)
  const [read, setRead] = useState<any[] | null>(null)
  const [many, setMany] = useState<any>(null)
  const [problems, setProblems] = useState<FileProblem[]>([])
  const [done, setDone] = useState<string | null>(null)
  const [estimates, setEstimates] = useState<Record<number, any>>({})
  const [estimating, setEstimating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const load = () => api<any[]>('/api/setup/dishes').then((rows) => { setDishes(rows); return rows }).catch((e) => { setError(e.message); return [] as any[] })
  useEffect(() => { void load() }, [])

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, 20)
    event.target.value = ''
    if (!files.length) return
    setBusy(true)
    setError(null)
    setDone(null)
    const { found, problems } = await readEach(files, readMenuFile)
    setProblems(problems)
    const dishesRead = found.flatMap(({ result }) => result)
    if (found.length && !dishesRead.length) setError(t('Stockpot found no dishes in that menu.'))
    if (dishesRead.length) setRead(mergeDishes(read ?? [], dishesRead.map((dish) => ({ ...dish, pounds: dish.pricePence === null ? '' : (dish.pricePence / 100).toFixed(2), targetMargin: '70', portions: '', prepMinutes: '', serviceMinutes: '' }))))
    setBusy(false)
  }

  /** Each dish is saved on its own. One that can't be saved stays on the list with the reason, and the rest go in. */
  const saveRead = async () => {
    setError(null)
    setBusy(true)
    const left: any[] = []
    for (const dish of read!) {
      try { await api('/api/setup/dishes', { body: toBody({ ...dish, lines: dish.lines.filter((line: any) => line.quantity !== null) }) }) } catch (problem) { left.push({ ...dish, problem: (problem as Error).message }) }
    }
    setRead(left.length ? left : null)
    await load()
    setBusy(false)
  }

  const recipeRead = (found: any, file: File, photo: File | null) => {
    const saved = dishes?.find((dish) => dish.id === found.dishId)
    setForm({ ...formFromRecipe(found.recipe, saved, { notes: found.notes, changes: found.changes, more: found.more }), id: saved?.id, photo: saved?.photo, recipeFileName: saved?.recipeFileName, heldRecipe: file, heldPhoto: photo })
    setAdding(false)
  }

  const saveMany = async (body: object) => {
    setError(null)
    try {
      const result = await api('/api/ingest/save', { body })
      setDone(`${tn(result.saved, 'Saved {n} recipe.', 'Saved {n} recipes.')}${result.problems?.length ? ` ${result.problems.map((problem: any) => `${problem.name}: ${t(problem.message, problem.values)}`).join(' ')}` : ''}`)
      setMany(null)
      await load()
    } catch (problem) { setError((problem as Error).message) }
  }

  /** After a file is saved, the owner lands on the cost, which is why they added it. A new price keeps the dish open. */
  const saved = async (id: number, stay = false) => {
    const fromFile = !!form?.reading
    const rows = await load()
    const dish = rows.find((row) => row.id === id)
    setEstimates((current) => { const { [id]: _gone, ...rest } = current; return rest })
    setForm((fromFile || stay) && dish ? toForm(dish) : null)
  }

  const missing = (dishes ?? []).filter((dish) => dish.marginPercent === null)
  const estimateAll = async () => {
    setEstimating(true)
    await inTurns(missing, async (dish) => {
      const result = await estimateDish({ name: dish.name, pricePence: dish.pricePence, lines: dish.lines }).catch((problem) => ({ error: (problem as Error).message }))
      setEstimates((current) => ({ ...current, [dish.id]: result }))
    })
    setEstimating(false)
  }

  return (
    <Screen title={t('Menu and recipes')} lead={t('Recipes turn your supplier prices into food cost and margin.')}>
      {!form ? <ErrorNote message={error} /> : null}
      <Problems problems={problems} />
      {done ? <p className="notice" role="status">{done}</p> : null}
      {!dishes && !error ? <Loading /> : null}
      {read ? (
        <section className="card arrive">
          <h2>{tn(read.length, 'Found {n} dish', 'Found {n} dishes')}</h2>
          <p className="muted">{t('Check the names and prices. Nothing is saved until you do.')}</p>
          <ul className="read-menu">
            {read.map((dish, index) => (
              <li key={index}>
                <input aria-label={t('Dish')} value={dish.name} onChange={(event) => setRead(read.map((row, at) => (at === index ? { ...row, name: event.target.value, problem: null } : row)))} />
                <input aria-label={t('Menu price (£)')} placeholder="£" inputMode="decimal" className="num" value={dish.pounds} onChange={(event) => setRead(read.map((row, at) => (at === index ? { ...row, pounds: event.target.value, problem: null } : row)))} />
                {dish.notes?.length || dish.problem ? (
                  <div className="line-note">
                    {dish.notes?.map((note: any, at: number) => <p className="caption" key={at}>{t(note.text, note.values)}</p>)}
                    {dish.problem ? <p className="error" role="alert">{dish.problem}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <button className="btn primary block" type="button" disabled={busy} onClick={saveRead}>{t('Save these dishes')}</button>
          <button className="btn text block" type="button" onClick={() => setRead(null)}>{t('Cancel')}</button>
        </section>
      ) : null}
      {many ? (
        <section className="card arrive">
          <h2>{t('Check these recipes')}</h2>
          <Notes notes={many.checks} />
          <Problems problems={many.problems} />
          <RecipePreview preview={many} onSave={saveMany} onCancel={() => setMany(null)} onChanged={(recipes) => { setMany(recipes.length ? { ...many, recipes } : null); void load() }} />
        </section>
      ) : null}
      <button className="btn primary block" type="button" onClick={() => setAdding(true)}><FileText size={24} aria-hidden="true" />{t('Add a recipe')}</button>
      {dishes?.length === 0 && !read ? <Empty title={t('No dishes yet.')}><p className="muted">{t('Upload your menu, or add dishes one at a time.')}</p></Empty> : null}
      {missing.length ? (
        <button className="btn block" type="button" disabled={estimating} onClick={estimateAll}><Sparkle size={24} aria-hidden="true" />{estimating ? t('Estimating') : t('Estimate costs and prices with AI')}</button>
      ) : null}
      {dishes?.length ? (
        <ul className="feature-list">
          {dishes.map((dish) => (
            <li key={dish.id}>
              <button className="feature-row" type="button" onClick={() => setForm(toForm(dish))}>
                <CookingPot size={24} aria-hidden="true" />
                <strong>{dish.name}</strong>
                <span className="note num">{pounds(dish.pricePence)}</span>
                <small>
                  {dish.marginPercent !== null ? t('{margin}% margin, target {target}%', { margin: dish.marginPercent, target: dish.targetMargin })
                    : dish.lines.length ? t('Needs a price for {items}. It comes from your next receipt.', { items: dish.unpriced.join(', ') }) : t('No recipe yet.')}
                  {estimates[dish.id] ? <><br />{estimates[dish.id].error ?? estimateLine(estimates[dish.id])}</> : null}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input ref={input} type="file" multiple accept={MENU_FILES} hidden onChange={upload} />
      <Dock pair>
        <button className="btn block" type="button" disabled={busy} onClick={() => input.current?.click()}><FileText size={24} aria-hidden="true" />{busy ? t('Reading') : t('Upload menu')}</button>
        <button className="btn block" type="button" onClick={() => setForm({ ...BLANK })}><Plus size={24} aria-hidden="true" />{t('Add a dish')}</button>
      </Dock>
      {adding ? <AddRecipe sample={sample} onRead={recipeRead} onMany={(preview) => { setMany(preview); setAdding(false) }} onClose={() => setAdding(false)} /> : null}
      {form ? <DishSheet form={form} setForm={setForm} dish={dishes?.find((dish) => dish.id === form.id)} onClose={() => setForm(null)} onSaved={saved} /> : null}
    </Screen>
  )
}
