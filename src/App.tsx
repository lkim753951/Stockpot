import { t, tk } from './i18n'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Bell, BellRinging, ChartLineUp, CookingPot, ChatCircleText, ClipboardText, GearSix, House, SignOut, Siren, SquaresFour, Tray, Truck } from '@phosphor-icons/react'
import { api } from './api'
import { alertPermission, alertsSupported, useAlerts, AlertToasts } from './alerts'
import { Segment } from './ui'
import { Home } from './screens/Home'
import { Actions } from './screens/Actions'
import { Features } from './screens/Features'
import { Call } from './screens/Call'
import { CallDetail, Calls } from './screens/Calls'
import { Order } from './screens/Order'
import { Receipts } from './screens/Receipts'
import { Checks, CheckDetail } from './screens/Checks'
import { SalesSettings, Settings, SuppliersSettings, TeamSettings } from './screens/Settings'
import { MenuSettings } from './screens/MenuSettings'
import { ChecklistSettings } from './screens/ChecklistSettings'
import { LanguageButton } from './Language'
import { Agent } from './Agent'
import { StaffRecipe, StaffRecipes } from './screens/Recipes'
import { Mascot } from './Mascot'
import { Reports, ReportDetail } from './screens/Reports'
import { Onboarding } from './screens/Onboarding'
import { Tour } from './screens/Tour'
import { Developer } from './screens/Connections'
import { StaffDelivery, StaffList } from './screens/Staff'
import { StaffToday } from './screens/StaffToday'
import { Login } from './screens/Login'
import { OwnerChecklists, RunDetail } from './screens/Checklist'
import { OwnerReport, StaffReport } from './screens/Report'
import { CrisisCardView, CrisisList } from './screens/Crisis'
import { Dashboard } from './screens/Dashboard'
import { Welcome } from './screens/Welcome'
import { Connections } from './screens/Connections'

export type Role = 'owner' | 'staff'
export interface Session { role: Role | null; mode: 'live' | 'sample'; needsPasscode: boolean; demoTime: string | null; onboarded: boolean }

const SEEN = 'stockpot-seen'
const readSeen = () => { try { return !!localStorage.getItem(SEEN) } catch { return false } }
const markSeen = () => { try { localStorage.setItem(SEEN, '1') } catch { /* private window */ } }

const currentRoute = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'home'

