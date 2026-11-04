import { all, get, insert, nowIso, run } from '../core/db.ts'
import { addDays, localTime, mondayOf } from '../core/clock.ts'
import { addAction, closeAction } from './actions.ts'
import { t } from '../core/lang.ts'
import { occursOn, scheduleFor } from '../core/schedule.ts'

const proofRow = async (id: unknown) => (id ? await get('SELECT * FROM proof_checks WHERE id = ?', id) ?? null : null)

function periodFor(frequency: string, date: string) {
  if (frequency === 'daily') return { period: date, dueDate: date }
  if (frequency === 'weekly') {
    const monday = mondayOf(date)
    return { period: monday, dueDate: addDays(monday, 4) }
  }
  return { period: date.slice(0, 7), dueDate: `${date.slice(0, 7)}-28` }
}

/** Puts this period's checks on the staff phones. Safe to call at any time. */
export async function ensureRuns() {
  const { date } = localTime()
  for (const template of await all('SELECT * FROM checklist_templates WHERE retired = 0')) {
    const schedule = scheduleFor(template)
    if (schedule && !occursOn(schedule, date)) continue
    const { period, dueDate } = schedule ? { period: date, dueDate: date } : periodFor(String(template.frequency), date)
    await run('INSERT INTO checklist_runs (template_id, period, due_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', template.id, period, `${dueDate}T${template.due_time}`)
  }
}

const NEWEST = '(r.id = (SELECT MAX(newest.id) FROM checklist_runs newest WHERE newest.template_id = r.template_id))'

/** Tells the owner about any check that has passed its due time unfinished. */
export async function flagOverdue() {
  const { stamp } = localTime()
  const late = await all(`SELECT r.id, r.due_at, r.chased_at, t.name FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id
                    WHERE r.completed_at IS NULL AND r.due_at < ? AND ${NEWEST}`, stamp)
  // Yesterday's missed list has already been flagged, so it gives way to today's.
  for (const old of await all(`SELECT a.source_id FROM actions a JOIN checklist_runs r ON r.id = a.source_id
                         WHERE a.source_type = 'overdue' AND a.status = 'open' AND NOT ${NEWEST}`)) await closeAction('overdue', Number(old.source_id))
  for (const lateRun of late) {
    await addAction({ sourceType: 'overdue', sourceId: Number(lateRun.id), urgency: lateRun.chased_at ? 'now' : 'today', title: `${lateRun.name} are overdue`, detail: `Was due at ${String(lateRun.due_at).slice(11, 16)}.`, dueDate: String(lateRun.due_at).slice(0, 10) })
  }
}

async function counts(runId: number) {
  return (await get(`SELECT COUNT(i.id) AS total, COUNT(e.id) AS done, SUM(CASE WHEN e.status = 'flagged' THEN 1 ELSE 0 END) AS flagged
              FROM checklist_runs r JOIN checklist_items i ON i.template_id = r.template_id AND i.retired = 0
              LEFT JOIN checklist_entries e ON e.run_id = r.id AND e.item_id = i.id WHERE r.id = ?`, runId))!
}

const stateOf = (row: Record<string, any>, stamp: string) => row.completed_at ? 'done' : row.due_at < stamp ? 'overdue' : 'due'

export async function listRuns() {
  const { stamp, date } = localTime()
  const rows = await all(`SELECT r.id, r.due_at, r.completed_at, r.sent_at, t.name, t.frequency, t.assignee, t.chase_after FROM checklist_runs r
                    JOIN checklist_templates t ON t.id = r.template_id
                    WHERE t.retired = 0 AND ${NEWEST} AND (r.completed_at IS NULL OR substr(r.completed_at, 1, 10) = ?) ORDER BY r.completed_at IS NOT NULL, r.due_at`, date)
  return await Promise.all(rows.map(async (row) => {
    const count = await counts(Number(row.id))
    return { id: row.id, name: row.name, frequency: row.frequency, assignee: row.assignee, chaseAfter: row.chase_after, dueAt: row.due_at, sentAt: row.sent_at, state: stateOf(row, stamp), done: count.done, total: count.total, flagged: count.flagged ?? 0 }
  }))
}

async function proofView(id: unknown) {
  const proof = await proofRow(id)
  return proof ? { file: proof.file, video: proof.video_file, verdict: proof.verdict, reason: proof.reason, target: proof.target, boxes: JSON.parse(String(proof.boxes)), track: proof.track ? JSON.parse(String(proof.track)) : null } : null
}

