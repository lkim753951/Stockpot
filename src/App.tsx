import { t, tk } from './lib/i18n'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Bell, BellRinging, ChartLineUp, CookingPot, ChatCircleText, ClipboardText, GearSix, House, Moon, Package, SignOut, Siren, SquaresFour, Sun, Tray, Truck } from '@phosphor-icons/react'
import { api } from './lib/api'
import { useTheme } from './lib/theme'
import { alertPermission, alertsSupported, useAlerts, AlertToasts } from './components/alerts'
import { Brand, Segment } from './components/ui'
import { Home } from './screens/Home'
import { Actions } from './screens/Actions'
import { Features } from './screens/Features'
import { Shopping } from './screens/Shopping'
import { Stock } from './screens/Stock'
import { Call } from './screens/Call'
import { CallDetail, Calls } from './screens/Calls'
import { Order } from './screens/Order'
import { Receipts } from './screens/Receipts'
import { Checks, CheckDetail } from './screens/Checks'
import { SalesSettings, Settings, SuppliersSettings, TeamSettings } from './screens/Settings'
import { ImportSettings } from './screens/ImportSettings'
import { MenuSettings } from './screens/MenuSettings'
import { ChecklistSettings } from './screens/ChecklistSettings'
import { LanguageButton } from './components/Language'
import { Agent } from './components/Agent'
import { StaffRecipe, StaffRecipes } from './screens/Recipes'
import { Mascot } from './components/Mascot'
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
export interface Session { role: Role | null; mode: 'live' | 'sample'; needsPasscode: boolean; otherSite: string | null; demoTime: string | null; onboarded: boolean }

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
  { href: 'stock', label: tk('Stock'), Icon: Package },
  { href: 'features', label: tk('Features'), Icon: SquaresFour },
]

const STAFF_TABS = [
  { href: 'staff', label: tk('Today'), Icon: ClipboardText },
  { href: 'staff/report', label: tk('Report'), Icon: ChatCircleText },
  { href: 'staff/recipes', label: tk('Recipes'), Icon: CookingPot },
  { href: 'staff/stock', label: tk('Stock'), Icon: Package },
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
  if (section === 'stock') return <Stock />
  if (section === 'deliveries') return <StaffList />
  if (section && /^\d+$/.test(section)) return <StaffDelivery id={section} sample={sample} />
  return <StaffToday />
}

function OwnerScreen({ parts, sample, onClock }: { parts: string[]; sample: boolean; onClock: () => void }) {
  const [screen, id, step] = parts
  switch (screen) {
    case 'actions': return <Actions sample={sample} />
    case 'features': return <Features />
    case 'shopping': return <Shopping />
    case 'stock': return <Stock owner />
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
      if (id === 'menu') return <MenuSettings sample={sample} />
      if (id === 'import') return <ImportSettings />
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

function ThemeButton() {
  const { theme, toggle } = useTheme()
  const dark = theme === 'dark'
  return <button className="icon-btn" type="button" aria-label={dark ? t('Switch to light mode') : t('Switch to dark mode')} onClick={toggle}>{dark ? <Sun size={24} aria-hidden="true" /> : <Moon size={24} aria-hidden="true" />}</button>
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

  /** Asks the server each time, because a session read before onboarding finished would send the owner back to it. */
  const open = async (role: Role) => {
    markSeen()
    setSeen(true)
    const fresh = role === 'owner' ? await api<Session>('/api/session').catch(() => session) : session
    if (fresh) setSession(fresh)
    window.location.hash = role === 'staff' ? '#/staff' : fresh?.mode === 'live' && !fresh.onboarded ? '#/start' : '#/home'
  }

  const choose = async (role: Role) => {
    if (!session?.role || (session.role === 'staff' && role === 'owner')) {
      if (session?.role) await api('/api/logout', { method: 'POST' })
      await refresh()
      setSignIn(role)
      return
    }
    setSignIn(null)
    await open(role)
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
      ? <Login role={signIn} onRole={setSignIn} onDone={async () => { await refresh(); await open(signIn) }} onBack={() => setSignIn(null)} />
      : <Welcome onChoose={choose} sample={session.mode === 'sample'} otherSite={session.otherSite} />
  }
  if (screen === 'welcome' || (!seen && !window.location.hash)) return <Welcome onChoose={choose} sample={session.mode === 'sample'} otherSite={session.otherSite} />
  if (screen === 'start') return <Onboarding onDone={refresh} />

  const sample = session.mode === 'sample'
  const liveCall = screen === 'call'
  const tabs = staffView ? STAFF_TABS : OWNER_TABS
  const activeTab = staffView
    ? (['report', 'crisis', 'deliveries', 'recipes', 'stock'].includes(parts[1]) ? `staff/${parts[1]}` : parts[1] && /^\d+$/.test(parts[1]) ? 'staff/deliveries' : 'staff')
    : OWNER_PARENT[screen] ?? screen

  const reset = async () => {
    await api('/api/sample/reset', { method: 'POST' })
    window.location.hash = '#/home'
    window.location.reload()
  }

  const logo = (
    <Brand width={128} height={30} />
  )

  return (
    <div className={`shell${staffView ? ' staff' : ''}`}>
      {sample ? (
        <div className="banner">
          <span className="sample-label">{t('SAMPLE DATA')}</span>
          {session.role === 'owner' ? <button type="button" onClick={reset}>{t('Start again')}</button> : null}
        </div>
      ) : null}
      {liveCall ? null : (
        <header className="topbar">
          <a href="#/welcome" aria-label={t('About Stockpot')}>
            <Brand kind="mark" width={32} height={32} />
          </a>
          <div className="topbar-actions">
            <Segment label={t('View as')} value={staffView ? 'staff' : 'owner'} options={[{ value: 'owner', label: t('Owner') }, { value: 'staff', label: t('Staff') }]} onChange={(role) => void choose(role as Role)} />
            {staffView ? <LanguageButton /> : <AlertBell urgent={alerts.count} />}
            <ThemeButton />
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
      <nav className="nav" aria-label={staffView ? t('Staff') : t('Owner')} style={{ ['--tabs' as string]: 6 }}>
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
        {staffView ? null : (
          <a href="#/settings" className={`nav-item nav-settings${route.startsWith('settings') ? ' on' : ''}`} aria-current={route.startsWith('settings') ? 'page' : undefined}>
            <span className="pill"><GearSix size={24} weight={route.startsWith('settings') ? 'fill' : 'regular'} aria-hidden="true" /></span>
            {t('Settings')}
          </a>
        )}
      </nav>
    </div>
  )
}

function NavSlot({ snap, children }: { snap: React.ReactNode; children: React.ReactNode }) {
  return <>{snap}{children}</>
}
