import { useEffect, useState } from 'react'
import { CheckCircle, EnvelopeSimple } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { t } from '../lib/i18n'
import { momentWords, inSentence } from '../lib/dates'
import { ErrorNote, Loading, Sheet } from '../components/ui'

/** The owner reads every email before it goes. It is written in English, because it goes to the supplier. */
export function OrderEmailSheet({ orderId, onClose }: { orderId: number; onClose: () => void }) {
  const [email, setEmail] = useState<any>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api(`/api/orders/${orderId}/email`).then(setEmail).catch((e) => setError(e.message)) }, [orderId])

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/orders/${orderId}/email`, { body: email })
      setSent(true)
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const openedInMail = () => { void api(`/api/orders/${orderId}/email`, { body: { sent: true } }) }

  return (
    <Sheet title={t('Email the confirmation')} onClose={onClose}>
      <ErrorNote message={error} />
      {!email && !error ? <Loading /> : null}
      {email ? (
        <>
          {email.sentAt ? <p className="when">{t('Sent {when}', { when: inSentence(momentWords(email.sentAt)) })}</p> : null}
          <label className="field">{t('To')}<input type="email" value={email.to} onChange={(event) => setEmail({ ...email, to: event.target.value })} /></label>
          <label className="field">{t('Subject')}<input value={email.subject} onChange={(event) => setEmail({ ...email, subject: event.target.value })} /></label>
          <label className="field">{t('Message')}<textarea rows={10} value={email.body} onChange={(event) => setEmail({ ...email, body: event.target.value })} /></label>
          {sent ? <p className="notice" role="status"><CheckCircle size={20} aria-hidden="true" />{t('Sent.')}</p> : null}
          {email.gmail ? <button className="btn primary block" type="button" disabled={busy || sent} onClick={send}><EnvelopeSimple size={24} aria-hidden="true" />{busy ? t('Sending') : t('Send with Gmail')}</button> : null}
          <a className={`btn${email.gmail ? ' text' : ' primary'} block`} href={`mailto:${email.to}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`} onClick={openedInMail}>{t('Open in email')}</a>
          {email.gmail ? null : <a className="link-btn" href="#/connections">{t('Connect Gmail to send from here')}</a>}
        </>
      ) : null}
    </Sheet>
  )
}