export async function runView(runId: number) {
  const row = await get(`SELECT r.*, t.name, t.frequency, t.assignee FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id WHERE r.id = ?`, runId)
  if (!row) return null
  const items = await all(`SELECT i.id, i.label, i.check_type, i.unit, i.min_value, i.max_value, e.id AS entry_id, i.proof, i.proof_hint, e.proof_id, e.value, e.photo_file, e.transcript, e.source, e.status, e.reported_by, e.created_at
                     FROM checklist_items i LEFT JOIN checklist_entries e ON e.item_id = i.id AND e.run_id = ?
                     WHERE i.template_id = ? AND i.retired = 0 ORDER BY i.position`, runId, row.template_id)
  return {
    id: row.id, name: row.name, frequency: row.frequency, assignee: row.assignee, dueAt: row.due_at, completedAt: row.completed_at, state: stateOf(row, localTime().stamp),
    items: await Promise.all(items.map(async (item) => ({
      id: item.id, label: item.label, type: item.check_type, needsProof: !!item.proof, proofHint: item.proof_hint, proofTarget: item.proof_target, unit: item.unit, min: item.min_value, max: item.max_value,
      entry: item.entry_id ? { proof: await proofView(item.proof_id), id: item.entry_id, value: item.value, photo: item.photo_file, transcript: item.transcript, source: item.source, by: item.reported_by, flagged: item.status === 'flagged', at: item.created_at } : null,
    }))),
  }
}

export function itemFor(runId: number, itemId: number) {
  return get(`SELECT i.* FROM checklist_items i JOIN checklist_runs r ON r.template_id = i.template_id WHERE r.id = ? AND i.id = ?`, runId, itemId)
}

export const outOfRange = (item: Record<string, any>, value: number) =>
  (item.min_value !== null && value < item.min_value) || (item.max_value !== null && value > item.max_value)

/** The same range in the reader's language, for anything shown rather than saved. */
export function rangeShown(item: Record<string, any>) {
  const unit = item.unit ?? ''
  if (item.min_value !== null && item.max_value !== null) return t('{low} to {high}', { low: item.min_value, high: `${item.max_value}${unit}` })
  if (item.max_value !== null) return t('{value} or below', { value: `${item.max_value}${unit}` })
  if (item.min_value !== null) return t('{value} or above', { value: `${item.min_value}${unit}` })
  return null
}

export function rangeWords(item: Record<string, any>) {
  const unit = item.unit ?? ''
  if (item.min_value !== null && item.max_value !== null) return `${item.min_value} to ${item.max_value}${unit}`
  if (item.max_value !== null) return `${item.max_value}${unit} or below`
  if (item.min_value !== null) return `${item.min_value}${unit} or above`
  return null
}

export interface EntryInput {
  value?: number | null
  source?: 'tick' | 'typed' | 'voice' | 'photo' | 'whatsapp' | 'phone'
  transcript?: string | null
  photoFile?: string | null
  reportedBy?: string | null
  proofId?: number | null
}

/** Saves what staff confirmed. The range check is plain code, so a model can't talk a reading into range. */
export async function saveEntry(runId: number, itemId: number, input: EntryInput) {
  const item = await itemFor(runId, itemId)
  if (!item) return { error: 'That check is not on this list.' }
  const proof = await proofRow(input.proofId)
  const proved = proof && Number(proof.run_id) === runId && Number(proof.item_id) === itemId
  if (item.proof && !proved && !input.photoFile) return { error: 'Add a photo or video first.' }
  const numeric = item.check_type !== 'tick'
  const value = numeric ? Number(input.value) : null
  if (numeric && (input.value === null || input.value === undefined || !Number.isFinite(value))) return { error: 'Enter a reading first.' }

  const flagged = numeric && outOfRange(item, value!)
  await run(`INSERT INTO checklist_entries (run_id, item_id, value, photo_file, transcript, source, status, reported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, item_id) DO UPDATE SET proof_id = NULL, value = excluded.value, photo_file = excluded.photo_file, transcript = excluded.transcript,
         source = excluded.source, status = excluded.status, reported_by = excluded.reported_by, created_at = excluded.created_at`,
    runId, itemId, value, input.photoFile ?? null, input.transcript ?? null, input.source ?? 'tick', flagged ? 'flagged' : 'done', input.reportedBy ?? null, nowIso())
  const entry = (await get('SELECT id FROM checklist_entries WHERE run_id = ? AND item_id = ?', runId, itemId))!
  if (proof && proved) {
    await run('UPDATE checklist_entries SET proof_id = ? WHERE id = ?', proof.id, entry.id)
    // The worker can save over a "recheck", and the owner then sees it. A model never blocks a person.
    if (proof.verdict === 'recheck') await addAction({ sourceType: 'proof', sourceId: Number(entry.id), urgency: 'today', title: `Check the photo: ${item.label}`, detail: String(proof.reason) })
    else await closeAction('proof', Number(entry.id))
  }

  if (flagged) {
    const unit = item.unit ?? ''
    await addAction({
      sourceType: 'reading', sourceId: Number(entry.id), urgency: 'now',
      title: item.check_type === 'stock' ? `${item.label} is low: ${value}${unit ? ` ${unit}` : ''}` : `${item.label} is at ${value}${unit}`,
      detail: `Should be ${rangeWords(item)}.`,
    })
  } else {
    await closeAction('reading', Number(entry.id))
  }

  const count = await counts(runId)
  if (Number(count.done) === Number(count.total)) {
    await run('UPDATE checklist_runs SET completed_at = COALESCE(completed_at, ?) WHERE id = ?', localTime().stamp, runId)
    await closeAction('overdue', runId)
  }
  return { run: await runView(runId), flagged }
}

