import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Camera, CookingPot, FileText, Plus, Trash } from '@phosphor-icons/react'
import { api, pounds } from '../api'
import { t, tn } from '../i18n'
import { Dock, Empty, ErrorNote, Loading, Screen, Sheet } from '../ui'

const BLANK = { name: '', pounds: '', targetMargin: '70', lines: [{ name: '', quantity: '', unit: 'g' }] }

const toForm = (dish: any) => ({
  ...dish, pounds: (dish.pricePence / 100).toFixed(2), targetMargin: String(dish.targetMargin),
  lines: dish.lines.length ? dish.lines.map((line: any) => ({ ...line, quantity: String(line.quantity) })) : BLANK.lines,
})

const toBody = (form: any) => ({ method: form.method, name: form.name, pricePence: Math.round(Number(form.pounds) * 100), targetMargin: Number(form.targetMargin), lines: form.lines.filter((line: any) => line.name.trim()).map((line: any) => ({ ...line, quantity: Number(line.quantity) })) })

const margin = (dish: any) => (dish.costPence === null ? null : Math.round(((dish.pricePence - dish.costPence) / dish.pricePence) * 100))

function DishSheet({ form, setForm, onClose, onSaved }: { form: any; setForm: (next: any) => void; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const photo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const data = new FormData()
    data.append('file', file)
    try { setForm({ ...form, photo: (await api(`/api/setup/dishes/${form.id}/photo`, { form: data })).photo }) } catch (problem) { setError((problem as Error).message) }
  }
  const line = (index: number, change: object) => setForm({ ...form, lines: form.lines.map((row: any, at: number) => (at === index ? { ...row, ...change } : row)) })
  const save = async () => {
    setError(null)
    try {
      await api(form.id ? `/api/setup/dishes/${form.id}` : '/api/setup/dishes', { method: form.id ? 'PUT' : 'POST', body: toBody(form) })
      onSaved()
    } catch (problem) { setError((problem as Error).message) }
  }
  const remove = async () => {
    setError(null)
    try {
      await api(`/api/setup/dishes/${form.id}`, { method: 'DELETE' })
      onSaved()
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <Sheet title={form.id ? form.name : t('Add a dish')} onClose={onClose}>
      <label className="field">{t('Dish')}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <div className="two">
        <label className="field">{t('Menu price (£)')}<input inputMode="decimal" className="num" value={form.pounds} onChange={(event) => setForm({ ...form, pounds: event.target.value })} /></label>
        <label className="field">{t('Target margin (%)')}<input inputMode="numeric" className="num" value={form.targetMargin} onChange={(event) => setForm({ ...form, targetMargin: event.target.value })} /></label>
      </div>
      <h3>{t('Recipe for one portion')}</h3>
      <ul className="recipe-lines">
        {form.lines.map((row: any, index: number) => (
          <li key={index}>
            <input aria-label={t('Ingredient')} placeholder={t('Ingredient')} value={row.name} onChange={(event) => line(index, { name: event.target.value })} />
            <input aria-label={t('Quantity')} placeholder={t('Qty')} inputMode="decimal" className="num" value={row.quantity} onChange={(event) => line(index, { quantity: event.target.value })} />
            <select aria-label={t('Unit')} value={row.unit} onChange={(event) => line(index, { unit: event.target.value })}>
              {['g', 'kg', 'ml', 'l', 'each'].map((unit) => <option key={unit} value={unit}>{unit === 'each' ? t('each') : unit}</option>)}
            </select>
            <button className="icon-btn" type="button" aria-label={t('Remove {name}', { name: row.name || t('Ingredient') })} onClick={() => setForm({ ...form, lines: form.lines.filter((_: any, at: number) => at !== index) })}><Trash size={20} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      <button className="btn text small" type="button" onClick={() => setForm({ ...form, lines: [...form.lines, { name: '', quantity: '', unit: 'g' }] })}><Plus size={20} aria-hidden="true" />{t('Add an ingredient')}</button>
      <label className="field">{t('How to make it')}<textarea rows={5} placeholder={t('Staff can read this on their phones.')} value={form.method ?? ''} onChange={(event) => setForm({ ...form, method: event.target.value })} /></label>
      {form.id ? <button className="btn text small" type="button" onClick={() => photoInput.current?.click()}><Camera size={20} aria-hidden="true" />{form.photo ? t('Change photo') : t('Add a photo')}</button> : <p className="caption">{t('You can add a photo after saving.')}</p>}
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={photo} />
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" onClick={save}>{t('Save')}</button>
      {form.id ? <button className="btn text block" type="button" onClick={remove}>{t('Remove this dish')}</button> : null}
    </Sheet>
  )
}

export function MenuSettings() {
  const [dishes, setDishes] = useState<any[] | null>(null)
  const [form, setForm] = useState<any>(null)
  const [read, setRead] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const load = () => api('/api/setup/dishes').then(setDishes).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setError(null)
    const data = new FormData()
    data.append('file', file)
    try {
      const found = await api<any[]>('/api/setup/menu/read', { form: data })
      setRead(found.map((dish) => ({ ...dish, pounds: dish.pricePence === null ? '' : (dish.pricePence / 100).toFixed(2), targetMargin: '70' })))
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }

  const saveRead = async () => {
    setError(null)
    try {
      for (const dish of read!) await api('/api/setup/dishes', { body: toBody({ ...dish, lines: dish.lines.filter((line: any) => line.quantity !== null) }) })
      setRead(null)
      await load()
    } catch (problem) { setError((problem as Error).message); await load() }
  }

  return (
    <Screen title={t('Menu and recipes')} lead={t('Recipes turn your supplier prices into food cost and margin.')}>
      {!form ? <ErrorNote message={error} /> : null}
      {!dishes && !error ? <Loading /> : null}
      {read ? (
        <section className="card arrive">
          <h2>{tn(read.length, 'Found {n} dish', 'Found {n} dishes')}</h2>
          <p className="muted">{t('Check the names and prices. Nothing is saved until you do.')}</p>
          <ul className="read-menu">
            {read.map((dish, index) => (
              <li key={index}>
                <input aria-label={t('Dish')} value={dish.name} onChange={(event) => setRead(read.map((row, at) => (at === index ? { ...row, name: event.target.value } : row)))} />
                <input aria-label={t('Menu price (£)')} placeholder="£" inputMode="decimal" className="num" value={dish.pounds} onChange={(event) => setRead(read.map((row, at) => (at === index ? { ...row, pounds: event.target.value } : row)))} />
              </li>
            ))}
          </ul>
          <button className="btn primary block" type="button" onClick={saveRead}>{t('Save these dishes')}</button>
          <button className="btn text block" type="button" onClick={() => setRead(null)}>{t('Cancel')}</button>
        </section>
      ) : null}
      {dishes?.length === 0 && !read ? <Empty title={t('No dishes yet.')}><p className="muted">{t('Upload your menu, or add dishes one at a time.')}</p></Empty> : null}
      {dishes?.length ? (
        <ul className="feature-list">
          {dishes.map((dish) => (
            <li key={dish.id}>
              <button className="feature-row" type="button" onClick={() => setForm(toForm(dish))}>
                <CookingPot size={24} aria-hidden="true" />
                <strong>{dish.name}</strong>
                <span className="note num">{pounds(dish.pricePence)}</span>
                <small>
                  {margin(dish) !== null ? t('{margin}% margin, target {target}%', { margin: margin(dish), target: dish.targetMargin })
                    : dish.lines.length ? t('Needs a price for {items}. It comes from your next receipt.', { items: dish.unpriced.join(', ') }) : t('No recipe yet.')}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={upload} />
      <Dock pair>
        <button className="btn primary block" type="button" disabled={busy} onClick={() => input.current?.click()}><FileText size={24} aria-hidden="true" />{busy ? t('Reading') : t('Upload menu')}</button>
        <button className="btn block" type="button" onClick={() => setForm({ ...BLANK })}><Plus size={24} aria-hidden="true" />{t('Add a dish')}</button>
      </Dock>
      {form ? <DishSheet form={form} setForm={setForm} onClose={() => setForm(null)} onSaved={() => { setForm(null); void load() }} /> : null}
    </Screen>
  )
}
