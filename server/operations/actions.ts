import { background } from '../core/background.ts'
import { all, get, insert, isoDate, nowIso, run } from '../core/db.ts'
import { addDays } from '../core/clock.ts'
import { listChecks } from './checks.ts'
import { formatPounds } from '../money/money.ts'
import { sendWhatsAppAlert } from '../integrations/whatsapp.ts'
import { t, tSaved } from '../core/lang.ts'

export type Urgency = 'now' | 'today' | 'soon'

export interface NewAction {
  sourceType: 'order' | 'check' | 'task' | 'overdue' | 'reading' | 'report' | 'summary' | 'suggestion' | 'proof' | 'delivery' | 'manual' | 'problem'
  sourceId: number
  urgency: Urgency
  title: string
  detail?: string | null
  dueDate?: string | null
  /** Someone could be hurt or made ill. The owner hears at once, with nothing to confirm first. */
  safety?: boolean
}

/** What comes in from a call, a report or a delivery check is a suggestion until the owner says yes. */
const NEEDS_CONFIRMING = new Set<NewAction['sourceType']>(['task', 'report', 'problem'])
const STILL_LIVE = `status IN ('open', 'proposed')`

/**
 * Every feature reaches the owner through this one function. An item the owner has closed or dismissed stays that way.
 * The row goes in first, so when two passes overlap only the one that added it sends the alert.
 */
export async function addAction(action: NewAction) {
  const proposed = NEEDS_CONFIRMING.has(action.sourceType) && !action.safety
  const added = await insert(`INSERT INTO actions (source_type, source_id, urgency, title, detail, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                              ON CONFLICT (source_type, source_id) DO NOTHING`,
    action.sourceType, action.sourceId, action.urgency, action.title, action.detail ?? null, action.dueDate ?? null, proposed ? 'proposed' : 'open', nowIso())
  if (added) {
    if (action.urgency === 'now') background('alert', () => sendWhatsAppAlert(added, action.title, action.detail ?? null, proposed))
    return added
  }
  await run(`UPDATE actions SET urgency = CASE WHEN urgency_set = 1 THEN urgency ELSE ? END, title = ?, detail = ?, due_date = ?
             WHERE source_type = ? AND source_id = ? AND ${STILL_LIVE}`, action.urgency, action.title, action.detail ?? null, action.dueDate ?? null, action.sourceType, action.sourceId)
  return Number((await get('SELECT id FROM actions WHERE source_type = ? AND source_id = ?', action.sourceType, action.sourceId))!.id)
}

export async function closeAction(sourceType: NewAction['sourceType'], sourceId: number) {
  await run(`UPDATE actions SET status = 'done', closed_at = ? WHERE source_type = ? AND source_id = ? AND ${STILL_LIVE}`, nowIso(), sourceType, sourceId)
}

/** Brings the inbox into line with orders, money checks and call tasks, which all change in their own screens. */
export async function refreshActions() {
  const today = isoDate()
  const openIds = async (type: string) => new Set((await all(`SELECT source_id FROM actions WHERE source_type = ? AND ${STILL_LIVE}`, type)).map((row) => Number(row.source_id)))

  const drafts = await all(`SELECT o.id, s.name AS supplier, o.summary FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.status = 'draft'`)
  for (const order of drafts) {
    await addAction({ sourceType: 'order', sourceId: Number(order.id), urgency: 'today', title: `Check the ${order.supplier} order`, detail: order.summary })
  }
  const draftIds = new Set(drafts.map((order) => Number(order.id)))
  for (const id of await openIds('order')) if (!draftIds.has(id)) await closeAction('order', id)

  const owed = (await listChecks()).filter((check) => check.state === 'owed' && check.credit?.status !== 'settled')
  for (const check of owed) {
    await addAction({ sourceType: 'check', sourceId: check.orderId, urgency: 'today', title: `${formatPounds(check.owedPence)} to claim from ${check.supplier}`, detail: "The invoice doesn't match the call and the delivery." })
  }
  const owedIds = new Set(owed.map((check) => check.orderId))
  for (const id of await openIds('check')) if (!owedIds.has(id)) await closeAction('check', id)

  // A delivery due today with nothing logged yet. Nobody has to remember to look.
  const arriving = await all(`SELECT o.id, s.name AS supplier, o.delivery_date FROM orders o JOIN suppliers s ON s.id = o.supplier_id JOIN deliveries d ON d.order_id = o.id
                        WHERE o.status = 'confirmed' AND o.delivery_date IS NOT NULL AND o.delivery_date <= ? AND d.status != 'done'`, today)
  for (const order of arriving) {
    await addAction({ sourceType: 'delivery', sourceId: Number(order.id), urgency: 'today', title: `Delivery from ${order.supplier} is due`, detail: 'Ask staff to check it in, or send a photo of the delivery note.', dueDate: order.delivery_date })
  }
  const arrivingIds = new Set(arriving.map((order) => Number(order.id)))
  for (const id of await openIds('delivery')) if (!arrivingIds.has(id)) await closeAction('delivery', id)

  const tasks = await all('SELECT id, title, due_date, urgency FROM tasks WHERE done = 0')
  for (const task of tasks) {
    const urgency = task.urgency === 'urgent' ? 'now' : task.urgency === 'not_important' ? 'soon' : task.due_date && task.due_date <= today ? 'today' : 'soon'
    await addAction({ sourceType: 'task', sourceId: Number(task.id), urgency, title: String(task.title), dueDate: task.due_date })
  }
  const taskIds = new Set(tasks.map((task) => Number(task.id)))
  for (const id of await openIds('task')) if (!taskIds.has(id)) await closeAction('task', id)
}

