import { useCallback, useEffect, useState } from 'react'
import { CaretRight, CheckCircle, Copy, EnvelopeSimple, Plus, Truck } from '@phosphor-icons/react'
import { api, niceDate, pounds } from '../lib/api'
import { t, tn } from '../lib/i18n'
import { CATEGORIES } from '../lib/categories'
import { Chip, Empty, ErrorNote, Loading, Screen, Segment, Sheet } from '../components/ui'

type Tab = 'list' | 'suppliers' | 'dishes'

/** Seconds between quiet refreshes while the list is open, so a recipe changed on another phone shows up here. */
const REFRESH_MS = 30000

const amount = (quantity: number, unit: string) => (unit === 'each' ? `${Number(quantity.toFixed(2))} ${t('each')}` : quantity < 1 ? `${Math.round(quantity * 1000)} ${unit === 'kg' ? 'g' : 'ml'}` : `${Number(quantity.toFixed(2))} ${unit}`)
const caseWords = (item: any) => (item.cases ? tn(item.cases, '{n} case of {size}', '{n} cases of {size}', { size: amount(item.caseQty, item.unit) }) : null)

function useShopping() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => api('/api/shopping').then((next) => { setData(next); setError(null) }).catch((e) => setError(e.message)), [])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, REFRESH_MS)
    const back = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back) }
  }, [load])
  return { data, setData, error, setError, load }
}

