import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { background } from './background.ts'
import { config } from './config.ts'
import { all, get, nowIso, run, saveSetting, setting } from './db.ts'
import { addInvoice, allowedExtension, readInvoices } from './documents.ts'
import { writeFile } from './files.ts'

/**
 * Gmail, with the owner's own Google login. The refresh token sits in the settings table, because a
 * hosted site has no disk to keep it on, and it never reaches a browser. Mail is only read from suppliers, and only attachments are kept.
 */

const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly'
const TOKEN = 'google_refresh_token'
const oldTokenFile = () => path.join(config.dataDir, 'google-token.json')

/** A Mac linked before tokens moved has one in a file. It's read once, then removed. */
async function refreshToken() {
  const saved = await setting(TOKEN)
  if (saved || !fs.existsSync(oldTokenFile())) return saved
  const { refresh_token: fromFile } = JSON.parse(fs.readFileSync(oldTokenFile(), 'utf8'))
  await saveSetting(TOKEN, String(fromFile))
  fs.rmSync(oldTokenFile(), { force: true })
  return String(fromFile)
}

export const gmailConfigured = () => !!(config.google.clientId && config.google.clientSecret)
export const gmailConnected = async () => gmailConfigured() && !!await refreshToken()

export class GmailError extends Error {}

/** The way back from Google can land on a different instance, so these are kept in the database. */
const STATE_LIFE_MS = 10 * 60 * 1000
const stateKey = (state: string) => `gmail_state:${state}`

export async function gmailLoginUrl(redirectUri: string) {
  const state = crypto.randomBytes(16).toString('hex')
  await run(`DELETE FROM settings WHERE key LIKE 'gmail_state:%' AND value < ?`, nowIso())
  await saveSetting(stateKey(state), new Date(Date.now() + STATE_LIFE_MS).toISOString())
  const query = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', state,
  })
  return `${config.google.authUrl}?${query}`
}

async function tokenRequest(fields: Record<string, string>) {
  const response = await fetch(config.google.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...fields }),
    signal: AbortSignal.timeout(15000),
  })
  const payload = (await response.json().catch(() => null)) as Record<string, any> | null
  if (!response.ok || !payload) throw new GmailError(`Google refused the login: ${String(payload?.error_description ?? payload?.error ?? response.status).slice(0, 160)}`)
  return payload
}

export async function finishGmailLogin(code: string, state: string, redirectUri: string) {
  // Taking the row is what uses it up, so a link only ever works once.
  const taken = await run('DELETE FROM settings WHERE key = ? AND value >= ?', stateKey(state), nowIso())
  if (!taken.changes) throw new GmailError('That login link has expired. Start again.')
  const token = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri })
  if (!token.refresh_token) throw new GmailError('Google did not give Stockpot lasting access. Start again.')
  await saveSetting(TOKEN, String(token.refresh_token))
  access = null
  const profile = await gmail<{ emailAddress?: string }>('/users/me/profile')
  await saveSetting('google_email', profile.emailAddress ?? 'connected')
  background('gmail', checkInbox)
}

export async function disconnectGmail() {
  fs.rmSync(oldTokenFile(), { force: true })
  await saveSetting(TOKEN, null)
  await saveSetting('google_email', null)
  access = null
}

let access: { token: string; until: number; refresh: string } | null = null

async function accessToken() {
  // Read every time, because the owner may have disconnected on a different instance.
  const refresh = await refreshToken()
  if (!gmailConfigured() || !refresh) throw new GmailError('Connect Gmail first.')
  if (access && access.refresh === refresh && access.until > Date.now() + 30000) return access.token
  const token = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' })
  access = { token: String(token.access_token), until: Date.now() + Number(token.expires_in ?? 3000) * 1000, refresh }
  return access.token
}

async function gmail<T = any>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.google.apiUrl}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  const payload = (await response.json().catch(() => null)) as any
  if (!response.ok) throw new GmailError(`Gmail said: ${String(payload?.error?.message ?? response.status).slice(0, 200)}`)
  return payload as T
}

const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`)

export function buildMail(input: { to: string; subject: string; body: string }) {
  // A line break in a header would let text add extra recipients.
  const line = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
  const mail = [
    `To: ${line(input.to)}`, `Subject: ${encodeHeader(line(input.subject))}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(input.body).toString('base64'),
  ].join('\r\n')
  return Buffer.from(mail).toString('base64url')
}

export async function sendMail(input: { to: string; subject: string; body: string }) {
  await gmail('/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw: buildMail(input) }) })
}

function attachments(part: any, found: Array<{ name: string; id: string }> = []) {
  if (part?.filename && part.body?.attachmentId) found.push({ name: String(part.filename), id: String(part.body.attachmentId) })
  for (const child of part?.parts ?? []) attachments(child, found)
  return found
}

/** Pulls invoices from supplier emails. Each message is only looked at once, so a re-run can't double a bill. */
export async function checkInbox() {
  if (!await gmailConnected()) return { added: 0 }
  const senders = (await all(`SELECT email FROM suppliers WHERE email IS NOT NULL AND email NOT LIKE '%.example'`)).map((row) => String(row.email))
  if (!senders.length) return { added: 0 }
  const query = encodeURIComponent(`has:attachment newer_than:14d from:(${senders.join(' OR ')})`)
  const list = await gmail<{ messages?: Array<{ id: string }> }>(`/users/me/messages?maxResults=20&q=${query}`)
  const ids: number[] = []
  for (const { id } of list.messages ?? []) {
    // Taken before the work starts, so two passes at once can't both bring in the same bill.
    if (!(await run('INSERT INTO mail_seen (message_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING', id, nowIso())).changes) continue
    try {
    const message = await gmail(`/users/me/messages/${id}?format=full`)
    for (const attachment of attachments(message.payload).filter(({ name }) => allowedExtension(name))) {
      const { data } = await gmail<{ data: string }>(`/users/me/messages/${id}/attachments/${attachment.id}`)
      const file = `${crypto.randomUUID()}${path.extname(attachment.name).toLowerCase()}`
      await writeFile(file, Buffer.from(data, 'base64url'))
      const invoiceId = await addInvoice(file, attachment.name.slice(0, 200))
      await run(`UPDATE invoices SET source = 'gmail' WHERE id = ?`, invoiceId)
      ids.push(invoiceId)
    }
    } catch (error) {
      // Not looked at after all, so the next pass tries this message again.
      await run('DELETE FROM mail_seen WHERE message_id = ?', id)
      throw error
    }
  }
  await saveSetting('gmail_checked_at', nowIso())
  if (ids.length) background('gmail invoices', () => readInvoices(ids))
  return { added: ids.length }
}

export async function gmailStatus() {
  return { configured: gmailConfigured(), connected: await gmailConnected(), account: await setting('google_email'), checkedAt: await setting('gmail_checked_at'), mailed: Number((await get(`SELECT COUNT(*) AS total FROM invoices WHERE source = 'gmail'`))?.total ?? 0) }
}
