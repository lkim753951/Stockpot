import { lazy, Suspense } from 'react'
import { ArrowRight } from '@phosphor-icons/react'
import { t } from '../lib/i18n'
import type { Role } from '../App'
import { Sk } from '../components/ui'

// The demos carry the Stageshow kit, so they load on their own and never slow the app itself.
const Stories = lazy(() => import('../demo/Stories').then((module) => ({ default: module.Stories })))
import { LanguageButton } from '../components/Language'

/** The sample and the real app are separate sites, so the second choice is a plain link to the other one. */
export function Welcome({ onChoose, sample, otherSite }: { onChoose: (role: Role) => void; sample: boolean; otherSite: string | null }) {
  return (
    <>
    {sample ? <div className="banner solo"><span className="sample-label">{t('SAMPLE DATA')}</span></div> : null}
    <main className="welcome">
      <div className="row between">
        <picture>
          <source srcSet="/brand/stockpot-logo-reversed.svg" media="(prefers-color-scheme: dark)" />
          <img src="/brand/stockpot-logo.svg" alt="Stockpot" width="137" height="32" />
        </picture>
        <LanguageButton />
      </div>
      <div className="welcome-hero">
        <h1>{t('Helping small restaurants get on their feet')}</h1>
        <p className="muted">{t('Stockpot takes on the repetitive work, helps you spot opportunities and P&L leakage, and keeps you ready for a crisis.')}</p>
      </div>
      <Suspense fallback={<Sk width="100%" height={500} />}><Stories /></Suspense>
      <div className="role-bar">
        <div className="role-buttons">
          <button className="btn primary" type="button" onClick={() => onChoose('owner')}>{t('Owner')}</button>
          <button className="btn" type="button" onClick={() => onChoose('staff')}>{t('Staff')}</button>
        </div>
        {otherSite ? <a className="btn text small role-switch" href={otherSite}>{sample ? t('Open the real app') : t('Try the sample')}<ArrowRight size={20} aria-hidden="true" /></a> : null}
      </div>
    </main>
    </>
  )
}
