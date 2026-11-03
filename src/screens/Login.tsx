import { t } from '../i18n'
import { LanguageButton } from '../Language'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import type { Role } from '../App'
import { ErrorNote, Segment } from '../ui'

export function Login({ role, onRole, onDone, onBack }: { role: Role; onRole: (role: Role) => void; onDone: () => void; onBack: () => void }) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const signedIn = await api<{ role: Role }>('/api/login', { body: { passcode } })
      if (signedIn.role !== role) {
        await api('/api/logout', { method: 'POST' })
        return setError(t(signedIn.role === 'owner' ? 'That passcode is for the owner. Switch above to use it.' : 'That passcode is for staff. Switch above to use it.'))
      }
      onDone()
    } catch (problem) {
      setError((problem as Error).message)
    }
  }
  return (
    <main className="screen" style={{ paddingTop: 48 }}>
      <div className="row between">
        <picture>
          <source srcSet="/brand/stockpot-logo-reversed.svg" media="(prefers-color-scheme: dark)" />
          <img src="/brand/stockpot-logo.svg" alt="Stockpot" width="171" height="40" style={{ display: 'block' }} />
        </picture>
        <LanguageButton />
      </div>
      <Segment label={t('Sign in as')} value={role} options={[{ value: 'owner', label: t('Owner') }, { value: 'staff', label: t('Staff') }]} onChange={(value) => { setError(null); onRole(value as Role) }} />
      <form className="stack" onSubmit={submit}>
        <label className="field">{role === 'owner' ? t('Owner passcode') : t('Staff passcode')}
          <input type="password" autoComplete="current-password" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
        </label>
        <ErrorNote message={error} />
        <button className="btn primary block" type="submit">{t('Sign in')}</button>
      </form>
      <button className="btn text" type="button" onClick={onBack}>{t('Back')}</button>
      <a className="btn block" href="#/crisis">{t('Crisis cards')}</a>
    </main>
  )
}