/** Unticks a check, so a tick by mistake can be taken back. */
export async function clearEntry(runId: number, itemId: number) {
  const entry = await get('SELECT id FROM checklist_entries WHERE run_id = ? AND item_id = ?', runId, itemId)
  if (!entry) return runView(runId)
  await closeAction('reading', Number(entry.id))
  await closeAction('proof', Number(entry.id))
  await run('DELETE FROM checklist_entries WHERE id = ?', entry.id)
  await run('UPDATE checklist_runs SET completed_at = NULL WHERE id = ?', runId)
  return runView(runId)
}

/** Every check needs a picture unless the owner turns it off. SAM gets a thing to look for where one is obvious. */
export async function useProofByDefault() {
  await run(`UPDATE checklist_items SET proof = 1`)
  await run(`UPDATE checklist_items SET proof_target = 'thermometer' WHERE check_type = 'temperature' AND proof_target IS NULL`)
  await run(`UPDATE checklist_items SET proof_target = 'fire exit', proof_hint = 'Nothing is blocking the fire exit' WHERE label = 'Fire exits clear'`)
}

/** Each checklist in a month: what happened for past days, and what is planned for the rest. */
export async function calendarMonth(month: string) {
  const { date: today, stamp } = localTime()
  const [year, number] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  const templates = await all('SELECT * FROM checklist_templates WHERE retired = 0 ORDER BY due_time')
  const runs = await all(`SELECT id, template_id, due_at, completed_at FROM checklist_runs WHERE substr(due_at, 1, 7) = ?`, month)
  return Array.from({ length: last }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const items = templates.flatMap((template) => {
      const run = runs.find((row) => row.template_id === template.id && String(row.due_at).slice(0, 10) === date)
      const schedule = scheduleFor(template)
      const due = schedule ? occursOn(schedule, date) : template.frequency === 'daily' || periodFor(String(template.frequency), date).dueDate === date
      if (!run && (!due || date < today)) return []
      return [{ name: template.name, time: template.due_time, assignee: template.assignee, runId: run?.id ?? null, state: run ? stateOf(run, stamp) : 'planned' }]
    })
    return { date, items }
  })
}

export async function seedChecklists() {
  const template = async (name: string, frequency: string, dueTime: string, items: Array<[string, string, string | null, number | null, number | null]>) => {
    const id = await insert('INSERT INTO checklist_templates (name, frequency, due_time) VALUES (?, ?, ?)', name, frequency, dueTime)
    for (const [position, [label, type, unit, min, max]] of items.entries()) {
      await run('INSERT INTO checklist_items (template_id, position, label, check_type, unit, min_value, max_value) VALUES (?, ?, ?, ?, ?, ?, ?)', id, position, label, type, unit, min, max)
    }
  }
  await template('Fridge and water checks', 'daily', '08:00', [
    ['Fridge one', 'temperature', '°C', null, 8],
    ['Fridge two', 'temperature', '°C', null, 8],
    ['Freezer', 'temperature', '°C', null, -18],
    ['Hot water', 'temperature', '°C', 50, null],
  ])
  await template('Opening checks', 'daily', '11:00', [
    ['Lights and power on', 'tick', null, null, null],
    ['Surfaces cleaned', 'tick', null, null, null],
    ['Hand wash stocked', 'tick', null, null, null],
  ])
  await template('Closing checks', 'daily', '22:00', [
    ['Cookers and fryers off', 'tick', null, null, null],
    ['Food covered and put away', 'tick', null, null, null],
    ['Bins out', 'tick', null, null, null],
    ['Doors locked', 'tick', null, null, null],
  ])
  await template('Weekly stock check', 'weekly', '10:00', [
    ['Chicken thighs', 'stock', 'kg', 10, null],
    ['Brown onions', 'stock', 'kg', 5, null],
    ['Basmati rice', 'stock', 'kg', 5, null],
  ])
  await template('Monthly safety checks', 'monthly', '12:00', [
    ['Fuse board checked', 'tick', null, null, null],
    ['First aid kit full', 'tick', null, null, null],
    ['Fire exits clear', 'tick', null, null, null],
  ])
  await useProofByDefault()
}
