import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { CaretRight, ClipboardText, CookingPot, DownloadSimple, FileArrowUp, GlobeSimple, LinkSimple, PlugsConnected, Plus, Trash, Truck, UploadSimple, UsersThree, ChartBar } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { t, tk, LANGUAGES } from '../lib/i18n'
import { LanguagePicker } from '../components/Language'
import { Mascot } from '../components/Mascot'
import { Dock, Empty, ErrorNote, Loading, Screen, Sheet } from '../components/ui'

const ROWS = [
  { href: '#/settings/suppliers', Icon: Truck, title: tk('Suppliers'), note: tk('Who you buy from, with their email and phone.') },
  { href: '#/settings/menu', Icon: CookingPot, title: tk('Menu and recipes'), note: tk('Dishes, prices and what goes in them.') },
  { href: '#/settings/checklists', Icon: ClipboardText, title: tk('Checklists'), note: tk('What staff check, and when.') },
  { href: '#/settings/team', Icon: UsersThree, title: tk('Team'), note: tk('Invite staff with a link.') },
  { href: '#/settings/sales', Icon: ChartBar, title: tk('Sales'), note: tk('Import what you sold from your till.') },
  { href: '#/settings/import', Icon: FileArrowUp, title: tk('Import a file'), note: tk('Sales, recipes and price lists from any file.') },
  { href: '#/connections', Icon: PlugsConnected, title: tk('Connections'), note: tk('Gmail, WhatsApp and phone calls.') },
]

