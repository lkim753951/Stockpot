import { nowIso, run, setting, all } from '../core/db.ts'
import { localTime } from '../core/clock.ts'
import { inLanguage, languageName, t } from '../core/lang.ts'
import { sparkJson } from '../ai/meta.ts'
import { reminderCallPrompt, reminderCallSchema } from '../ai/prompts.ts'
import { runView } from './checklists.ts'
import { ownerPhone, placeAgentCall, spokenLanguage } from '../integrations/phone.ts'
import { assigneesFor, sendToPerson, team, whatsappReady, type Contact } from '../integrations/whatsapp.ts'

/**
 * A check that isn't finished. Each list chases once, at the time the owner chose, from an hour before
 * it's due to an hour or more after. A chase before the due time goes to the person. From the due time
 * on, the person gets one WhatsApp, and then the owner hears, and a phone rings if the list asks for that.
 */

/** The earliest choice on the checklist screen, 60 minutes before. */
export const EARLIEST_CHASE = -60
/** A list goes out an hour before it's due. A chase right on its heels would only repeat it. */
const LIST_HEAD_START_MS = 4 * 60000

const minutesLate = (dueAt: string, stamp: string) => (Date.parse(`${stamp}:00Z`) - Date.parse(`${dueAt}:00Z`)) / 60000
const later = (stamp: string, minutes: number) => new Date(Date.parse(`${stamp}:00Z`) + minutes * 60000).toISOString().slice(0, 16)

const languageFor = async (person: { name: string; language?: string | null }) => await setting(`language:${person.name}`) ?? person.language ?? 'en'

/** Calls need only Twilio, so a late list can ring someone before WhatsApp is connected. */
const toRing = (assignee: unknown) => assigneesFor(assignee)

async function message(person: Pick<Contact, 'name' | 'number' | 'language'>, words: () => string) {
  await inLanguage(await languageFor(person), () => sendToPerson({ to: person, text: words() }))
}

/** Only one pass can mark a step, so when two overlap nobody gets it twice. */
const claimStep = async (step: 'reminded_at' | 'chased_at', id: unknown) =>
  (await run(`UPDATE checklist_runs SET ${step} = ? WHERE id = ? AND ${step} IS NULL`, nowIso(), id)).changes > 0

export async function chaseLate() {
  const { stamp } = localTime()
  const open = await all(`SELECT r.id, r.due_at, r.sent_at, r.reminded_at, r.chased_at, t.name, t.assignee, t.chase_after, t.call_who, t.language FROM checklist_runs r
                          JOIN checklist_templates t ON t.id = r.template_id
                          WHERE r.completed_at IS NULL AND t.retired = 0 AND t.chase_after IS NOT NULL AND r.due_at <= ? AND (r.reminded_at IS NULL OR r.chased_at IS NULL)`, later(stamp, -EARLIEST_CHASE))
  for (const row of open) {
    const minutes = minutesLate(String(row.due_at), stamp)
    if (minutes > 720) continue
    const name = String(row.name)
    const time = String(row.due_at).slice(11, 16)
    const chaseAt = Number(row.chase_after)
    const people = whatsappReady() ? assigneesFor(row.assignee) : []

    if (minutes <= 0) {
      if (chaseAt >= 0 || minutes < chaseAt) continue
      // Staff can't be chased for a list they haven't been sent.
      if (whatsappReady() && !(row.sent_at && Date.now() - Date.parse(String(row.sent_at)) >= LIST_HEAD_START_MS)) continue
      if (!await claimStep('chased_at', row.id)) continue
      await run('UPDATE checklist_runs SET reminded_at = COALESCE(reminded_at, ?) WHERE id = ?', nowIso(), row.id)
      await Promise.all(people.map((person) => message(person, () => t('{name} is due at {time} and is not done yet.', { name: t(name), time }))))
      await ring(row, (who) => `This is Stockpot. ${name} is due at ${time} and ${who} has not finished it.`, () => t('This is Stockpot. {name} is due at {time} and is not done yet.', { name: t(name), time }))
      continue
    }

    if (!row.reminded_at && await claimStep('reminded_at', row.id)) {
      await Promise.all(people.map((person) => message(person, () => t('{name} was due at {time} and is not done yet.', { name: t(name), time }))))
    }
    if (minutes < chaseAt || row.chased_at) continue
    if (!await claimStep('chased_at', row.id)) continue
    await run(`UPDATE actions SET urgency = 'now', urgency_set = 1 WHERE source_type = 'overdue' AND source_id = ?`, row.id)
    await ring(row, (who) => `This is Stockpot. ${name} was due at ${time} and ${who} has not finished it.`, () => t('This is Stockpot. {name} was due at {time} and is not done yet.', { name: t(name), time }))
  }
}

const LONGEST_MESSAGE = 400

/** Muse Spark words the call around what is really left. If it can't, the plain sentence still goes. */
async function callWords(row: Record<string, any>, language: string, plain: string, person?: string) {
  try {
    const view = await runView(Number(row.id))
    const notDone = (view?.items ?? []).filter((item) => !item.entry).map((item) => t(String(item.label)))
    const facts = { person: person ?? null, checklist: t(String(row.name)), due_time: String(row.due_at).slice(11, 16), late: minutesLate(String(row.due_at), localTime().stamp) > 0, not_done: notDone }
    const { message } = await sparkJson<{ message: string }>({
      name: 'reminder_call', schema: reminderCallSchema, system: reminderCallPrompt(languageName()), effort: 'low', attempts: 1, timeoutMs: 15000,
      content: [{ type: 'text', text: JSON.stringify(facts) }],
    })
    return message.trim().slice(0, LONGEST_MESSAGE) || plain
  } catch (error) {
    console.error('call words:', (error as Error).message)
    return plain
  }
}

async function ring(row: Record<string, any>, toOwner: (who: string) => string, toPerson: () => string) {
  const chosen = row.language ? String(row.language) : null
  if (row.call_who === 'assignee') {
    for (const person of toRing(row.assignee)) {
      const language = spokenLanguage(chosen ?? await languageFor(person))
      await placeAgentCall(person.number, await inLanguage(language, () => callWords(row, language, toPerson(), person.name)), language, Number(row.id), person.name)
    }
  } else if (row.call_who === 'owner') {
    const language = spokenLanguage(chosen ?? 'en')
    const plain = language === 'en' ? toOwner(row.assignee ? String(row.assignee) : 'Staff') : inLanguage(language, toPerson)
    await placeAgentCall(ownerPhone(), await inLanguage(language, () => callWords(row, language, plain)), language, Number(row.id), 'Owner')
  }
}
