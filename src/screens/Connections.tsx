import { useEffect, useState, type ReactNode } from 'react'
import { GoogleLogo } from '@phosphor-icons/react'
import { api } from '../api'
import { t, tn } from '../i18n'
import { clockWords, inSentence, momentWords } from '../dates'
import { Chip, ErrorNote, Loading, Screen } from '../ui'

function TestButton({ url, label }: { url: string; label: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; detail: string | null } | null>(null)
  const run = async () => {
    setBusy(true)
    try { setResult(await api(url, { method: 'POST' })) } catch (problem) { setResult({ ok: false, detail: (problem as Error).message }) } finally { setBusy(false) }
  }
  return (
    <>
      <button className="btn small" type="button" disabled={busy} onClick={run}>{busy ? t('Testing') : label}</button>
      {result ? <p className={result.ok ? 'notice' : 'error'} role="status">{result.ok ? (result.detail ?? t('Sent. Check WhatsApp.')) : result.detail}</p> : null}
    </>
  )
}

/** Keys go in and never come back out, so a box is always empty, even when a value is saved. */
function SecretForm({ fields, onSaved, summary, children }: { fields: Array<{ key: string; label: string; plain?: boolean }>; onSaved: (result: any) => void; summary: string; children?: ReactNode }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    try {
      onSaved(await api('/api/connections/save', { body: values }))
      setValues({})
    } catch (problem) { setError((problem as Error).message) }
  }
  return (
    <details className="connect-form">
      <summary>{summary}</summary>
      {children}
      {fields.map(({ key, label, plain }) => (
        <label className="field" key={key}>{label}
          <input type={plain ? 'text' : 'password'} autoComplete="off" value={values[key] ?? ''} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />
        </label>
      ))}
      <ErrorNote message={error} />
      <button className="btn small" type="button" onClick={save}>{t('Save')}</button>
    </details>
  )
}

