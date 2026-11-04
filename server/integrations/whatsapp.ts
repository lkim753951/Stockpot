import crypto from 'node:crypto'
import { config, saveToEnv } from '../core/config.ts'
import { get, insert, locked, nowIso, run, saveSetting, setting } from '../core/db.ts'
import { t } from '../core/lang.ts'

/**
 * WhatsApp Cloud API. The owner's and staff numbers stay in .env: they are never stored in the
 * database, logged or sent to a browser. Everywhere else a person is known by their name.
 * Free-form text only reaches someone within 24 hours of their last message to the business number.
 * Outside that window, Stockpot uses the approved template in WHATSAPP_TEMPLATE to reach them first.
 */

export interface Contact { name: string; number: string; role: 'owner' | 'staff'; language?: string | null }

export const whatsappReady = () => !!(config.whatsapp.token && config.whatsapp.phoneNumberId && config.whatsapp.ownerNumber)
export const repliesReady = () => whatsappReady() && !!(config.whatsapp.appSecret && config.whatsapp.verifyToken)

/** With nobody listed, the owner's own phone stands in for the team, so a one-phone demo works. */
export function team(): Contact[] {
  const staff = (config.whatsapp.staff ?? []).map((person) => ({ ...person, role: 'staff' as const }))
  if (staff.length) return staff
  return config.whatsapp.ownerNumber ? [{ name: 'Owner', number: config.whatsapp.ownerNumber, role: 'owner' }] : []
}

export function contactFor(number: string): Contact | null {
  if (number && number === config.whatsapp.ownerNumber) return { name: 'Owner', number, role: 'owner' }
  return team().find((person) => person.number === number) ?? null
}

type Staff = typeof config.whatsapp.staff

/**
 * Staff added in the app. On a Mac they go in .env. Vercel has no file to write to and instances
 * share no memory, so there they go in the database, and each request reads the current list.
 */
export async function loadStaff() {
  if (!config.hosted) return
  const saved = await setting('staff_numbers')
  if (saved) config.whatsapp.staff = JSON.parse(saved) as Staff
}

export async function changeStaff(change: (people: Staff) => Staff) {
  if (!config.hosted) {
    const people = change(config.whatsapp.staff)
    return saveToEnv({ WHATSAPP_STAFF_NUMBERS: people.map((person) => [person.name, person.number, person.language].filter(Boolean).join(':')).join(',') })
  }
  await locked('staff', async () => {
    await loadStaff()
    config.whatsapp.staff = change(config.whatsapp.staff)
    await saveSetting('staff_numbers', JSON.stringify(config.whatsapp.staff))
  })
}

const PLAIN_ERRORS: Record<number, string> = {
  131047: "WhatsApp blocked this because that person hasn't messaged the Stockpot number in the last 24 hours. Ask them to send it any message.",
  131030: 'This number is not on the allowed list. Add it under API Setup in your Meta app.',
  190: 'Your WhatsApp token has expired. Run connect-apis.command with a new one.',
}

/** Numbers are stripped, because a provider's error can quote the recipient. */
const scrub = (text: string) => text.replace(/\+?\d{7,}/g, '[number]').slice(0, 240)

