import { lazy, Suspense } from 'react'
import { t } from '../i18n'
import type { Role } from '../App'
import { Sk } from '../ui'

// The demos carry the Stageshow kit, so they load on their own and never slow the app itself.
const Stories = lazy(() => import('../demo/Stories').then((module) => ({ default: module.Stories })))
import { LanguageButton } from '../Language'

export function Welcome({ onChoose }: { onChoose: (role: Role) => void }) {
  return (
    <main className="welcome">
      <div className="row between">
        <picture>
          <source srcSet="/brand/stockpot-logo-reversed.svg" media="(prefers-color-scheme: dark)" />
          <img src="/brand/stockpot-logo.svg" alt="Stockpot" width="137" height="32" />
        </picture>
        <LanguageButton />
      </div>
      <div className="welcome-hero">
        <h1>{t('Get your money back from every delivery')}</h1>
        <p className="muted">{t("Stockpot hears the price on the call, watches the delivery and reads the invoice. When they don't match, it shows you what you're owed.")}</p>
      </div>
      <Suspense fallback={<Sk width="100%" height={500} />}><Stories /></Suspense>
      <div className="role-bar">
        <button className="btn primary" type="button" onClick={() => onChoose('owner')}>{t('Owner')}</button>
        <button className="btn" type="button" onClick={() => onChoose('staff')}>{t('Staff')}</button>
      </div>
    </main>
  )
}