export function Connections() {
  const [status, setStatus] = useState<any>(null)
  const [mail, setMail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/connections').then(setStatus).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])
  if (!status) return <Screen title={t('Connections')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const { whatsapp, gmail, phone } = status
  const failed = window.location.hash.includes('gmail=failed')
  const check = async () => {
    setMail(null)
    try {
      const { added } = await api('/api/google/check', { method: 'POST' })
      setMail(tn(added, '{n} new invoice', '{n} new invoices'))
      await load()
    } catch (problem) { setError((problem as Error).message) }
  }
  const disconnect = async () => {
    await api('/api/google/disconnect', { method: 'POST' })
    await load()
  }

  return (
    <Screen title={t('Connections')} lead={t('What Stockpot is linked to.')}>
      <ErrorNote message={error} />

      <section className="card">
        <div className="row between"><h2>{t('Gmail')}</h2><Chip tone={gmail.connected ? 'good' : 'off'}>{gmail.connected ? t('Connected') : t('Not connected')}</Chip></div>
        {failed ? <p className="error">{t("Google didn't finish the login. Try again.")}</p> : null}
        {gmail.connected ? (
          <>
            <p>{gmail.account}</p>
            {gmail.checkedAt ? <p className="when">{t('Last checked {when}. {count} invoices so far.', { when: inSentence(momentWords(gmail.checkedAt)), count: gmail.mailed })}</p> : null}
            <div className="row">
              <button className="btn small" type="button" onClick={check}>{t('Check now')}</button>
              <button className="btn text small" type="button" onClick={disconnect}>{t('Disconnect')}</button>
            </div>
            {mail ? <p className="notice" role="status">{mail}</p> : null}
          </>
        ) : (
          <>
            <p>{t('Bring in supplier invoices by themselves, and send order emails from your own address.')}</p>
            {gmail.configured ? <a className="btn primary block" href="/api/google/login"><GoogleLogo size={24} aria-hidden="true" />{t('Sign in with Google')}</a> : <p className="notice">{t('Google sign-in is being set up for Stockpot.')}</p>}
          </>
        )}
      </section>

      <section className="card">
        <div className="row between"><h2>{t('WhatsApp')}</h2><Chip tone={whatsapp.connected ? 'good' : 'off'}>{whatsapp.connected ? t('Connected') : t('Not connected')}</Chip></div>
        {whatsapp.connected ? (
          <>
            <p>{whatsapp.people.length ? t('Sending checklists to {people}.', { people: whatsapp.people.join(', ') }) : t('Sending checklists to you for now.')}</p>
            {whatsapp.problem ? <p className="error">{whatsapp.problem.detail}</p> : null}
            {whatsapp.lastHeardAt ? <p className="when">{t('Last reply at {lastHeardAt}', { lastHeardAt: clockWords(whatsapp.lastHeardAt) })}</p> : null}
            <TestButton url="/api/connections/whatsapp/test" label={t('Send a test message')} />
          </>
        ) : <p>{t('WhatsApp is being set up for Stockpot. Your checklists stay in the app until then.')}</p>}
        <a className="link-btn" href="#/settings/team">{t('Invite your team')}</a>
      </section>

      <ul className="feature-list">
        <li className="panel-row">
          <span className="panel-row-top"><strong>{t('Phone calls')}</strong><Chip tone={phone.ready ? 'good' : 'off'}>{phone.ready ? t('Connected') : t('Not connected')}</Chip></span>
          <span className="muted">{t('Stockpot can ring someone when a checklist is late.')}</span>
        </li>
        <li className="panel-row">
          <span className="panel-row-top"><strong>{t('Till')}</strong><Chip tone="off">{t('Sales CSV')}</Chip></span>
          <span className="muted">{t('Export a sales CSV from your till and import it.')}</span>
          <a className="link-btn" href="#/settings/sales">{t('Import sales')}</a>
        </li>
      </ul>
    </Screen>
  )
}

/** For whoever runs Stockpot, not for an owner. Nothing links here: open #/developer directly. */
export function Developer() {
  const [status, setStatus] = useState<any>(null)
  const [restart, setRestart] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => api('/api/connections').then(setStatus).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])
  if (!status) return <Screen title="Developer"><ErrorNote message={error} />{error ? null : <Loading />}</Screen>
  const saved = (result: any) => { setRestart(!!result.restart); void load() }
  const { meta, gmail, whatsapp, phone, data } = status
  return (
    <Screen title="Developer" lead="Keys for this install. They are saved to .env and never come back to a browser.">
      {restart ? <p className="notice" role="status">Saved. Restart Stockpot to use the new key.</p> : null}
      <section className="card">
        <div className="row between"><h2>Meta</h2><Chip tone={meta.connected ? 'good' : 'attention'}>{meta.connected ? 'Key saved' : 'No key'}</Chip></div>
        <p>{meta.spark}, {meta.voice}, {meta.sam}</p>
        {meta.connected ? <TestButton url="/api/connections/meta/test" label="Test Meta" /> : null}
        <SecretForm summary="Meta API key" onSaved={saved} fields={[{ key: 'MODEL_API_KEY', label: 'MODEL_API_KEY' }]} />
      </section>
      <section className="card">
        <div className="row between"><h2>Google</h2><Chip tone={gmail.configured ? 'good' : 'off'}>{gmail.configured ? 'Client saved' : 'No client'}</Chip></div>
        <SecretForm summary="OAuth client" onSaved={saved} fields={[{ key: 'GOOGLE_CLIENT_ID', label: 'Client ID', plain: true }, { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret' }]}>
          <p className="caption">Redirect URI: <code>{`${window.location.origin}/api/google/callback`}</code></p>
        </SecretForm>
      </section>
      <section className="card">
        <div className="row between"><h2>WhatsApp</h2><Chip tone={whatsapp.connected ? 'good' : 'off'}>{whatsapp.connected ? 'Keys saved' : 'No keys'}</Chip></div>
        <SecretForm summary="Cloud API" onSaved={saved} fields={[
          { key: 'WHATSAPP_TOKEN', label: 'Access token' }, { key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'Phone number ID', plain: true }, { key: 'WHATSAPP_BUSINESS_NUMBER', label: 'Business number' },
          { key: 'WHATSAPP_OWNER_NUMBER', label: 'Owner number' }, { key: 'WHATSAPP_APP_SECRET', label: 'App secret' }, { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token' },
        ]} />
      </section>
      <section className="card">
        <div className="row between"><h2>Twilio</h2><Chip tone={phone.ready ? 'good' : 'off'}>{phone.ready ? 'Keys saved' : 'No keys'}</Chip></div>
        {phone.last?.status === 'failed' ? <p className="error">{phone.last.detail}</p> : null}
        {phone.ready ? <TestButton url="/api/connections/phone/test" label="Ring my phone" /> : null}
        <SecretForm summary="Phone calls" onSaved={saved} fields={[{ key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', plain: true }, { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token' }, { key: 'TWILIO_FROM_NUMBER', label: 'From number' }, { key: 'OWNER_PHONE', label: 'Phone to ring' }]} />
      </section>
      <section className="card">
        <div className="row between"><h2>Saved data</h2><Chip tone={data.lastBackup ? 'good' : 'off'}>{data.lastBackup ? 'Backed up' : 'No backup yet'}</Chip></div>
        <p>{data.kept.suppliers} suppliers, {data.kept.orders} orders, {data.kept.invoices} invoices, {data.kept.calls} calls, {data.kept.checklists} checklist runs.</p>
        <p className="caption">Saved in SQLite in the data folder. {data.lastBackup ? `Last backup ${data.lastBackup}, ${data.backups} kept.` : 'A backup runs once a day.'}</p>
      </section>
    </Screen>
  )
}
