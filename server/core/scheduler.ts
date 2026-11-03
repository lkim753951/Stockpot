import { background } from './background.ts'
import { config } from './config.ts'
import { all, claim, daysAgo, get, nowIso, releaseClaim, run } from './db.ts'
import { localTime, syncDemoClock } from './clock.ts'
import { refreshActions } from '../operations/actions.ts'
import { ensureRuns, flagOverdue } from '../operations/checklists.ts'
import { runWeeklySummary } from '../ai/analyst.ts'
import { sweepCalls } from '../operations/calls.ts'
import { sendDueChecklists } from '../operations/team.ts'
import { checkInbox } from '../integrations/gmail.ts'
import { chaseLate } from '../operations/chase.ts'
import { backupIfDue } from './backup.ts'
import { sweepInvoices } from '../setup/documents.ts'
import { removeFile } from './files.ts'
import { loadStaff } from '../integrations/whatsapp.ts'

/** Everything that keeps the staff lists and the owner's inbox current. */
export async function tick() {
  await ensureRuns()
  await flagOverdue()
  await refreshActions()
}

/** The weekly investigation is the slow part, so it only starts with enough of a function's time left for it. */
const WEEKLY_NEEDS_MS = 240000
const PASS_LIMIT_MS = 280000

async function weeklyIfDue(left: number) {
  // In sample mode the owner starts it, because the investigation is part of the demo.
  if (config.mode === 'sample' || left < WEEKLY_NEEDS_MS) return
  const now = localTime()
  const monday = new Date(`${now.date}T12:00:00Z`).getUTCDay() === 1
  if (!monday || now.time < '06:00') return
  if (await get('SELECT id FROM weekly_reports WHERE week_start = ?', daysAgo(7))) return
  if (!await get('SELECT id FROM sales WHERE date >= ? LIMIT 1', daysAgo(7))) return
  const key = `weekly:${daysAgo(7)}`
  if (!await claim(key, 10 * 60000)) return
  // If it fails, the next pass tries again.
  try { await runWeeklySummary() } finally { await releaseClaim(key) }
}

/** Supplier invoices come in on their own every 15 minutes once Gmail is linked. */
async function mailIfDue() {
  if (await claim('gmail', 14 * 60000)) await checkInbox()
}

/** An upload the browser asked for and never used. Tickets last 15 minutes, so a day is well past it. */
async function sweepUploads() {
  const day = new Date(Date.now() - 86400000).toISOString()
  for (const row of await all('SELECT name, used_at FROM uploads WHERE created_at < ?', day)) {
    if ((await run('DELETE FROM uploads WHERE name = ?', row.name)).changes && !row.used_at) await removeFile(String(row.name))
  }
}

/**
 * One go at everything on a timer. Cron calls this on Vercel and a local timer calls it on a Mac.
 * Two can overlap, because each step claims its own work before doing it. Sending comes before
 * chasing so a list always goes out first, and the slow, optional work comes last.
 */
export async function onePass() {
  const started = Date.now()
  await syncDemoClock()
  await loadStaff()
  const results: Record<string, 'ok' | 'failed'> = {}
  const step = async (name: string, work: () => Promise<unknown>) => {
    if (Date.now() - started > PASS_LIMIT_MS) return
    try {
      await work()
      results[name] = 'ok'
    } catch (error) {
      results[name] = 'failed'
      console.error(`${name}:`, (error as Error).message)
    }
  }
  await step('checklists', tick)
  await step('backup', backupIfDue)
  await step('send', sendDueChecklists)
  await step('chase', chaseLate)
  await step('calls', sweepCalls)
  await step('invoices', sweepInvoices)
  await step('uploads', sweepUploads)
  await step('gmail', mailIfDue)
  await step('weekly', () => weeklyIfDue(PASS_LIMIT_MS - (Date.now() - started)))
  return { at: nowIso(), ms: Date.now() - started, results }
}

/** Vercel has no process that stays up, so /api/cron does this there. */
export function startScheduler() {
  if (process.env.VERCEL) return
  const beat = () => background('scheduler', onePass)
  beat()
  setInterval(beat, 60000).unref()
}