function useRoute() {
  const [route, setRoute] = useState(currentRoute)
  useEffect(() => {
    const update = () => { setRoute(currentRoute()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return route
}

const OWNER_TABS = [
  { href: 'home', label: tk('Home'), Icon: House },
  { href: 'dashboard', label: tk('Dashboard'), Icon: ChartLineUp },
  { href: 'actions', label: tk('Tasks'), Icon: Tray },
  { href: 'features', label: tk('Features'), Icon: SquaresFour },
]

const STAFF_TABS = [
  { href: 'staff', label: tk('Today'), Icon: ClipboardText },
  { href: 'staff/report', label: tk('Report'), Icon: ChatCircleText },
  { href: 'staff/recipes', label: tk('Recipes'), Icon: CookingPot },
  { href: 'staff/deliveries', label: tk('Deliveries'), Icon: Truck },
  { href: 'staff/crisis', label: tk('Crisis'), Icon: Siren },
]

/** Which tab a detail screen belongs to. */
const OWNER_PARENT: Record<string, string> = {
  receipts: 'features', snap: 'features', calls: 'features', call: 'features', order: 'features', checks: 'features', checklists: 'features', run: 'features',
  crisis: 'features', week: 'dashboard', summary: 'dashboard', reports: 'dashboard', report: 'actions', tour: 'features',
}

function StaffScreen({ parts, sample }: { parts: string[]; sample: boolean }) {
  const [, section, id] = parts[0] === 'staff' ? parts : ['staff', ...parts]
  if (section === 'run' && id) return <RunDetail id={id} sample={sample} />
  if (section === 'report') return <StaffReport sample={sample} />
  if (section === 'recipes') return id ? <StaffRecipe id={id} /> : <StaffRecipes />
  if (section === 'crisis') return id ? <CrisisCardView cardKey={id} base="#/staff/crisis" /> : <CrisisList base="#/staff/crisis" />
  if (section === 'deliveries') return <StaffList />
  if (section && /^\d+$/.test(section)) return <StaffDelivery id={section} sample={sample} />
  return <StaffToday />
}

function OwnerScreen({ parts, sample, onClock }: { parts: string[]; sample: boolean; onClock: () => void }) {
  const [screen, id, step] = parts
  switch (screen) {
    case 'actions': return <Actions sample={sample} />
    case 'features': return <Features />
    case 'call': return <Call sample={sample} />
    case 'calls': return id ? <CallDetail id={id} /> : <Calls sample={sample} />
    case 'order': return <Order id={id} />
    case 'receipts':
    case 'snap': return <Receipts sample={sample} />
    case 'checks': return step === 'receive' ? <StaffDelivery id={id} sample={sample} owner /> : id ? <CheckDetail id={id} say={step === 'say'} /> : <Checks />
    case 'checklists': return <OwnerChecklists sample={sample} />
    case 'run': return <RunDetail id={id} sample={sample} readOnly />
    case 'settings':
      if (id === 'suppliers') return <SuppliersSettings />
      if (id === 'menu') return <MenuSettings />
      if (id === 'checklists') return <ChecklistSettings />
      if (id === 'team') return <TeamSettings />
      if (id === 'sales') return <SalesSettings />
      return <Settings />
    case 'reports': return id ? <ReportDetail id={id} /> : <Reports />
    case 'tour': return <Tour />
    case 'developer': return <Developer />
    case 'week':
    case 'dashboard':
    case 'summary': return <Dashboard />
    case 'report': return <OwnerReport id={id} />
    case 'connections': return <Connections />
    case 'crisis': return id ? <CrisisCardView cardKey={id} base="#/crisis" owner /> : <CrisisList base="#/crisis" owner />
    default: return <Home sample={sample} onClock={onClock} />
  }
}

/** Stockpot itself sits in the middle of the bar, so a question is one tap away on any screen. */
function PotButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="snap" type="button" aria-label={t('Ask Stockpot')} onClick={onOpen}>
      <Mascot size={40} tone="light" /><span>{t('Ask Stockpot')}</span>
    </button>
  )
}

function AlertBell({ urgent }: { urgent: number }) {
  const [permission, setPermission] = useState(alertPermission)
  const ask = async () => {
    await Notification.requestPermission()
    setPermission(alertPermission())
  }
  if (alertsSupported() && permission === 'default') {
    return <button className="icon-btn" type="button" aria-label={t('Turn on alerts')} onClick={ask}><Bell size={24} aria-hidden="true" /></button>
  }
  return (
    <a className="icon-btn" href="#/actions" aria-label={urgent ? t('{urgent} urgent', { urgent }) : t('Tasks')}>
      {urgent ? <BellRinging size={24} aria-hidden="true" /> : <Bell size={24} aria-hidden="true" />}
      {urgent ? <span className="badge num" aria-hidden="true">{urgent}</span> : null}
    </a>
  )
}

export function App() {
  const route = useRoute()
  const [session, setSession] = useState<Session | null>(null)
  const [offline, setOffline] = useState(false)
  const [signIn, setSignIn] = useState<Role | null>(null)
  const [seen, setSeen] = useState(readSeen)
  const [asking, setAsking] = useState(false)
  const refresh = () => api<Session>('/api/session').then((value) => { setSession(value); setOffline(false) }).catch(() => setOffline(true))
  useEffect(() => { void refresh() }, [])

  const parts = route.split('/')
  const [screen, id] = parts
  const staffView = screen === 'staff' || session?.role === 'staff'
  const alerts = useAlerts(session?.role === 'owner')

  const open = (role: Role) => {
    markSeen()
    setSeen(true)
    window.location.hash = role === 'staff' ? '#/staff' : session?.mode === 'live' && !session.onboarded ? '#/start' : '#/home'
  }

  const choose = async (role: Role) => {
    if (!session?.role || (session.role === 'staff' && role === 'owner')) {
      if (session?.role) await api('/api/logout', { method: 'POST' })
      await refresh()
      setSignIn(role)
      return
    }
    setSignIn(null)
    open(role)
  }

  const signOut = async () => {
    await api('/api/logout', { method: 'POST' })
    setSignIn(null)
    window.location.hash = '#/welcome'
    await refresh()
  }

  // Crisis cards ship in the app, so they still open signed out or with the wifi down.
  if (offline || (session && !session.role && screen === 'crisis')) {
    return (
      <div className="shell staff">
        {offline ? <div className="banner"><span>{t('No signal. Crisis cards still work.')}</span></div> : null}
        {screen === 'crisis' && id ? <CrisisCardView cardKey={id} base="#/crisis" /> : <CrisisList base="#/crisis" />}
      </div>
    )
  }
  if (!session) return null

  if (!session.role) {
    return signIn
      ? <Login role={signIn} onRole={setSignIn} onDone={async () => { await refresh(); open(signIn) }} onBack={() => setSignIn(null)} />
      : <Welcome onChoose={choose} />
  }
  if (screen === 'welcome' || (!seen && !window.location.hash)) return <Welcome onChoose={choose} />
  if (screen === 'start') return <Onboarding />

  const sample = session.mode === 'sample'
  const liveCall = screen === 'call'
  const tabs = staffView ? STAFF_TABS : OWNER_TABS
  const activeTab = staffView
    ? (['report', 'crisis', 'deliveries', 'recipes'].includes(parts[1]) ? `staff/${parts[1]}` : parts[1] && /^\d+$/.test(parts[1]) ? 'staff/deliveries' : 'staff')
    : OWNER_PARENT[screen] ?? screen

  const reset = async () => {
    await api('/api/sample/reset', { method: 'POST' })
    window.location.hash = '#/home'
    window.location.reload()
  }

  const logo = (
    <picture>
      <source srcSet="/brand/stockpot-logo-reversed.svg" media="(prefers-color-scheme: dark)" />
      <img src="/brand/stockpot-logo.svg" alt="Stockpot" width="128" height="30" loading="lazy" />
    </picture>
  )

  return (
    <div className={`shell${staffView ? ' staff' : ''}`}>
      {sample ? (
        <div className="banner">
          <span>{t('Sample, no AI. Demo time {demoTime}.', { demoTime: session.demoTime })}</span>
          {session.role === 'owner' ? <button type="button" onClick={reset}>{t('Start again')}</button> : null}
        </div>
      ) : null}
      {liveCall ? null : (
        <header className="topbar">
          <a href="#/welcome" aria-label={t('About Stockpot')}>
            <picture>
              <source srcSet="/brand/stockpot-mark-reversed.svg" media="(prefers-color-scheme: dark)" />
              <img src="/brand/stockpot-mark.svg" alt="Stockpot" width="32" height="32" />
            </picture>
          </a>
          <div className="topbar-actions">
            <Segment label={t('View as')} value={staffView ? 'staff' : 'owner'} options={[{ value: 'owner', label: t('Owner') }, { value: 'staff', label: t('Staff') }]} onChange={(role) => void choose(role as Role)} />
            {staffView ? <LanguageButton /> : <AlertBell urgent={alerts.count} />}
            {staffView ? null : <a className="icon-btn" href="#/settings" aria-label={t('Settings')}><GearSix size={24} aria-hidden="true" /></a>}
            {session.needsPasscode ? <button className="icon-btn" type="button" aria-label={t('Sign out')} onClick={signOut}><SignOut size={22} aria-hidden="true" /></button> : null}
          </div>
        </header>
      )}
      <div className="route" key={route}>
        {staffView ? <StaffScreen parts={parts} sample={sample} /> : <OwnerScreen parts={parts} sample={sample} onClock={refresh} />}
      </div>
      {staffView ? null : <AlertToasts toasts={alerts.toasts} onClose={alerts.dismiss} />}
      {asking ? <Agent onClose={() => setAsking(false)} /> : null}
      <nav className="nav" aria-label={staffView ? t('Staff') : t('Owner')} style={{ ['--tabs' as string]: 5 }}>
        <a className="nav-logo" href="#/welcome" aria-label={t('About Stockpot')}>{logo}</a>
        {tabs.map(({ href, label, Icon }, index) => {
          const on = activeTab === href
          const badge = href === 'actions' ? alerts.count : 0
          return (
            <NavSlot key={href} snap={!staffView && index === 2 ? <PotButton onOpen={() => setAsking(true)} /> : null}>
              <a href={`#/${href}`} className={`nav-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
                <span className="pill">
                  <Icon size={24} weight={on ? 'fill' : 'regular'} aria-hidden="true" />
                  {badge ? <span className="badge num" aria-label={t('{badge} urgent', { badge })}>{badge}</span> : null}
                </span>
                {t(label)}
              </a>
            </NavSlot>
          )
        })}
      </nav>
    </div>
  )
}

function NavSlot({ snap, children }: { snap: React.ReactNode; children: React.ReactNode }) {
  return <>{snap}{children}</>
}