const view = async (row: Record<string, any>) => ({
  id: row.id, sourceType: row.source_type, urgency: row.urgency, urgencySet: !!row.urgency_set, title: tSaved(String(row.title)), detail: row.detail ? tSaved(String(row.detail)) : row.detail, dueDate: row.due_date,
  createdAt: row.created_at, closedAt: row.closed_at, assignedTo: row.assigned_to, person: await personFor(row), href: await linkFor(row), source: await sourceOf(row), suggested: await suggestionFor(row),
  closable: !['order', 'check', 'overdue', 'delivery'].includes(String(row.source_type)),
})

/**
 * Whose job a card is, for the owner's and staff's trackers. A late checklist belongs to whoever the list is for, or the whole
 * team. A card handed to someone is theirs. Everything else is the owner's: reviewing a photo or a report is the owner's call.
 */
async function personFor(row: Record<string, any>) {
  if (row.assigned_to) return String(row.assigned_to)
  if (row.source_type !== 'overdue') return 'Owner'
  const list = await get('SELECT t.assignee FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id WHERE r.id = ?', Number(row.source_id))
  return list?.assignee ? String(list.assignee) : 'Everyone'
}

const byWhom = (name: unknown, how: unknown) => (how === 'whatsapp' ? t('{name} on WhatsApp', { name: String(name ?? t('Staff')) }) : String(name ?? t('Staff')))

/** Where a card came from, so the owner can see it isn't a guess. */
async function sourceOf(row: Record<string, any>) {
  const id = Number(row.source_id)
  switch (row.source_type) {
    case 'order': {
      const order = await get('SELECT s.name FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?', id)
      return t('Call with {name}', { name: String(order?.name ?? t('a supplier')) })
    }
    case 'check': return t('Invoice checked against the call and delivery')
    case 'task': {
      const call = await get('SELECT s.name FROM tasks t JOIN calls c ON c.id = t.call_id JOIN suppliers s ON s.id = c.supplier_id WHERE t.id = ?', id)
      return t('Call with {name}', { name: String(call?.name ?? t('a supplier')) })
    }
    case 'overdue': return t('Checklist')
    case 'proof': return t('Staff photo')
    case 'manual': return t('You added this')
    case 'problem': return t('Delivery check-in')
    case 'delivery': return t('Order')
    case 'reading': {
      const entry = await get(`SELECT e.source, e.reported_by, t.name FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_templates t ON t.id = r.template_id WHERE e.id = ?`, id)
      return entry ? `${t(String(entry.name))}, ${byWhom(entry.reported_by, entry.source)}` : t('Checklist')
    }
    case 'report': {
      const report = await get('SELECT language, reporter, photo_file FROM staff_reports WHERE id = ?', id)
      return report?.language ? t('{name} reported this in {language}', { name: String(report.reporter ?? t('Staff')), language: t(String(report.language)) }) : t('{name} reported this', { name: String(report?.reporter ?? t('Staff')) })
    }
    case 'summary':
    case 'suggestion': return t('Summary')
    default: return 'Stockpot'
  }
}

/** The one thing to do next. Nothing here acts on its own: each one opens the screen where the owner decides. */
async function suggestionFor(row: Record<string, any>) {
  const href = await linkFor(row)
  switch (row.source_type) {
    case 'order': return { label: t('Check order'), href }
    case 'check': return { label: t('Claim it back'), href }
    case 'overdue': return { label: t('See what is left'), href }
    case 'proof': return { label: t('See the photo'), href }
    case 'delivery':
    case 'problem': {
      const supplier = await get('SELECT s.name, s.phone FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?', Number(row.source_id))
      return supplier?.phone ? { label: t('Call {name}', { name: String(supplier.name) }), href: `tel:${String(supplier.phone).replace(/[^\d+]/g, '')}` } : { label: t('See the delivery'), href }
    }
    case 'reading': {
      const stock = /is low:/.test(String(row.title))
      return stock ? { label: t('Record a call'), href: '#/call' } : { label: t('Open the fridge card'), href: '#/crisis/fridge' }
    }
    case 'report': {
      const report = await get('SELECT crisis_key FROM staff_reports WHERE id = ?', Number(row.source_id))
      return report?.crisis_key ? { label: t('Open the crisis card'), href: `#/crisis/${report.crisis_key}` } : { label: t('Read report'), href }
    }
    case 'task': return href ? { label: t('Open order'), href } : null
    case 'summary':
    case 'suggestion': return { label: t('See why'), href }
    default: return null
  }
}

