import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../core/config.ts'
import { get, insert, nowIso } from '../core/db.ts'
import type { Lang } from '../../shared/lang.ts'

/** Real phone calls through Twilio, for a check nobody has finished. The number stays in .env. */

export const phoneReady = () => !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber)

/** The phone that rings for the owner. It can be a different number from their WhatsApp. */
export const ownerPhone = () => config.twilio.ownerNumber || config.whatsapp.ownerNumber

/** Voices listed in Twilio's docs. Anyone else hears English, because a wrong voice fails the whole call. */
const VOICES: Partial<Record<Lang, string>> = {
  en: 'en-GB-Standard-N', pl: 'pl-PL-Standard-F', ro: 'ro-RO-Standard-B', es: 'es-ES-Standard-A', pt: 'pt-PT-Standard-E', it: 'it-IT-Standard-A',
  fr: 'fr-FR-Standard-F', bn: 'bn-IN-Standard-A', hi: 'hi-IN-Standard-A', ar: 'ar-XA-Standard-A', zh: 'cmn-CN-Standard-A', tl: 'fil-PH-Standard-A',
  ko: 'ko-KR-Standard-A', ja: 'ja-JP-Standard-B',
}

export const spokenLanguage = (language: string) => (VOICES[language as Lang] ? language : 'en')

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function callScript(text: string, language: string) {
  const voice = VOICES[spokenLanguage(language) as Lang]!
  const say = `<Say language="${voice.split('-Standard')[0]}" voice="Google.${voice}">${xml(text)}</Say>`
  return `<Response>${say}<Pause length="1"/>${say}</Response>`
}

const LINK_LASTS_MS = 10 * 60000
const seal = (payload: string) => createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')

/** Twilio's trial refuses words sent with the call, so it fetches them from a short-lived signed link. */
export function callLink(text: string, language: string) {
  const payload = Buffer.from(JSON.stringify({ text, language, until: Date.now() + LINK_LASTS_MS })).toString('base64url')
  return `${config.publicUrl}/api/phone/say?c=${payload}&s=${seal(payload)}`
}

/** The script behind a link, or null if the link was changed or has run out. */
export function scriptFromLink(payload: string, signature: string) {
  const [given, expected] = [Buffer.from(signature), Buffer.from(seal(payload))]
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const { text, language, until } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  return Date.now() > Number(until) ? null : callScript(String(text), String(language))
}

/** Twilio wants +447700900123. People type 07700 900123 or 0044 7700 900123. Local numbers are taken as UK. */
export function dialable(number: string) {
  const digits = number.replace(/\D/g, '')
  if (!digits) return ''
  if (number.trim().startsWith('+')) return `+${digits}`
  if (digits.startsWith('00')) return `+${digits.slice(2)}`
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`
  return `+${digits}`
}

/** Twilio's messages can quote the number, so only these words reach the log or the screen. */
const PLAIN_ERRORS: Record<number, string> = {
  20003: 'Twilio refused the account SID or auth token.',
  21210: "The From number isn't one of your Twilio numbers.",
  21212: "The From number doesn't look right. Use +44 and the full number.",
  21214: "That number can't be reached.",
  21215: "Your Twilio account isn't allowed to call that country. Turn it on under Voice, Geo Permissions.",
  21217: "That number doesn't look right.",
  21219: 'A trial Twilio account can only call numbers you have verified. Verify this one in Twilio.',
  21606: "The From number can't make calls.",
}

async function dial(number: string, text: string, language: string) {
  const to = dialable(number)
  if (!phoneReady() || !to) return { ok: false, detail: 'Phone calls are not set up.' }
  const { accountSid, authToken, fromNumber, baseUrl } = config.twilio
  let ok = false
  let detail: string | null = null
  try {
    const response = await fetch(`${baseUrl}/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: dialable(fromNumber), ...(config.publicUrl ? { Url: callLink(text, language) } : { Twiml: callScript(text, language) }) }),
      signal: AbortSignal.timeout(15000),
    })
    ok = response.ok
    if (!ok) {
      const code = Number((await response.json().catch(() => ({})) as { code?: number }).code)
      detail = PLAIN_ERRORS[code] ?? `Twilio said ${response.status}${code ? `, code ${code}` : ''}.`
    }
  } catch (error) {
    detail = `Twilio couldn't be reached: ${(error as Error).name}.`
  }
  await insert('INSERT INTO message_log (channel, action_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?)', 'call', null, ok ? 'sent' : 'failed', detail, nowIso())
  return { ok, detail }
}

/** Never throws, because a failed call must not stop the rest of the chasing. */
export const placeCall = async (number: string, text: string, language: string) => (await dial(number, text, language)).ok

export async function testCall() {
  if (!phoneReady()) return { ok: false, detail: 'Add the Twilio account SID, auth token and From number first.' }
  if (!ownerPhone()) return { ok: false, detail: 'Add the phone that should ring first.' }
  const { ok, detail } = await dial(ownerPhone(), 'This is Stockpot. Your phone calls are working.', 'en')
  return { ok, detail: ok ? 'Calling you now.' : detail }
}

export const lastCall = async () => await get(`SELECT status, detail, created_at AS at FROM message_log WHERE channel = 'call' ORDER BY id DESC LIMIT 1`) ?? null