export function Settings() {
  const [setup, setSetup] = useState<any>(null)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [language, setLanguage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/setup').then((value) => { setSetup(value); setName(value.restaurant) }).catch((e) => setError(e.message)) }, [])
  if (!setup) return <Screen title={t('Settings')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const save = async () => {
    await api('/api/setup/restaurant', { body: { name } }).then(() => setSaved(true)).catch((e) => setError(e.message))
  }
  const clear = async () => {
    try {
      await api('/api/setup/clear-sample', { method: 'POST' })
      window.location.hash = '#/home'
      window.location.reload()
    } catch (problem) {
      setClearing(false)
      setError((problem as Error).message)
    }
  }

  return (
    <Screen title={t('Settings')}>
      <ErrorNote message={error} />
      {setup.sampleData ? (
        <section className="card">
          <h2>{t('You are looking at a sample restaurant')}</h2>
          <p>{t('Clear it when you are ready to add your own suppliers, menu and sales.')}</p>
          <button className="btn block" type="button" onClick={() => setClearing(true)}><Trash size={22} aria-hidden="true" />{t('Clear the sample data')}</button>
        </section>
      ) : null}
      <a className="demo-link" href="#/start"><Mascot size={40} /><span><strong>{t('Set up with Stockpot')}</strong><small>{t('Five quick questions.')}</small></span><CaretRight size={20} aria-hidden="true" /></a>
      <label className="field">{t('Restaurant name')}
        <input value={name} onChange={(event) => { setName(event.target.value); setSaved(false) }} onBlur={save} />
      </label>
      {saved ? <p className="when" role="status">{t('Saved.')}</p> : null}
      <ul className="feature-list">
        {ROWS.map(({ href, Icon, title, note }) => (
          <li key={href}>
            <a className="feature-row" href={href}>
              <Icon size={24} aria-hidden="true" />
              <strong>{t(title)}</strong>
              <CaretRight className="note" size={20} aria-hidden="true" />
              <small>{t(note)}</small>
            </a>
          </li>
        ))}
        <li>
          <button className="feature-row" type="button" onClick={() => setLanguage(true)}>
            <GlobeSimple size={24} aria-hidden="true" />
            <strong>{t('Language')}</strong>
            <CaretRight className="note" size={20} aria-hidden="true" />
          </button>
        </li>
      </ul>
      {language ? <Sheet title={t('Language')} onClose={() => setLanguage(false)}><LanguagePicker onDone={() => setLanguage(false)} /></Sheet> : null}
      {clearing ? (
        <Sheet title={t('Clear the sample data?')} onClose={() => setClearing(false)}>
          <p>{t('This removes every sample supplier, order, receipt and sale. It keeps your keys and connections. You can\'t undo it.')}</p>
          <button className="btn danger block" type="button" onClick={clear}>{t('Clear the sample data')}</button>
        </Sheet>
      ) : null}
    </Screen>
  )
}

const BLANK = { name: '', contact: '', email: '', phone: '' }

export function SuppliersSettings() {
  const [suppliers, setSuppliers] = useState<any[] | null>(null)
  const [editing, setEditing] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/setup/suppliers').then(setSuppliers).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  const save = async () => {
    setError(null)
    try {
      await api(editing.id ? `/api/setup/suppliers/${editing.id}` : '/api/setup/suppliers', { method: editing.id ? 'PUT' : 'POST', body: editing })
      setEditing(null)
      await load()
    } catch (problem) { setError((problem as Error).message) }
  }
  const remove = async () => {
    setError(null)
    try {
      await api(`/api/setup/suppliers/${editing.id}`, { method: 'DELETE' })
      setEditing(null)
      await load()
    } catch (problem) { setError((problem as Error).message) }
  }
  const field = (key: string, label: string, type = 'text') => (
    <label className="field" key={key}>{label}<input type={type} value={editing[key] ?? ''} onChange={(event) => setEditing({ ...editing, [key]: event.target.value })} /></label>
  )

  return (
    <Screen title={t('Suppliers')} lead={t('Calls, receipts and Gmail all match against this list.')}>
      {!editing ? <ErrorNote message={error} /> : null}
      {!suppliers && !error ? <Loading /> : null}
      {suppliers?.length === 0 ? <Empty title={t('No suppliers yet.')}><p className="muted">{t('Add the people you buy from.')}</p></Empty> : null}
      {suppliers?.length ? (
        <ul className="feature-list">
          {suppliers.map((supplier) => (
            <li key={supplier.id}>
              <button className="feature-row" type="button" onClick={() => setEditing({ ...BLANK, ...supplier })}>
                <Truck size={24} aria-hidden="true" />
                <strong>{supplier.name}</strong>
                <CaretRight className="note" size={20} aria-hidden="true" />
                <small>{[supplier.contact, supplier.email, supplier.phone].filter(Boolean).join(', ') || t('Add their email so invoices come in by themselves.')}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dock><button className="btn primary block" type="button" onClick={() => setEditing({ ...BLANK })}><Plus size={24} aria-hidden="true" />{t('Add a supplier')}</button></Dock>
      {editing ? (
        <Sheet title={editing.id ? editing.name : t('Add a supplier')} onClose={() => { setEditing(null); setError(null) }}>
          {field('name', t('Name'))}
          {field('contact', t('Contact person'))}
          {field('email', t('Email'), 'email')}
          {field('phone', t('Phone'), 'tel')}
          <ErrorNote message={error} />
          <button className="btn primary block" type="button" onClick={save}>{t('Save')}</button>
          {editing.id ? <button className="btn text block" type="button" onClick={remove}>{t('Remove this supplier')}</button> : null}
        </Sheet>
      ) : null}
    </Screen>
  )
}

/** Makes a WhatsApp link for one person. Tapping it is all they have to do. */
export function InviteForm({ onMade }: { onMade?: () => void }) {
  const [name, setName] = useState('')
  const [language, setLanguageChoice] = useState('en')
  const [invite, setInvite] = useState<any>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const make = async () => {
    setError(null)
    setCopied(false)
    try {
      setInvite(await api('/api/team/invites', { body: { name, language } }))
      setName('')
      onMade?.()
    } catch (problem) { setError((problem as Error).message) }
  }
  const words = invite?.link ? t('Hi {name}, tap this to get your Stockpot checklists on WhatsApp: {link}', { name: invite.name, link: invite.link }) : ''
  const share = async () => {
    if (navigator.share) return void navigator.share({ text: words }).catch(() => undefined)
    await navigator.clipboard.writeText(words)
    setCopied(true)
  }
  return (
    <div className="stack">
      <div className="two">
        <label className="field">{t('Their name')}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field">{t('Language')}
          <select value={language} onChange={(event) => setLanguageChoice(event.target.value)}>
            {LANGUAGES.map(({ code, name: label }) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
      </div>
      <ErrorNote message={error} />
      <button className="btn block" type="button" disabled={!name.trim()} onClick={make}><LinkSimple size={24} aria-hidden="true" />{t('Create an invite link')}</button>
      {invite?.link ? (
        <div className="invite arrive">
          <p>{t('Send this to {name}. When they tap it and press send, they are on your team.', { name: invite.name })}</p>
          <code>{invite.link}</code>
          <button className="btn primary block" type="button" onClick={share}>{copied ? t('Copied') : t('Share the link')}</button>
        </div>
      ) : null}
      {invite && !invite.link ? <p className="notice">{t('Invite saved. The link works once WhatsApp is connected.')}</p> : null}
    </div>
  )
}

export function TeamSettings() {
  const [setup, setSetup] = useState<any>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', number: '', language: 'en' })
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/setup').then(setSetup).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  const add = async () => {
    setError(null)
    try {
      await api('/api/team/people', { body: form })
      setForm({ name: '', number: '', language: 'en' })
      setAdding(false)
      await load()
    } catch (problem) { setError((problem as Error).message) }
  }
  const remove = async (name: string) => {
    await api(`/api/team/people/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch((e) => setError(e.message))
    await load()
  }
  const cancel = async (code: string) => {
    await api(`/api/team/invites/${code}`, { method: 'DELETE' })
    await load()
  }
  const languageName = (code: string | null) => LANGUAGES.find((language) => language.code === code)?.name

  return (
    <Screen title={t('Team')} lead={t('Send a link, or add their number. Numbers are never shown again.')}>
      {!adding ? <ErrorNote message={error} /> : null}
      {!setup && !error ? <Loading /> : null}
      <section className="card">
        <h2>{t('Invite someone')}</h2>
        <InviteForm onMade={load} />
        <button className="btn text small" type="button" onClick={() => setAdding(true)}>{t('Add a phone number instead')}</button>
      </section>
      {setup?.people.length || setup?.waiting.length ? (
        <ul className="list">
          {setup.people.map((person: any) => (
            <li key={person.name}>
              <span>{person.name}{person.language ? <span className="when"><br />{languageName(person.language)}</span> : null}</span>
              <button className="btn text small" type="button" onClick={() => remove(person.name)}>{t('Remove')}</button>
            </li>
          ))}
          {setup.waiting.map((invite: any) => (
            <li key={invite.code}>
              <span>{invite.name}<span className="when"><br />{t('Invited, not joined yet')}</span></span>
              <button className="btn text small" type="button" onClick={() => cancel(invite.code)}>{t('Cancel')}</button>
            </li>
          ))}
        </ul>
      ) : setup ? <Empty title={t('Nobody yet.')}><p className="muted">{t('Until you add someone, checklists come to your own WhatsApp.')}</p></Empty> : null}
      <p className="caption">{t('Stockpot replies in the language each person writes in.')}</p>
      {adding ? (
        <Sheet title={t('Add a phone number')} onClose={() => { setAdding(false); setError(null) }}>
          <label className="field">{t('Their name')}<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="field">{t('WhatsApp number, with the country code')}<input type="tel" autoComplete="off" value={form.number} onChange={(event) => setForm({ ...form, number: event.target.value })} /></label>
          <label className="field">{t('Language')}
            <select value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
              {LANGUAGES.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
          <p className="caption">{t('WhatsApp only lets Stockpot message them after they have messaged the business number, so a link is easier.')}</p>
          <ErrorNote message={error} />
          <button className="btn primary block" type="button" onClick={add}>{t('Save')}</button>
        </Sheet>
      ) : null}
    </Screen>
  )
}

export function SalesSettings() {
  const [imported, setImported] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    const form = new FormData()
    form.append('file', file)
    try { setImported(await api('/api/sales/import', { form })) } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <Screen title={t('Sales')} lead={t('Export a sales CSV from your till and import it here. Dish names need to match your menu.')}>
      <ErrorNote message={error} />
      {imported ? <p className="notice" role="status">{t('Imported {imported} rows.', { imported: imported.imported })}{imported.skipped ? ` ${t('{skipped} rows were already saved, so they were skipped.', { skipped: imported.skipped })}` : ''}{imported.problems.length ? ` ${imported.problems.join(' ')}` : ''}</p> : null}
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={upload} />
      <button className="btn primary block" type="button" onClick={() => input.current?.click()}><UploadSimple size={24} aria-hidden="true" />{t('Import sales CSV')}</button>
      <a className="btn block" href="/api/sales/template.csv"><DownloadSimple size={24} aria-hidden="true" />{t('Download a template')}</a>
      <a className="btn text block" href="#/settings/import">{t('Import any other file')}</a>
    </Screen>
  )
}
