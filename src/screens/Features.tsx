import { t, tk } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { CaretRight, UsersThree } from '@phosphor-icons/react'
import { Mascot } from '../components/Mascot'
import { api } from '../lib/api'
import { ErrorNote, FEATURE_ICONS, Loading, Screen } from '../components/ui'
import { FeatureDot } from './Home'

const WORDS: Record<string, string> = {
  receipts: tk('Photos of receipts become rows you can check and export.'),
  deliveries: tk('Track each order from the call to the invoice. Problems come to you with a call button.'),
  analyst: tk('Weekly food cost and margins in plain words, with three things to do.'),
  calls: tk('Put a call on speaker or upload a recording. You get a summary and tasks.'),
  checklists: tk('Daily, weekly and monthly checks, in the app or on WhatsApp.'),
  reports: tk('Staff report a problem in their own language. You read it in English.'),
  crisis: tk('Step-by-step cards for power, water, gas, fridge and wifi. Work offline.'),
  shopping: tk("This week's ingredients from your recipes and sales, ordered from each supplier."),
}

const GROUPS = [
  { title: tk('Money'), keys: ['receipts', 'deliveries', 'analyst'] },
  { title: tk('Kitchen'), keys: ['shopping', 'calls', 'checklists', 'crisis'] },
  { title: tk('Team'), keys: ['reports'] },
]

export function Features() {
  const [features, setFeatures] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/home').then((home) => setFeatures(home.features)).catch((e) => setError(e.message)) }, [])
  if (!features) return <Screen title={t('Features')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  return (
    <Screen title={t('Features')} lead={t('Everything Stockpot does, and how each part is doing.')}>
      <a className="demo-link" href="#/tour"><Mascot size={40} /><span><strong>{t('See how it works')}</strong><small>{t('A one-minute look at Stockpot.')}</small></span><CaretRight size={20} aria-hidden="true" /></a>
      {GROUPS.map((group) => (
        <section className="stack" key={group.title}>
          <h2>{t(group.title)}</h2>
          <ul className="feature-list">
            {group.keys.map((key) => {
              const feature = features.find((candidate) => candidate.key === key)
              const Glyph = FEATURE_ICONS[key]
              return (
                <li key={key}>
                  <a className="feature-row" href={feature.href}>
                    <Glyph size={24} aria-hidden="true" />
                    <strong>{feature.label}</strong>
                    <span className="when note"><FeatureDot state={feature.state} />{feature.note}</span>
                    <small>{t(WORDS[key])}</small>
                  </a>
                </li>
              )
            })}
            {group.title === 'Team' ? (
              <li>
                <a className="feature-row" href="#/checklists">
                  <UsersThree size={24} aria-hidden="true" />
                  <strong>{t('Team messages')}</strong>
                  <small>{t('Send checklists on WhatsApp and see every reply.')}</small>
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </Screen>
  )
}
