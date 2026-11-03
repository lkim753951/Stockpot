import crypto from 'node:crypto'
import { config } from '../core/config.ts'
import { all, get, nowIso, run } from '../core/db.ts'
import { inLanguage, t } from '../core/lang.ts'
import { background } from '../core/background.ts'
import { changeStaff, sendToPerson, whatsappReady } from '../integrations/whatsapp.ts'

/**
 * Adding someone by link. The owner never handles a number: the worker taps the link, WhatsApp
 * opens with a code ready, and sending it adds them. It also starts WhatsApp's 24-hour window.
 */

let businessNumber: string | null = null

async function businessDigits() {
  if (config.whatsapp.businessNumber) return config.whatsapp.businessNumber
  if (businessNumber) return businessNumber
  const response = await fetch(`${config.whatsapp.baseUrl}/${config.whatsapp.phoneNumberId}?fields=display_phone_number`, {
    headers: { Authorization: `Bearer ${config.whatsapp.token}` }, signal: AbortSignal.timeout(15000),
  }).catch(() => null)
  const payload = (await response?.json().catch(() => null)) as { display_phone_number?: string } | null
  businessNumber = payload?.display_phone_number?.replace(/[^\d]/g, '') || null
  return businessNumber
}

const linkFor = (digits: string | null, code: string) => (digits ? `https://wa.me/${digits}?text=${encodeURIComponent(`JOIN ${code}`)}` : null)

export async function createInvite(name: string, language: string | null) {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase()
  await run('INSERT INTO invites (code, name, language, created_at) VALUES (?, ?, ?, ?)', code, name, language, nowIso())
  return { code, name, link: whatsappReady() ? linkFor(await businessDigits(), code) : null }
}

export const waitingInvites = () => all('SELECT code, name, language FROM invites WHERE used_at IS NULL ORDER BY created_at DESC')

/** A first message from a new number. Returns true if it carried a real invite. */
export async function joinByInvite(raw: Record<string, any>) {
  const code = String(raw.text?.body ?? '').match(/\bJOIN\s+([0-9A-F]{6})\b/i)?.[1]?.toUpperCase()
  const number = String(raw.from ?? '')
  if (!code || !number) return false
  const invite = await get('SELECT * FROM invites WHERE code = ? AND used_at IS NULL', code)
  if (!invite) return false
  // Taking the code is what uses it, so one link can't add two people.
  if (!(await run('UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL', nowIso(), code)).changes) return false
  const name = String(invite.name)
  await changeStaff((people) => [...people, { name, number, language: (invite.language as string | null) ?? null }])
  background('invite', () => inLanguage(invite.language, () => sendToPerson({ to: { name, number }, text: t("Hi {name}, you're on the team. Your checklists will come here.", { name }) })))
  return true
}
