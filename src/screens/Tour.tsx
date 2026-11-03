import { lazy, Suspense } from 'react'
import { t } from '../i18n'
import { Screen, Sk } from '../ui'

// The demos carry the Stageshow kit, so they load on their own and never slow the app itself.
const Stories = lazy(() => import('../demo/Stories').then((module) => ({ default: module.Stories })))
const FeatureGrid = lazy(() => import('../demo/FeatureGrid').then((module) => ({ default: module.FeatureGrid })))

export function Tour() {
  return (
    <Screen title={t('See how it works')} lead={t('A one-minute look at Stockpot.')}>
      <Suspense fallback={<Sk width="100%" height={609} />}>
        <Stories />
        <FeatureGrid />
      </Suspense>
    </Screen>
  )
}