async function post(to: string, body: Record<string, unknown>) {
  const response = await fetch(`${config.whatsapp.baseUrl}/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...body }),
    signal: AbortSignal.timeout(15000),
  })
  const payload = (await response.json().catch(() => null)) as { messages?: Array<{ id: string }>; error?: { code?: number; message?: string } } | null
  if (response.ok) return { ok: true, id: payload?.messages?.[0]?.id ?? null, detail: null as string | null }
  const known = payload?.error?.code ? PLAIN_ERRORS[payload.error.code] : undefined
  return { ok: false, id: null, detail: known ?? `WhatsApp said: ${scrub(String(payload?.error?.message ?? response.status))}` }
}

async function record(actionId: number | null, result: { ok: boolean; detail: string | null }) {
  await insert('INSERT INTO message_log (channel, action_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?)', 'whatsapp', actionId, result.ok ? 'sent' : 'failed', result.detail, nowIso())
}

const unreachable = (error: unknown) => ({ ok: false, id: null, detail: `WhatsApp couldn't be reached: ${scrub((error as Error).message)}` })

const WINDOW_MS = 24 * 60 * 60 * 1000
const MARGIN_MS = 15 * 60 * 1000

/** Whether this person wrote in recently enough for free-form text, with a margin before the window shuts. */
async function windowOpen(name: string) {
  const since = new Date(Date.now() - WINDOW_MS + MARGIN_MS).toISOString()
  return !!await get(`SELECT id FROM team_messages WHERE direction = 'in' AND contact = ? AND created_at >= ? LIMIT 1`, name, since)
}

/** Template values can't hold line breaks or long gaps, and the template's own full stop follows them. */
export const templateText = (text: string) => text.replace(/\s*\n+\s*/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 1000).replace(/[.\s]+$/, '')

const templateBody = (text: string) => ({
  type: 'template',
  template: {
    name: config.whatsapp.template,
    language: { code: config.whatsapp.templateLanguage },
    components: [{ type: 'body', parameters: [{ type: 'text', text: templateText(text) }] }],
  },
})

/** Starts with the template when one is set and this person hasn't written in lately. */
async function firstContact(name: string, text: string, freeForm: Record<string, unknown>) {
  return config.whatsapp.template && !await windowOpen(name) ? templateBody(text) : freeForm
}

/** A template Meta hasn't approved fails with a 132 code. The person may still be in their window, so plain text gets a try. */
async function sendFirst(number: string, name: string, text: string, freeForm: Record<string, unknown>) {
  const body = await firstContact(name, text, freeForm)
  const result = await post(number, body)
  return !result.ok && body !== freeForm && /#132\d{3}/.test(String(result.detail)) ? post(number, freeForm) : result
}

/** Never throws, because a failed alert must not stop a reading or a report being saved. */
export async function sendWhatsAppAlert(actionId: number, title: string, detail: string | null, toConfirm = false) {
  if (!whatsappReady()) return
  const lines = [`Stockpot: ${title}`, ...(detail ? [detail] : []), ...(toConfirm ? [t('Open Stockpot to confirm this.')] : [])]
  const text = lines.join('\n')
  await record(actionId, await sendFirst(config.whatsapp.ownerNumber, 'Owner', text, { recipient_type: 'individual', type: 'text', text: { preview_url: false, body: text } }).catch(unreachable))
}

export async function sendWhatsAppTest() {
  if (!whatsappReady()) return { ok: false, detail: 'WhatsApp is not connected yet.' }
  const result = await post(config.whatsapp.ownerNumber, { type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }).catch(unreachable)
  await record(null, result)
  return { ok: result.ok, detail: result.detail }
}

export interface Outgoing {
  to: { name: string; number?: string }
  text: string
  /** Up to three reply buttons, as id and label. Labels stop at 20 characters. */
  buttons?: Array<{ id: string; title: string }>
  runId?: number | null
}

/**
 * Sends to one person and writes it to the team log. With no WhatsApp connected the message is
 * only logged, marked simulated, so the sample restaurant still shows the whole conversation.
 */
export async function sendToPerson({ to, text, buttons, runId = null }: Outgoing) {
  const log = (status: string, id: string | null, detail: string | null) =>
    insert('INSERT INTO team_messages (wa_id, direction, contact, kind, body, run_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, 'out', to.name, buttons ? 'buttons' : 'text', text, runId, status, detail, nowIso())
  if (!whatsappReady() || !to.number) {
    await log('simulated', null, null)
    return { ok: true, simulated: true, detail: null as string | null }
  }
  const body = buttons
    ? { recipient_type: 'individual', type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons: buttons.map((button) => ({ type: 'reply', reply: button })) } } }
    : { recipient_type: 'individual', type: 'text', text: { preview_url: false, body: text } }
  const number = to.number
  const result = await sendFirst(number, to.name, text, body).catch(unreachable)
  await log(result.ok ? 'sent' : 'failed', result.id, result.detail)
  return { ok: result.ok, simulated: false, detail: result.detail }
}

export const MEDIA_LIMIT = 16 * 1024 * 1024

/** Media is two steps: Meta gives a short-lived link, and the file is fetched from it with the same token. */
export async function downloadMedia(mediaId: string) {
  const headers = { Authorization: `Bearer ${config.whatsapp.token}` }
  const info = await fetch(`${config.whatsapp.baseUrl}/${encodeURIComponent(mediaId)}`, { headers, signal: AbortSignal.timeout(15000) })
  if (!info.ok) throw new Error(`WhatsApp media lookup returned ${info.status}`)
  const { url, mime_type: mime, file_size: size } = (await info.json()) as { url: string; mime_type: string; file_size?: number }
  if (size && size > MEDIA_LIMIT) throw new Error('That file is too large.')
  const file = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
  if (!file.ok) throw new Error(`WhatsApp media download returned ${file.status}`)
  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length > MEDIA_LIMIT) throw new Error('That file is too large.')
  return { bytes, mime }
}

/** Meta signs each delivery with the app secret, so a forged message can't fill in a checklist. */
export function signatureValid(raw: Buffer, header: string | undefined) {
  if (!config.whatsapp.appSecret || !header?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(raw).digest('hex')}`)
  const given = Buffer.from(header)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

export async function markDelivery(waId: string, failed: boolean, code?: number) {
  if (!failed) return
  await run(`UPDATE team_messages SET status = 'failed', detail = ? WHERE wa_id = ?`, (code && PLAIN_ERRORS[code]) ?? 'WhatsApp could not deliver this message.', waId)
}
