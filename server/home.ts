import { all, daysAgo, get, isoDate } from './db.ts'
import { localTime } from './clock.ts'
import { listActions, listDoneToday, listProposed } from './actions.ts'
import { listChecks, weekSummary } from './checks.ts'
import { listRuns } from './checklists.ts'
import { weeklyFacts } from './analyst.ts'
import { whatsappReady } from './whatsapp.ts'
import { config } from './config.ts'
import { crisisCards } from './crisisCards.ts'
import { hasSampleData, setupSteps } from './setup.ts'
import { t, tn } from './lang.ts'

const percentChange = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null)

async function dishesSold(from: string, to: string) {
  return Number((await get('SELECT COALESCE(SUM(qty), 0) AS sold FROM sales WHERE date BETWEEN ? AND ?', from, to))?.sold ?? 0)
}

async function stockAlerts() {
  return (await all(`SELECT id FROM actions WHERE status = 'open' AND source_type = 'reading' AND title LIKE '%is low:%'`)).length
}

/** One sentence from real counts, so the line at the top of Home can never overstate what's there. */
function statusLine(actions: Array<{ urgency: string }>, overdue: number) {
  const urgent = actions.filter((action) => action.urgency === 'now').length
  const today = actions.filter((action) => action.urgency === 'today').length
  if (urgent && today) return tn(urgent, '{n} urgent thing needs you, and {today} more today.', '{n} urgent things need you, and {today} more today.', { today })
  if (urgent) return tn(urgent, '{n} urgent thing needs you.', '{n} urgent things need you.')
  if (today) return tn(today, '{n} thing needs you today. Everything else is on track.', '{n} things need you today. Everything else is on track.')
  if (overdue) return tn(overdue, '{n} checklist is overdue. Nothing else needs you.', '{n} checklists are overdue. Nothing else needs you.')
  return t('Nothing needs you right now.')
}

export async function homeView() {
  const facts = await weeklyFacts()
  const week = await weekSummary()
  const actions = await listActions()
  const runs = await listRuns()
  const checks = await listChecks()
  const sold = await dishesSold(facts.period.from, facts.period.to)
  const soldBefore = await dishesSold(facts.previous.from, facts.previous.to)
  const toCheck = Number((await get(`SELECT COUNT(*) AS lines FROM invoice_lines WHERE issue IS NOT NULL`))?.lines ?? 0)
  const invoices = Number((await get('SELECT COUNT(*) AS read FROM invoices'))?.read ?? 0)
  const callsThisWeek = Number((await get(`SELECT COUNT(*) AS calls FROM calls WHERE status = 'done' AND COALESCE(started_at, consent_at) >= ?`, daysAgo(7)))?.calls ?? 0)
  const tasksOpen = Number((await get('SELECT COUNT(*) AS open FROM tasks WHERE done = 0'))?.open ?? 0)
  const today = runs.filter((run) => run.frequency === 'daily')
  const overdue = runs.filter((run) => run.state === 'overdue').length
  const reports = (await all(`SELECT id FROM actions WHERE status = 'open' AND source_type = 'report'`)).length
  const owed = checks.filter((check) => check.state === 'owed' && check.credit?.status !== 'settled')
  const below = facts.dishes.filter((dish) => dish.margin_percent !== null && dish.margin_percent < dish.target_margin_percent).length
  return {
    checkedAt: localTime().time,
    teamLinked: whatsappReady(),
    date: isoDate(),
    status: statusLine(actions, overdue),
    actions,
    toConfirm: await listProposed(),
    doneToday: await listDoneToday(),
    tiles: {
      sales: { pence: facts.food_cost.net_sales_pence, change: percentChange(facts.food_cost.net_sales_pence, facts.previous_food_cost.net_sales_pence) },
      dishes: { sold, change: percentChange(sold, soldBefore) },
      foodCost: { percent: facts.food_cost.food_cost_percent, change: facts.food_cost_change_points },
      stock: { open: await stockAlerts() },
    },
    week: { foundPence: week.foundPence, talkedDownPence: week.talkedDownPence },
    setup: { steps: (await setupSteps()).map((step) => ({ ...step, label: t(step.label) })), sampleData: await hasSampleData() },
    features: [
      { key: 'receipts', label: t('Receipts'), href: '#/receipts', state: toCheck ? 'attention' : invoices ? 'good' : 'idle', note: toCheck ? tn(toCheck, '{n} line to check', '{n} lines to check') : invoices ? tn(invoices, '{n} receipt read', '{n} receipts read') : t('None yet') },
      { key: 'calls', label: t('Calls'), href: '#/calls', state: tasksOpen ? 'attention' : callsThisWeek ? 'good' : 'idle', note: tasksOpen ? tn(tasksOpen, '{n} task open', '{n} tasks open') : callsThisWeek ? tn(callsThisWeek, '{n} call this week', '{n} calls this week') : t('None this week') },
      { key: 'checklists', label: t('Checklists'), href: '#/checklists', state: overdue ? 'attention' : 'good', note: overdue ? t('{count} overdue', { count: overdue }) : t('{done} of {total} done today', { done: today.filter((run) => run.state === 'done').length, total: today.length }) },
      { key: 'reports', label: t('Staff reports'), href: '#/actions', state: reports ? 'attention' : 'good', note: reports ? t('{count} open', { count: reports }) : t('None open') },
      { key: 'deliveries', label: t('Deliveries'), href: '#/checks', state: owed.length || checks.some((check) => check.problem) ? 'attention' : 'good', note: owed.length ? tn(owed.length, '{n} claim open', '{n} claims open') : t('{count} waiting', { count: checks.filter((check) => check.state === 'waiting').length }) },
      { key: 'crisis', label: t('Crisis cards'), href: '#/crisis', state: 'good', note: t('{count} ready', { count: (await crisisCards()).length }) },
      { key: 'analyst', label: t('AI analyst'), href: '#/dashboard', state: below ? 'attention' : 'good', note: below ? tn(below, '{n} dish below target', '{n} dishes below target') : t('On target') },
    ],
  }
}