/** Why this amount: what the recipes use, the spare on top, and the case size it is rounded up to. */
function ItemSheet({ item, data, onClose, onChange }: { item: any; data: any; onClose: () => void; onChange: (next: any) => void }) {
  const [error, setError] = useState<string | null>(null)
  const set = async (body: object) => {
    setError(null)
    try { onChange(await api(`/api/shopping/items/${item.id}`, { body })) } catch (problem) { setError((problem as Error).message) }
  }
  const from = { set: t('You chose this supplier.'), last: t('They sold it to you last.'), category: t('They sell this kind of thing.') }[item.supplierSource as string]
  return (
    <Sheet title={item.name} onClose={onClose}>
      <ul className="list">
        <li><span>{t('Your recipes use a week')}</span><strong className="num">{amount(item.need / (1 + data.spare / 100), item.unit)}</strong></li>
        <li><span>{t('With {spare}% spare', { spare: data.spare })}</span><strong className="num">{amount(item.need, item.unit)}</strong></li>
        <li><span>{t('To order')}</span><strong className="num">{amount(item.order, item.unit)}{item.cases ? <span className="when"><br />{caseWords(item)}</span> : null}</strong></li>
        {item.costPence !== null ? <li><span>{t('About')}</span><strong className="num">{pounds(item.costPence)}</strong></li> : null}
      </ul>
      <p className="caption">{t('For {dishes}.', { dishes: item.dishes.join(', ') })}</p>
      {item.missing.length ? <p className="notice">{t('{dishes} has no portions a week yet, so it is not counted.', { dishes: item.missing.join(', ') })}</p> : null}
      <label className="field">{t('Supplier')}
        <select value={item.supplierSource === 'set' ? String(item.supplierId) : ''} onChange={(event) => set({ supplierId: event.target.value || null })}>
          <option value="">{item.supplierSource && item.supplierSource !== 'set' ? t('Automatic: {name}', { name: data.suppliers.find((s: any) => s.id === item.supplierId)?.name ?? '' }) : t('Not chosen')}</option>
          {data.suppliers.map((supplier: any) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
        </select>
      </label>
      {from ? <p className="caption">{from}</p> : null}
      <label className="field">{t('What it is')}
        <select value={item.category} onChange={(event) => set({ category: event.target.value })}>
          {CATEGORIES.map((category) => <option key={category} value={category}>{t(category)}</option>)}
        </select>
      </label>
      <ErrorNote message={error} />
    </Sheet>
  )
}

function ListTab({ data, onOpen, onDishes }: { data: any; onOpen: (item: any) => void; onDishes: () => void }) {
  const toBuy = data.items.filter((item: any) => item.order > 0)
  const missing = data.dishes.filter((dish: any) => dish.hasRecipe && dish.portions === null)
  const supplierName = (id: number | null) => data.suppliers.find((supplier: any) => supplier.id === id)?.name ?? t('No supplier yet')
  return (
    <>
      {missing.length ? (
        <button className="notice action-notice" type="button" onClick={onDishes}>
          <span>{t('Add how many you sell a week for {dishes}, and their ingredients join the list.', { dishes: missing.map((dish: any) => dish.name).join(', ') })}</span>
          <CaretRight size={20} aria-hidden="true" />
        </button>
      ) : null}
      {toBuy.length ? (
        <section className="shop-total" aria-label={t('This week')}>
          <span className="tile-label">{t('This week')}</span>
          <strong className="num">{data.total.pence ? pounds(data.total.pence) : tn(toBuy.length, '{n} ingredient', '{n} ingredients')}</strong>
          <span className="caption">
            {data.total.pence ? tn(toBuy.length, '{n} ingredient, with {spare}% spare.', '{n} ingredients, with {spare}% spare.', { spare: data.spare }) : t('With {spare}% spare.', { spare: data.spare })}
            {data.total.unpriced && data.total.pence ? ` ${tn(data.total.unpriced, '{n} has no price yet.', '{n} have no price yet.')}` : ''}
          </span>
        </section>
      ) : null}
      {CATEGORIES.map((category) => {
        const rows = toBuy.filter((item: any) => item.category === category)
        if (!rows.length) return null
        return (
          <section className="stack shop-group" key={category}>
            <h3>{t(category)} <span className="num muted">{rows.length}</span></h3>
            <ul className="shop-list">
              {rows.map((item: any) => (
                <li key={item.id}>
                  <button type="button" className="shop-row" onClick={() => onOpen(item)}>
                    <span className="shop-name">{item.name}<small>{supplierName(item.supplierId)}</small></span>
                    <span className="shop-qty num">{amount(item.order, item.unit)}{item.cases ? <small>{caseWords(item)}</small> : null}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}

const BLANK_SUPPLIER = { name: '', contact: '', email: '', phone: '', category: '' }

function SupplierSheet({ supplier, onClose, onSaved }: { supplier: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ ...BLANK_SUPPLIER, ...supplier })
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    try {
      await api(form.id ? `/api/setup/suppliers/${form.id}` : '/api/setup/suppliers', { method: form.id ? 'PUT' : 'POST', body: form })
      onSaved()
    } catch (problem) { setError((problem as Error).message) }
  }
  const field = (key: string, label: string, type = 'text') => (
    <label className="field" key={key}>{label}<input type={type} value={(form as any)[key] ?? ''} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>
  )
  return (
    <Sheet title={form.id ? form.name : t('Add a supplier')} onClose={onClose}>
      {field('name', t('Name'))}
      <label className="field">{t('What they sell')}
        <select value={form.category ?? ''} onChange={(event) => setForm({ ...form, category: event.target.value })}>
          <option value="">{t('Not chosen')}</option>
          {CATEGORIES.map((category) => <option key={category} value={category}>{t(category)}</option>)}
        </select>
      </label>
      <p className="caption">{t('Ingredients of this kind go to them, unless you choose another supplier for one.')}</p>
      {field('contact', t('Contact person'))}
      {field('email', t('Email'), 'email')}
      {field('phone', t('Phone'), 'tel')}
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" onClick={save}>{t('Save')}</button>
    </Sheet>
  )
}

/** The owner reads the order before it goes. It is in English, because it goes to the supplier. */
function OrderSheet({ supplierId, onClose }: { supplierId: number; onClose: () => void }) {
  const [email, setEmail] = useState<any>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'copied'>('idle')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api(`/api/shopping/order/${supplierId}`).then(setEmail).catch((e) => setError(e.message)) }, [supplierId])
  const send = async () => {
    setState('sending')
    setError(null)
    try { await api(`/api/shopping/order/${supplierId}/send`, { body: email }); setState('sent') } catch (problem) { setError((problem as Error).message); setState('idle') }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(email.body); setState('copied') } catch { setError(t("That didn't work. Try again.")) }
  }
  return (
    <Sheet title={t('Order email')} onClose={onClose}>
      <ErrorNote message={error} />
      {!email && !error ? <Loading /> : null}
      {email ? (
        <>
          <label className="field">{t('To')}<input type="email" value={email.to} onChange={(event) => setEmail({ ...email, to: event.target.value })} /></label>
          <label className="field">{t('Subject')}<input value={email.subject} onChange={(event) => setEmail({ ...email, subject: event.target.value })} /></label>
          <label className="field">{t('Message')}<textarea rows={10} value={email.body} onChange={(event) => setEmail({ ...email, body: event.target.value })} /></label>
          {state === 'sent' ? <p className="notice" role="status"><CheckCircle size={20} aria-hidden="true" />{t('Sent.')}</p> : null}
          {state === 'copied' ? <p className="notice" role="status"><CheckCircle size={20} aria-hidden="true" />{t('Copied. Paste it into WhatsApp or a text.')}</p> : null}
          {email.gmail ? <button className="btn primary block" type="button" disabled={state === 'sending' || state === 'sent'} onClick={send}><EnvelopeSimple size={24} aria-hidden="true" />{state === 'sending' ? t('Sending') : t('Send with Gmail')}</button> : null}
          <a className={`btn${email.gmail ? '' : ' primary'} block`} href={`mailto:${email.to}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}>{t('Open in email')}</a>
          <button className="btn text block" type="button" onClick={copy}><Copy size={22} aria-hidden="true" />{t('Copy the order')}</button>
        </>
      ) : null}
    </Sheet>
  )
}

function SuppliersTab({ data, onOpen, onChange }: { data: any; onOpen: (item: any) => void; onChange: () => void }) {
  const [editing, setEditing] = useState<any>(null)
  const [ordering, setOrdering] = useState<number | null>(null)
  const item = (id: number) => data.items.find((row: any) => row.id === id)
  const unassigned = data.unassigned.map(item)
  return (
    <>
      {unassigned.length ? (
        <article className="card supplier-card attention">
          <div className="supplier-head"><strong>{t('No supplier yet')}</strong><Chip tone="attention">{tn(unassigned.length, '{n} ingredient', '{n} ingredients')}</Chip></div>
          <p className="caption">{t('Choose who sells these, or give a supplier the matching kind of thing.')}</p>
          <ul className="shop-list">
            {unassigned.map((row: any) => (
              <li key={row.id}><button type="button" className="shop-row" onClick={() => onOpen(row)}><span className="shop-name">{row.name}<small>{t(row.category)}</small></span><span className="shop-qty num">{amount(row.order, row.unit)}</span></button></li>
            ))}
          </ul>
        </article>
      ) : null}
      {data.suppliers.map((supplier: any) => {
        const rows = supplier.items.map(item)
        return (
          <article className="card supplier-card" key={supplier.id}>
            <div className="supplier-head">
              <strong>{supplier.name}</strong>
              {supplier.category ? <Chip tone="plain">{t(supplier.category)}</Chip> : <Chip tone="off">{t('Kind not set')}</Chip>}
            </div>
            <p className="caption">{[supplier.contact, supplier.phone, supplier.email].filter(Boolean).join(' · ') || t('No contact details yet.')}</p>
            {rows.length ? (
              <ul className="shop-list">
                {rows.map((row: any) => (
                  <li key={row.id}><button type="button" className="shop-row" onClick={() => onOpen(row)}><span className="shop-name">{row.name}{row.cases ? <small>{caseWords(row)}</small> : null}</span><span className="shop-qty num">{amount(row.order, row.unit)}</span></button></li>
                ))}
              </ul>
            ) : <p className="muted">{t('Nothing to order from them this week.')}</p>}
            <div className="supplier-foot">
              {supplier.total.pence ? <span className="num">{t('About {total}', { total: pounds(supplier.total.pence) })}</span> : <span />}
              <div className="card-actions">
                <button className="btn text small" type="button" onClick={() => setEditing(supplier)}>{t('Edit details')}</button>
                {rows.length ? <button className="btn small primary" type="button" onClick={() => setOrdering(supplier.id)}><EnvelopeSimple size={20} aria-hidden="true" />{t('Order')}</button> : null}
              </div>
            </div>
          </article>
        )
      })}
      <button className="btn block" type="button" onClick={() => setEditing({ ...BLANK_SUPPLIER })}><Plus size={24} aria-hidden="true" />{t('Add a supplier')}</button>
      {editing ? <SupplierSheet supplier={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange() }} /> : null}
      {ordering !== null ? <OrderSheet supplierId={ordering} onClose={() => setOrdering(null)} /> : null}
    </>
  )
}

function DishesTab({ data, onChange }: { data: any; onChange: (next: any) => void }) {
  const [typed, setTyped] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const save = async (dish: any) => {
    const value = typed[dish.id]
    if (value === undefined) return
    setError(null)
    try {
      onChange(await api(`/api/shopping/portions/${dish.id}`, { body: { portions: value.trim() === '' ? null : Number(value) } }))
      setTyped(({ [dish.id]: _done, ...rest }) => rest)
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <>
      <p className="muted">{t('How many of each dish you sell in a week. Stockpot starts from your last {weeks} weeks of sales, and you can change any number.', { weeks: data.salesWeeks })}</p>
      <ErrorNote message={error} />
      <ul className="shop-list">
        {data.dishes.map((dish: any) => (
          <li key={dish.id} className="dish-week">
            <span className="shop-name">{dish.name}
              <small>{!dish.hasRecipe ? t('No recipe yet, so nothing to buy.') : dish.source === 'sales' ? `${t('From your sales')}, ${niceDate(data.sales.from)} – ${niceDate(data.sales.to)}` : dish.source === 'set' ? t('You set this') : t('Not set yet')}</small>
            </span>
            <input aria-label={t('Portions a week for {dish}', { dish: dish.name })} className="num" inputMode="numeric" placeholder="0"
              value={typed[dish.id] ?? (dish.portions ?? '')} onChange={(event) => setTyped({ ...typed, [dish.id]: event.target.value.replace(/[^\d]/g, '') })}
              onBlur={() => save(dish)} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }} />
          </li>
        ))}
      </ul>
      {data.dishes.some((dish: any) => !dish.hasRecipe) ? <a className="link-btn" href="#/settings/menu">{t('Add recipes in Menu and recipes')}</a> : null}
      <FromReceipts data={data} onChange={onChange} />
    </>
  )
}

/** What the receipts say each dish sells. A suggestion only: the owner presses the button to use it. */
function FromReceipts({ data, onChange }: { data: any; onChange: (next: any) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const estimate = data.fromPurchases
  if (!estimate) return <p className="caption">{t('Add receipts, and Stockpot can estimate dishes a week from what you bought.')}</p>
  const rows = estimate.dishes.map((row: any) => ({ ...row, dish: data.dishes.find((dish: any) => dish.id === row.id) })).filter((row: any) => row.dish)
  const differs = rows.some((row: any) => row.portions !== null && row.portions !== row.dish.portions)
  const use = async () => {
    setBusy(true)
    setError(null)
    try { onChange(await api('/api/shopping/portions-from-receipts', { method: 'POST' })) } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  return (
    <section className="stack" aria-label={t('Estimated from your past orders')}>
      <h3>{t('Estimated from your past orders')}</h3>
      <p className="caption">{tn(estimate.receipts, '{n} receipt from {from} to {to}. What you bought, less {spare}% spare, split by your recipes.', '{n} receipts from {from} to {to}. What you bought, less {spare}% spare, split by your recipes.', { from: niceDate(estimate.from), to: niceDate(estimate.to), spare: data.spare })}</p>
      <ul className="shop-list">
        {rows.map((row: any) => (
          <li key={row.id} className="dish-week">
            <span className="shop-name">{row.dish.name}
              <small>{row.portions === null ? t('The receipts cannot tell this one apart.') : t('From {items}', { items: row.from.join(', ') })}</small>
            </span>
            <span className="shop-qty num">{row.portions === null ? '–' : t('About {count}', { count: row.portions })}</span>
          </li>
        ))}
      </ul>
      <ErrorNote message={error} />
      {differs ? <button className="btn block" type="button" disabled={busy} onClick={use}>{busy ? t('Saving') : t('Use these numbers')}</button> : <p className="caption">{t('Your numbers already match.')}</p>}
    </section>
  )
}

/**
 * This week's shopping: every recipe's ingredients, times how many of each dish sell, with a little spare, by supplier.
 * Worked out fresh each time it loads, and again every 30 seconds while it is open.
 */
export function Shopping() {
  const { data, setData, error, load } = useShopping()
  const [tab, setTab] = useState<Tab>('list')
  const [open, setOpen] = useState<number | null>(null)
  if (!data) return <Screen title={t('Shopping list')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>
  const opened = open === null ? null : data.items.find((item: any) => item.id === open)
  const hasRecipes = data.items.length > 0
  return (
    <Screen title={t('Shopping list')} lead={t("This week's order, from your recipes and how much each dish sells.")}>
      <ErrorNote message={error} />
      {hasRecipes || data.dishes.length ? (
        <Segment label={t('Show')} fill value={tab} onChange={setTab} options={[
          { value: 'list', label: t('To buy') }, { value: 'suppliers', label: t('Suppliers') }, { value: 'dishes', label: t('Dishes a week') },
        ]} />
      ) : null}
      {!hasRecipes && tab !== 'dishes' ? (
        <Empty title={t('No recipes yet.')}>
          <p className="muted">{t('The list is built from your recipes. Add them, and the ingredients show up here.')}</p>
          <a className="btn small" href="#/settings/menu">{t('Add recipes')}</a>
        </Empty>
      ) : null}
      {hasRecipes && tab === 'list' ? <ListTab data={data} onOpen={(item) => setOpen(item.id)} onDishes={() => setTab('dishes')} /> : null}
      {hasRecipes && tab === 'suppliers' ? <SuppliersTab data={data} onOpen={(item) => setOpen(item.id)} onChange={() => void load()} /> : null}
      {tab === 'dishes' ? <DishesTab data={data} onChange={setData} /> : null}
      {opened ? <ItemSheet item={opened} data={data} onClose={() => setOpen(null)} onChange={setData} /> : null}
      <p className="caption shop-foot"><Truck size={16} aria-hidden="true" /> {t('Updates by itself when recipes, sales or suppliers change.')}</p>
    </Screen>
  )
}