async function linkFor(row: Record<string, any>) {
  const id = Number(row.source_id)
  switch (row.source_type) {
    case 'order': return `#/order/${id}`
    case 'check': return `#/checks/${id}`
    case 'task': {
      const order = await get('SELECT o.id FROM orders o JOIN tasks t ON t.call_id = o.call_id WHERE t.id = ?', id)
      return order ? `#/order/${order.id}` : null
    }
    case 'overdue': return `#/run/${id}`
    case 'proof':
      return ((entry) => (entry ? `#/run/${entry.run_id}` : null))(await get('SELECT run_id FROM checklist_entries WHERE id = ?', id))
    case 'delivery':
    case 'problem': return `#/checks/${id}`
    case 'reading': {
      const entry = await get('SELECT run_id FROM checklist_entries WHERE id = ?', id)
      return entry ? `#/run/${entry.run_id}` : null
    }
    case 'report': return `#/report/${id}`
    case 'summary':
    case 'suggestion': return '#/dashboard'
    default: return null
  }
}

export async function listActions() {
  const rows = await all(`SELECT * FROM actions WHERE status = 'open' AND (snoozed_until IS NULL OR snoozed_until <= ?)
                    ORDER BY CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END, due_date IS NULL, due_date, id DESC`, isoDate())
  return await Promise.all(rows.map(view))
}

/** New items waiting for a yes. They stay out of the lists and the badge until then. */
export async function listProposed() {
  const rows = await all(`SELECT * FROM actions WHERE status = 'proposed' ORDER BY CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END, id DESC`)
  return Promise.all(rows.map(view))
}

export async function confirmAction(id: number) {
  return (await run(`UPDATE actions SET status = 'open' WHERE id = ? AND status = 'proposed'`, id)).changes > 0
}

/** Gone for good. The row stays as dismissed, which is what stops a refresh from suggesting it again. */
export async function dismissAction(id: number) {
  const row = await get(`SELECT source_type, source_id FROM actions WHERE id = ? AND status = 'proposed'`, id)
  if (!row) return false
  await run(`UPDATE actions SET status = 'dismissed', closed_at = ? WHERE id = ?`, nowIso(), id)
  if (row.source_type === 'task') await run('UPDATE tasks SET done = 1 WHERE id = ?', row.source_id)
  return true
}

/** What was ticked off today, so a tick by mistake can be undone. */
export async function listDoneToday() {
  const rows = await all(`SELECT * FROM actions WHERE status = 'done' AND substr(closed_at, 1, 10) = ? AND source_type NOT IN ('order', 'check', 'overdue') ORDER BY closed_at DESC LIMIT 20`, isoDate())
  return await Promise.all(rows.map(view))
}

/** Closes an item from the inbox. A task stays done in the order view too. */
export async function finishAction(id: number) {
  const row = await get('SELECT * FROM actions WHERE id = ?', id)
  if (!row) return false
  if (row.source_type === 'task') await run('UPDATE tasks SET done = 1 WHERE id = ?', row.source_id)
  await closeAction(row.source_type, Number(row.source_id))
  return true
}

/** Out of sight until tomorrow. It comes back on its own. */
export async function snoozeAction(id: number) {
  return Number((await run(`UPDATE actions SET snoozed_until = ? WHERE id = ? AND status = 'open'`, addDays(isoDate(), 1), id)).changes) > 0
}

/** The owner has the last word on how much something matters, and the app keeps to it. */
export async function setUrgency(id: number, urgency: Urgency) {
  return Number((await run('UPDATE actions SET urgency = ?, urgency_set = 1 WHERE id = ?', urgency, id)).changes) > 0
}

export function addOwnAction(title: string, urgency: Urgency, dueDate: string | null) {
  return addAction({ sourceType: 'manual', sourceId: Date.now(), urgency, title, dueDate })
}

export async function assignAction(id: number, name: string) {
  await run('UPDATE actions SET assigned_to = ? WHERE id = ?', name, id)
  return await get('SELECT title, detail FROM actions WHERE id = ?', id) ?? null
}

export async function reopenAction(id: number) {
  const row = await get('SELECT * FROM actions WHERE id = ?', id)
  if (!row) return false
  if (row.source_type === 'task') await run('UPDATE tasks SET done = 0 WHERE id = ?', row.source_id)
  await run(`UPDATE actions SET status = 'open', closed_at = NULL WHERE id = ?`, id)
  return true
}
