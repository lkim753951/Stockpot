import { useState } from 'react'
import { Check, GlobeSimple } from '@phosphor-icons/react'
import { LANGUAGES, setLanguage, t, useLanguage } from '../lib/i18n'
import { Sheet } from './ui'

export function LanguagePicker({ onDone }: { onDone?: () => void }) {
  const current = useLanguage()
  return (
    <ul className="language-list">
      {LANGUAGES.map(({ code, name }) => (
        <li key={code}>
          <button type="button" lang={code} aria-pressed={code === current} onClick={() => { void setLanguage(code).then(onDone) }}>
            {name}{code === current ? <Check size={22} weight="bold" aria-hidden="true" /> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

export function LanguageButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="icon-btn" type="button" aria-label={t('Language')} onClick={() => setOpen(true)}><GlobeSimple size={24} aria-hidden="true" /></button>
      {open ? <Sheet title={t('Language')} onClose={() => setOpen(false)}><LanguagePicker onDone={() => setOpen(false)} /></Sheet> : null}
    </>
  )
}
