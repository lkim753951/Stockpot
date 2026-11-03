import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startInstance } from './standins.ts'
import { CallLink } from '../src/lib/callLink.ts'

/**
 * What changes when the app has no one process to rely on. A second server in its own process stands
 * in for another instance: the two share the database and nothing else.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-hosting-'))
const OWNER = '447700900001'
const MARIA = '447700900002'
const SECRET = 'app-secret'
const CRON = 'a-long-cron-secret'

const google = { refreshTokens: [] as string[] }
const fakeGoogle = http.createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    const send = (payload: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (request.url === '/token') return send({ access_token: 'access', expires_in: 3600, refresh_token: 'refresh-token-value' })
    if (request.url === '/gmail/users/me/profile') return send({ emailAddress: 'owner@restaurant.test' })
    send({ messages: [] })
  })
})
await new Promise<void>((resolve) => fakeGoogle.listen(0, '127.0.0.1', resolve))
const googleBase = `http://127.0.0.1:${(fakeGoogle.address() as { port: number }).port}`

Object.assign(process.env, {
  DATA_DIR: dataDir, SAMPLE_DATA: '1', MODEL_API_KEY: 'test-key', OWNER_PASSCODE: 'owner-code', STAFF_PASSCODE: 'staff-code', SESSION_SECRET: 'a-session-secret',
  CRON_SECRET: CRON, CALL_SAVE_MS: '60', CALL_GRACE_MS: '150',
  WHATSAPP_TOKEN: 'wa-token', WHATSAPP_PHONE_NUMBER_ID: '555', WHATSAPP_OWNER_NUMBER: OWNER, WHATSAPP_STAFF_NUMBERS: `Maria:${MARIA}`, WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM_NUMBER: '+15550001111',
  GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_AUTH_URL: `${googleBase}/auth`, GOOGLE_TOKEN_URL: `${googleBase}/token`, GOOGLE_API_URL: `${googleBase}/gmail`,
})

const { startMockMeta } = await import('../server/sample/mockMeta.ts')
const mock = await startMockMeta()
process.env.META_BASE_URL = mock.httpBase
process.env.META_REALTIME_URL = mock.wsUrl
process.env.WHATSAPP_BASE_URL = mock.httpBase
process.env.TWILIO_BASE_URL = mock.httpBase
const { buildApp } = await import('../server/app.ts')
const db = await import('../server/core/db.ts')
const { localTime } = await import('../server/core/clock.ts')
const { addAction, listActions, listProposed } = await import('../server/operations/actions.ts')
const { chaseLate } = await import('../server/operations/chase.ts')
const { sendDueChecklists } = await import('../server/operations/team.ts')
const { refreshActions } = await import('../server/operations/actions.ts')
const { resetSample, clearSampleData, RefusedWipe, refreshStaleSample } = await import('../server/core/seed.ts')

const server = await buildApp()
let base = ''
let wsBase = ''
let owner = ''
let staff = ''
let other: Awaited<ReturnType<typeof startInstance>>
let serial = 0

const api = async (url: string, options: { method?: string; body?: unknown; cookie?: string; at?: string; headers?: Record<string, string> } = {}) => {
  const response = await fetch(`${options.at ?? base}${url}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'), redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: options.cookie ?? owner, ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json: any = text
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json, headers: response.headers }
}

async function waitFor<T>(work: () => T | Promise<T>, label: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await work()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const cron = (token = CRON, at?: string) => api('/api/cron', { method: 'POST', at, headers: token ? { Authorization: `Bearer ${token}` } : {} })
const later = (minutes: number) => new Date(Date.parse(`${localTime().stamp}:00Z`) + minutes * 60000).toISOString().slice(0, 16)
const words = (call: any) => call.body?.text?.body ?? call.body?.interactive?.body?.text ?? ''

let lists = 0
/** A list due at a chosen time, with nothing else of the day in the way. */
async function dueList(minutes: number, chaseAfter: number | null, callWho: string | null = 'assignee') {
  lists += 1
  const saved = await api('/api/setup/checklists', { body: { name: `Timed list ${lists}`, schedule: { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6] }, dueTime: '12:00', assignee: 'Maria', chaseAfter, callWho, items: [{ label: `Timed check ${lists}`, type: 'tick', proof: false }] } })
  assert.equal(saved.status, 201)
  await api('/api/staff/runs', { cookie: staff })
  await db.run('UPDATE checklist_runs SET due_at = ? WHERE template_id = ?', later(minutes), saved.json.id)
  return { template: Number(saved.json.id), run: Number((await db.get('SELECT id FROM checklist_runs WHERE template_id = ?', saved.json.id))!.id), name: `Timed list ${lists}` }
}

before(async () => {
  await db.run('UPDATE checklist_items SET proof = 0')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  base = `http://127.0.0.1:${port}`
  wsBase = `ws://127.0.0.1:${port}`
  const login = async (passcode: string) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })).headers.get('set-cookie')!.split(';')[0]
  owner = await login('owner-code')
  staff = await login('staff-code')
  other = await startInstance()
})

after(async () => {
  other.child.removeAllListeners('exit')
  other.kill()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
  fakeGoogle.closeAllConnections()
  fakeGoogle.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('/healthz answers with no database work, and /api/cron needs the secret', async () => {
  assert.deepEqual((await api('/healthz', { cookie: '' })).json, { ok: true })
  assert.equal((await api('/api/cron', { method: 'POST', cookie: owner })).status, 401)
  assert.equal((await cron('wrong-secret')).status, 401)
  assert.equal((await cron(`${CRON}x`)).status, 401)
  assert.equal((await api('/api/cron', { cookie: owner })).status, 404)
  const pass = await cron()
  assert.equal(pass.status, 200)
  assert.equal(Object.values(pass.json.results).includes('failed'), false, JSON.stringify(pass.json.results))
  assert.ok(pass.json.ms < 60000)
})

test('cron refuses everyone when no secret is set', async () => {
  const { config } = await import('../server/core/config.ts')
  const saved = config.cronSecret
  config.cronSecret = ''
  try {
    assert.equal((await cron('')).status, 401)
    assert.equal((await cron('anything')).status, 401)
  } finally {
    config.cronSecret = saved
  }
})

test('two cron passes at once, on two instances, send one reminder and make one call', async () => {
  const list = await dueList(-40, 30)
  await db.run('UPDATE checklist_runs SET sent_at = ? WHERE id = ?', db.nowIso(), list.run)
  const count = mock.state.whatsapp.length
  const calls = mock.state.calls.length
  const passes = await Promise.all([cron(), cron(CRON, other.base), cron(), cron(CRON, other.base)])
  for (const pass of passes) assert.equal(pass.status, 200)
  const reminders = mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name))
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].body.to, MARIA)
  assert.equal(mock.state.calls.length, calls + 1)
  await cron()
  assert.equal(mock.state.calls.length, calls + 1, 'one chase only')
})

test('a list goes to the team once, however many passes overlap', async () => {
  const list = await dueList(20, null)
  await db.run('UPDATE checklist_runs SET sent_at = ? WHERE id = ?', db.nowIso(), (await db.get('SELECT MIN(id) AS id FROM checklist_runs'))!.id)
  await db.run(`UPDATE checklist_runs SET sent_at = ? WHERE id <> ?`, db.nowIso(), list.run)
  const count = mock.state.whatsapp.length
  await Promise.all([cron(), cron(CRON, other.base), sendDueChecklists()])
  assert.equal(mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name)).length, 1)
})

test('an urgent alert goes out once when two passes add the same thing together', async () => {
  const count = mock.state.whatsapp.length
  const action = { sourceType: 'overdue' as const, sourceId: 987654, urgency: 'now' as const, title: 'Only once please' }
  await Promise.all([addAction(action), addAction(action), addAction(action)])
  await waitFor(() => mock.state.whatsapp.length > count, 'the alert')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(mock.state.whatsapp.slice(count).filter((call) => words(call).includes('Only once please')).length, 1)
})

test('a chase can fire before the due time, and only once', async () => {
  const list = await dueList(20, -30)
  await db.run('UPDATE checklist_runs SET sent_at = ? WHERE id = ?', new Date(Date.now() - 600000).toISOString(), list.run)
  const count = mock.state.whatsapp.length
  const calls = mock.state.calls.length
  await chaseLate()
  await chaseLate()
  const chased = mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name))
  assert.equal(chased.length, 1)
  assert.match(words(chased[0]), /is due at/)
  assert.doesNotMatch(words(chased[0]), /was due/)
  assert.equal(mock.state.calls.length, calls + 1)
  assert.match(new URLSearchParams(mock.state.calls.at(-1).body).get('Twiml')!, /is due at/)

  // When it does go overdue, nobody is chased a second time. The owner hears through the overdue item.
  await db.run('UPDATE checklist_runs SET due_at = ? WHERE id = ?', later(-30), list.run)
  await chaseLate()
  assert.equal(mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name)).length, 1)
  assert.equal(mock.state.calls.length, calls + 1)
  await api('/api/home')
  const overdue = (await listActions()).find((action) => action.title === `${list.name} are overdue`)
  assert.equal(overdue?.urgency, 'now')
})

test('a chase before due waits its turn, and never fires too early', async () => {
  const list = await dueList(50, -30)
  await db.run('UPDATE checklist_runs SET sent_at = ? WHERE id = ?', new Date(Date.now() - 600000).toISOString(), list.run)
  const count = mock.state.whatsapp.length
  await chaseLate()
  assert.equal(mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name)).length, 0)
  assert.equal((await db.get('SELECT chased_at FROM checklist_runs WHERE id = ?', list.run))!.chased_at, null)
})

test('a list due within the hour goes out before any chase, even when both are due', async () => {
  const list = await dueList(55, -60)
  const count = mock.state.whatsapp.length
  await chaseLate()
  assert.equal((await db.get('SELECT chased_at FROM checklist_runs WHERE id = ?', list.run))!.chased_at, null, 'no chase for a list nobody has been sent')

  await sendDueChecklists()
  await chaseLate()
  const seen = mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name))
  assert.equal(seen.length, 1, 'the list has only just gone, so the chase waits')
  assert.doesNotMatch(words(seen[0]), /not done yet/)

  await db.run('UPDATE checklist_runs SET sent_at = ? WHERE id = ?', new Date(Date.now() - 300000).toISOString(), list.run)
  await chaseLate()
  const after = mock.state.whatsapp.slice(count).filter((call) => words(call).includes(list.name))
  assert.equal(after.length, 2)
  assert.match(words(after[1]), /not done yet/)
})

test('a list saved with an old wait still chases the way it did, and the choices are checked', async () => {
  const list = await dueList(-20, 15, null)
  const count = mock.state.whatsapp.length
  await chaseLate()
  assert.equal(mock.state.whatsapp.slice(count).filter((call) => /was due at/.test(words(call)) && words(call).includes(list.name)).length, 1)
  assert.ok((await db.get('SELECT chased_at FROM checklist_runs WHERE id = ?', list.run))!.chased_at)
  const made = (schedule: unknown, chaseAfter: unknown) => api('/api/setup/checklists', { body: { name: `Check ${crypto.randomUUID()}`, schedule, dueTime: '12:00', chaseAfter, items: [{ label: 'A', type: 'tick', proof: false }] } })
  const daily = { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6] }
  assert.equal((await made(daily, -61)).status, 400)
  assert.equal((await made(daily, 721)).status, 400)
  for (const value of [-60, -30, 0, 30, 60]) {
    const saved = await made(daily, value)
    assert.equal(saved.status, 201)
    const row = (await api('/api/setup/checklists')).json.find((candidate: any) => candidate.id === saved.json.id)
    assert.equal(row.chaseAfter, value)
  }
})

test('the analyst\'s state is the same whichever instance is asked', async () => {
  const range = { from: '2026-02-01', to: '2026-02-28' }
  // Slowed enough to catch it mid-run on the other instance.
  const started = await api('/api/summary/run', { body: { ...range, background: true } })
  assert.equal(started.status, 202)
  assert.equal(started.json.running, true)
  const again = await api('/api/summary/run', { at: other.base, body: { ...range, background: true } })
  assert.equal(again.status, 200, 'the other instance can see a run is going')
  const finished = await waitFor(async () => {
    const view = (await api(`/api/summary?from=${range.from}&to=${range.to}`, { at: other.base })).json
    return !view.running && view
  }, 'the run to end, seen from the other instance')
  assert.ok(finished.report, `no report: ${JSON.stringify(finished).slice(0, 400)}`)
  assert.equal(finished.report.weekStart, range.from)
  assert.ok(finished.progress.length, 'progress crossed between instances')
})

test('a run that died holding the analyst frees it by itself', async () => {
  await db.saveSetting('claim:analyst', '2020-01-01T00:00:00.000Z')
  assert.equal((await api('/api/summary')).json.running, false)
  assert.equal((await api('/api/summary/run', { body: { from: '2026-03-01', to: '2026-03-31' } })).status, 200)
})

test('Gmail sign-in can start on one instance and come back on another, and each link works once', async () => {
  const login = await fetch(`${base}/api/google/login`, { headers: { Cookie: owner }, redirect: 'manual' })
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!
  const back = (at: string, which: string) => fetch(`${at}/api/google/callback?code=abc&state=${which}`, { headers: { Cookie: owner }, redirect: 'manual' })
  assert.match((await back(other.base, 'forged')).headers.get('location')!, /gmail=failed/)
  assert.doesNotMatch((await back(other.base, state)).headers.get('location')!, /failed/)
  assert.equal((await api('/api/connections', { at: base })).json.gmail.connected, true)
  assert.equal(await db.setting('google_refresh_token'), 'refresh-token-value')
  assert.match((await back(base, state)).headers.get('location')!, /gmail=failed/, 'a link only works once')
  assert.doesNotMatch(JSON.stringify((await api('/api/connections')).json), /refresh-token-value/)

  await db.run(`INSERT INTO settings (key, value) VALUES ('gmail_state:old', '2020-01-01T00:00:00.000Z')`)
  assert.match((await back(base, 'old')).headers.get('location')!, /gmail=failed/, 'an old link has run out')
})

test('an old token file on a Mac is read once, and then the file has gone', async () => {
  await db.saveSetting('google_refresh_token', null)
  const file = path.join(dataDir, 'google-token.json')
  fs.writeFileSync(file, JSON.stringify({ refresh_token: 'from-the-old-file' }))
  assert.equal((await api('/api/connections')).json.gmail.connected, true)
  assert.equal(await db.setting('google_refresh_token'), 'from-the-old-file')
  assert.equal(fs.existsSync(file), false)
})

test('Start again, the clear button and the stale reset refuse while a key is set', async () => {
  const suppliers = Number((await db.get('SELECT COUNT(*) AS total FROM suppliers'))!.total)
  assert.ok(suppliers > 0)
  assert.equal((await api('/api/sample/reset', { method: 'POST' })).status, 403)
  assert.equal((await api('/api/setup/clear-sample', { method: 'POST' })).status, 403)
  await assert.rejects(resetSample(), RefusedWipe)
  await assert.rejects(clearSampleData(), RefusedWipe)
  assert.equal(await db.setting('real_site'), '1')
  await db.run(`UPDATE sales SET date = '2001-01-01'`).catch(() => undefined)
  await refreshStaleSample()
  assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM suppliers'))!.total), suppliers)
})

test('a missing key can never turn real data into a sample to be wiped', async () => {
  const { config } = await import('../server/core/config.ts')
  const mode = config.mode
  const schema = config.dbSchema
  config.mode = 'sample'
  config.dbSchema = 'sample'
  try {
    const suppliers = Number((await db.get('SELECT COUNT(*) AS total FROM suppliers'))!.total)
    await assert.rejects(resetSample(), /real restaurant/)
    await refreshStaleSample()
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM suppliers'))!.total), suppliers)
  } finally {
    config.mode = mode
    config.dbSchema = schema
  }
})

test('the WhatsApp webhook works on its public address, signature and all', async () => {
  const good = await fetch(`${base}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777`)
  assert.equal(await good.text(), '777')
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '555' }, messages: [{ id: `wamid.public.${serial += 1}`, from: MARIA, type: 'text', text: { body: 'Please order more blue roll' } }] } }] }] })
  const signature = (secret: string) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`
  assert.equal((await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'X-Hub-Signature-256': signature('wrong') }, body: raw })).status, 401)
  assert.equal((await fetch(`${base}/whatsapp/webhook`, { method: 'POST', body: raw })).status, 401)
  assert.equal((await fetch(`${base}/whatsapp/webhook`, { method: 'POST', headers: { 'X-Hub-Signature-256': signature(SECRET) }, body: raw })).status, 200)
  await waitFor(async () => (await listProposed()).some((action) => action.detail === 'Please order more blue roll'), 'the report')
})

test('two messages landing on two instances take turns, and a double yes saves once', async () => {
  const fridge = (await api('/api/team')).json.runs.find((row: any) => row.name === 'Fridge and water checks')
  await api(`/api/team/send/${fridge.id}`, { method: 'POST' })
  const deliver = (body: string, at: string) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '555' }, messages: [{ id: `wamid.turns.${serial += 1}`, from: MARIA, type: 'text', text: { body } }] } }] }] })
    return fetch(`${at}/api/whatsapp/webhook`, { method: 'POST', headers: { 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}` }, body: raw })
  }
  let count = mock.state.whatsapp.length
  await deliver('Fridge one 4', base)
  await waitFor(() => mock.state.whatsapp.slice(count).some((call) => /Save this\?/.test(words(call))), 'the question')
  count = mock.state.whatsapp.length
  await Promise.all([deliver('yes', base), deliver('yes', other.base)])
  await waitFor(() => mock.state.whatsapp.length >= count + 2, 'both answers')
  const entries = await db.all(`SELECT e.id FROM checklist_entries e JOIN checklist_items i ON i.id = e.item_id WHERE e.run_id = ? AND i.label = 'Fridge one'`, fridge.id)
  assert.equal(entries.length, 1)
  const answers = mock.state.whatsapp.slice(count).map(words)
  assert.equal(answers.filter((text) => /^Saved\./.test(text)).length, 1)
})

test('new work from a call, a report or a delivery waits for the owner, and stays out of the lists and the badge', async () => {
  const call = await db.insert(`INSERT INTO calls (supplier_id, status, consent_at) VALUES (1, 'done', ?)`, db.nowIso())
  await db.insert('INSERT INTO tasks (call_id, title, due_date, urgency) VALUES (?, ?, ?, ?)', call, 'Ring back about the fish', '2030-01-01', 'urgent')
  const filed = await api('/api/staff/reports', { body: { text: 'We are low on napkins' }, cookie: staff })
  assert.equal(filed.status, 201)
  const home = (await api('/api/home')).json
  const task = home.toConfirm.find((action: any) => action.title === 'Ring back about the fish')
  const report = home.toConfirm.find((action: any) => action.sourceType === 'report' && action.detail === 'We are low on napkins')
  assert.ok(task && report)
  assert.ok(task.source && report.source)
  assert.equal(task.urgency, 'now')
  assert.ok(!home.actions.some((action: any) => action.id === task.id || action.id === report.id))
  const alerts = (await api('/api/alerts')).json
  assert.ok(!alerts.urgent.some((action: any) => action.id === task.id))
  assert.equal((await api('/api/alerts', { cookie: staff })).status, 403)
  assert.equal((await api(`/api/actions/${task.id}/confirm`, { method: 'POST', cookie: staff })).status, 403)
  assert.equal((await api(`/api/actions/${task.id}/dismiss`, { method: 'POST', cookie: staff })).status, 403)
})

test('a proposed item still reaches the owner on WhatsApp', async () => {
  const count = mock.state.whatsapp.length
  await db.insert(`INSERT INTO tasks (call_id, title, urgency) VALUES (NULL, 'Urgent thing from a call', 'urgent')`)
  await api('/api/home')
  const alert = await waitFor(() => mock.state.whatsapp.slice(count).find((call) => words(call).includes('Urgent thing from a call')), 'the alert')
  assert.equal(alert.body.to, OWNER)
  assert.match(words(alert), /Open Stockpot to confirm this\./)
})

test('safety goes straight through, with nothing to confirm', async () => {
  const crisis = await api('/api/staff/reports/quick', { body: { kind: 'gas' }, cookie: staff })
  const injured = await api('/api/staff/reports', { body: { text: 'Tom has a bad burn on his arm' }, cookie: staff })
  const unsafe = await api('/api/staff/reports', { body: { text: 'The chicken was undercooked' }, cookie: staff })
  const lodowka = await api('/api/staff/reports/sample', { method: 'POST', cookie: staff })
  const home = (await api('/api/home')).json
  for (const filed of [crisis, injured, unsafe, lodowka]) {
    assert.ok(home.actions.some((action: any) => action.href === `#/report/${filed.json.id}`), filed.json.title)
    assert.ok(!home.toConfirm.some((action: any) => action.href === `#/report/${filed.json.id}`))
  }
  const fridge = (await api('/api/staff/runs', { cookie: staff })).json.find((row: any) => row.name === 'Fridge and water checks')
  const view = (await api(`/api/staff/runs/${fridge.id}`, { cookie: staff })).json
  await api(`/api/staff/runs/${fridge.id}/entries`, { cookie: staff, body: { itemId: view.items.find((item: any) => item.label === 'Hot water').id, value: 20, source: 'typed' } })
  assert.ok((await api('/api/home')).json.actions.some((action: any) => /Hot water is at 20/.test(action.title)))
})

test('a report nobody could read is not held back on a guess', async () => {
  mock.state.failSpark = true
  try {
    const filed = await api('/api/staff/reports', { body: { text: 'Pożar w kuchni' }, cookie: staff })
    assert.ok((await api('/api/home')).json.actions.some((action: any) => action.href === `#/report/${filed.json.id}`))
  } finally {
    mock.state.failSpark = false
  }
})

test('confirm moves an item into the list, and it stays there', async () => {
  const item = (await api('/api/home')).json.toConfirm.find((action: any) => action.title === 'Ring back about the fish')
  assert.equal((await api(`/api/actions/${item.id}/confirm`, { method: 'POST' })).status, 200)
  await refreshActions()
  const home = (await api('/api/home')).json
  assert.ok(home.actions.some((action: any) => action.id === item.id))
  assert.ok(!home.toConfirm.some((action: any) => action.id === item.id))
  assert.equal((await api(`/api/actions/${item.id}/confirm`, { method: 'POST' })).status, 404)
})

test('dismiss stays dismissed through every refresh', async () => {
  const call = await db.insert(`INSERT INTO calls (supplier_id, status, consent_at) VALUES (1, 'done', ?)`, db.nowIso())
  await db.insert('INSERT INTO tasks (call_id, title) VALUES (?, ?)', call, 'Not worth doing')
  const item = (await api('/api/home')).json.toConfirm.find((action: any) => action.title === 'Not worth doing')
  assert.equal((await api(`/api/actions/${item.id}/dismiss`, { method: 'POST' })).status, 200)
  await refreshActions()
  await refreshActions()
  await cron()
  const home = (await api('/api/home')).json
  assert.ok(!home.actions.some((action: any) => action.id === item.id))
  assert.ok(!home.toConfirm.some((action: any) => action.id === item.id))
  assert.ok(!home.doneToday.some((action: any) => action.id === item.id))
  assert.equal((await api(`/api/actions/${item.id}/dismiss`, { method: 'POST' })).status, 404)
})

test('a delivery problem waits to be confirmed, with its Call button working, and a dismissed one stays gone', async () => {
  const supplier = (await api('/api/setup/suppliers', { body: { name: `Ring Me ${serial += 1}`, phone: '020 7946 0100' } })).json
  const order = (await api('/api/orders', { body: { supplierId: supplier.id, deliveryDate: '2099-01-01', lines: [{ name: 'Mackerel', quantity: 5, unit: 'kg' }] } })).json
  const view = (await api(`/api/staff/deliveries/${order.id}`, { cookie: staff })).json
  const count = (received: number) => api(`/api/staff/deliveries/${order.id}/counts`, { cookie: staff, body: { lines: [{ itemId: view.lines[0].itemId, received }] } })
  await count(3)
  const problem = (await api('/api/home')).json.toConfirm.find((action: any) => action.href === `#/checks/${order.id}`)
  assert.equal(problem.sourceType, 'problem')
  assert.equal(problem.suggested.href, 'tel:02079460100')
  assert.ok(problem.suggested.label.includes(supplier.name ?? ''))
  await api(`/api/actions/${problem.id}/dismiss`, { method: 'POST' })
  await count(2)
  await refreshActions()
  assert.ok(!(await api('/api/home')).json.toConfirm.some((action: any) => action.id === problem.id))
})

test('an action someone added, or the app made itself, is not held back', async () => {
  const mine = await api('/api/actions', { body: { title: 'Ring the landlord', urgency: 'today' } })
  const home = (await api('/api/home')).json
  assert.ok(home.actions.some((action: any) => action.id === mine.json.id))
  assert.ok(home.actions.some((action: any) => action.sourceType === 'overdue'))
})

test('sample mode\'s demo clock lives in the database', async () => {
  const { config } = await import('../server/core/config.ts')
  const clock = await import('../server/core/clock.ts')
  const mode = config.mode
  config.mode = 'sample'
  try {
    await clock.jumpTo('22:30')
    assert.equal(clock.localTime().time, '22:30')
    const saved = JSON.parse((await db.setting('demo_clock'))!)
    await db.saveSetting('demo_clock', JSON.stringify({ ...saved, offsetMs: saved.offsetMs - 3600000 }))
    await clock.syncDemoClock()
    assert.equal(clock.localTime().time, '21:30')
  } finally {
    await db.saveSetting('demo_clock', null)
    await clock.syncDemoClock()
    config.mode = mode
  }
})

const pcm = fs.readFileSync('public/samples/sample-call.wav').subarray(44)
const CHUNK = 3840
const blocks = (from: number, to: number) => {
  const out: ArrayBuffer[] = []
  for (let at = from; at < to; at += CHUNK) out.push(new Uint8Array(pcm.subarray(at, Math.min(at + CHUNK, to))).slice().buffer)
  return out
}
const opener = (pick: () => string) => (url: string) => new WebSocket(`${pick()}${new URL(url).pathname}`, { headers: { Cookie: owner } }) as any

/** Opens a real microphone call through the same class the browser uses. */
async function startCall(pick: () => string, rotateMs = 0) {
  const made = await api('/api/calls', { body: { supplierId: 1, consent: true, source: 'microphone' } })
  assert.equal(made.status, 201)
  const events: any[] = []
  const link = new CallLink(`ws://x/ws/call/${made.json.id}`, (event) => events.push(event), { rotateMs, open: opener(pick) })
  await waitFor(() => events.find((event) => event.type === 'listening'), 'the first connection')
  return { id: Number(made.json.id), events, link }
}

const sendSlowly = async (link: CallLink, from: number, to: number) => {
  for (const block of blocks(from, to)) {
    link.send(block)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const savedRecording = (id: number) => fs.readFileSync(path.join(dataDir, 'calls', `${id}.wav`)).subarray(44)

test('a call survives its instance dying with no warning, and carries on elsewhere with nothing lost', async () => {
  const dying = await startInstance()
  dying.child.removeAllListeners('exit')
  let target = dying.ws
  const { id, events, link } = await startCall(() => target)
  const part = Math.floor(pcm.length * 0.6) & ~1
  await sendSlowly(link, 0, part)
  await waitFor(() => events.some((event) => event.type === 'card'), 'a price on the first connection')
  const saved = await waitFor(async () => {
    const row = await db.get('SELECT COUNT(*) AS total FROM call_segments WHERE call_id = ?', id)
    return Number(row?.total) > 0
  }, 'audio to be saved during the call')
  assert.ok(saved)

  // Exactly what Vercel does at the limit: no close frame, no close event, no chance to tidy up.
  const before = events.length
  dying.kill()
  target = wsBase
  await waitFor(() => events.some((event) => event.type === 'reconnecting'), 'the browser to notice')
  await sendSlowly(link, part, pcm.length)
  await waitFor(() => events.some((event) => event.type === 'reconnected'), 'the browser to come back')
  assert.ok(events.slice(before).filter((event) => event.type === 'listening').length >= 1)
  link.end()
  const done = await waitFor(() => events.find((event) => event.type === 'done'), 'the write-up', 15000)
  link.close()

  assert.ok(done.orderId, 'the call became an order')
  assert.ok(mock.state.realtimeStarts.at(-1)! > 0, 'the transcriber carried on rather than starting over')
  assert.deepEqual(savedRecording(id), pcm, 'every byte of the call is in the recording, in order')
  assert.equal(await db.get('SELECT 1 AS left_over FROM call_segments WHERE call_id = ?', id), undefined)

  const turns = events.filter((event) => event.type === 'turn').map((event) => event.turn)
  assert.deepEqual(turns, [...new Set(turns)].sort((a, b) => a - b), 'no turn was numbered twice')
  const texts = events.filter((event) => event.type === 'turn').map((event) => event.text)
  assert.equal(new Set(texts).size, texts.length, 'no turn was heard twice')
  const cards = events.filter((event) => event.type === 'card').map((event) => `${event.card.itemId}:${event.card.kind}:${event.card.pricePence}`)
  assert.equal(new Set(cards).size, cards.length, `no price showed twice: ${cards}`)
})

test('a browser moves to a new connection before the limit, on any instance, with no gap', async () => {
  const hosts = [wsBase, other.ws]
  let opened = 0
  const { id, events, link } = await startCall(() => hosts[opened++ % 2], 150)
  await sendSlowly(link, 0, pcm.length)
  link.end()
  await waitFor(() => events.find((event) => event.type === 'done'), 'the write-up', 15000)
  link.close()
  assert.ok(opened >= 2, `it moved ${opened} times`)
  assert.deepEqual(savedRecording(id), pcm)
  const shown = events.filter((event) => event.type === 'card').map((event) => `${event.card.itemId}:${event.card.kind}:${event.card.pricePence}`)
  assert.equal(new Set(shown).size, shown.length)
  const row = (await db.get('SELECT duration_ms, connections FROM calls WHERE id = ?', id))!
  assert.equal(row.duration_ms, Math.round((pcm.length / 48000) * 1000))
  assert.ok(Number(row.connections) >= 2)
})

test('a call nobody comes back to is still written up', async () => {
  const socketGone = await startCall(() => wsBase)
  await sendSlowly(socketGone.link, 0, 96000)
  await new Promise((resolve) => setTimeout(resolve, 120))
  socketGone.link.close()
  const row = await waitFor(async () => {
    const call = await db.get('SELECT status FROM calls WHERE id = ?', socketGone.id)
    return call?.status !== 'live' && call?.status !== 'processing' ? call : null
  }, 'the call to be finished', 12000)
  assert.equal(row?.status, 'done')
})

test('the regular pass finishes a call whose instance died, and only once', async () => {
  const dying = await startInstance()
  dying.child.removeAllListeners('exit')
  const { id, link } = await startCall(() => dying.ws)
  await sendSlowly(link, 0, 96000)
  await waitFor(async () => Number((await db.get('SELECT COUNT(*) AS total FROM call_segments WHERE call_id = ?', id))?.total) > 0, 'a save')
  dying.kill()
  link.close()
  await db.run('UPDATE calls SET last_seen_at = ? WHERE id = ?', new Date(Date.now() - 600000).toISOString(), id)
  await Promise.all([cron(), cron(CRON, other.base)])
  const call = await db.get('SELECT status FROM calls WHERE id = ?', id)
  assert.equal(call?.status, 'done')
  assert.equal((await db.all('SELECT id FROM orders WHERE call_id = ?', id)).length, 1, 'two passes made one order')
})

test('a call that stuck while being written up can be retried', async () => {
  const call = await db.insert(`INSERT INTO calls (supplier_id, status, consent_at, ended_at) VALUES (1, 'processing', ?, ?)`, db.nowIso(), '2020-01-01T00:00:00.000Z')
  await cron()
  assert.equal((await db.get('SELECT status FROM calls WHERE id = ?', call))!.status, 'failed')
})

test('the socket keeps its sign-in and same-origin checks, and a finished call can\'t be rejoined', async () => {
  const made = await api('/api/calls', { body: { supplierId: 1, consent: true, source: 'sample' } })
  const refused = (headers: Record<string, string>, url = `${wsBase}/ws/call/${made.json.id}`) => new Promise<number>((resolve) => {
    const socket = new WebSocket(url, { headers })
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    socket.on('open', () => { socket.close(); resolve(101) })
    socket.on('error', () => undefined)
  })
  assert.equal(await refused({}), 403)
  assert.equal(await refused({ Cookie: staff }), 403)
  assert.equal(await refused({ Cookie: owner }, `${wsBase}/ws/call/999999`), 403)
  const done = await db.insert(`INSERT INTO calls (supplier_id, status, consent_at) VALUES (1, 'done', ?)`, db.nowIso())
  assert.equal(await refused({ Cookie: owner }, `${wsBase}/ws/call/${done}`), 403)
})

/** Every route in the code, read from the code, so a new one can't dodge this audit. */
function allRoutes() {
  const routes: Array<{ method: string; path: string }> = []
  for (const file of ['server/app.ts', 'server/setup/setupRoutes.ts', 'server/core/uploads.ts']) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bapp\.(get|post|put|delete)\('(\/[^']*)'/g)) routes.push({ method: match[1].toUpperCase(), path: match[2] })
  }
  return routes
}

const OPEN_TO_ALL = new Set(['/healthz', '/api/session', '/api/login', '/api/logout', '/api/copilotkit/info', '/api/cron', '/api/crisis', '/api/crisis/photo/:name'])
const FOR_STAFF = /^\/api\/(staff\/|files\/|uploads\/|crisis\/photo$)/

test('every route needs a sign-in, unless it is on the short list of open ones', async () => {
  const routes = allRoutes()
  assert.ok(routes.length > 90, `found ${routes.length}`)
  const exposed: string[] = []
  for (const { method, path: route } of routes) {
    if (OPEN_TO_ALL.has(route) || (route === '/api/crisis' && method !== 'GET')) continue
    const url = route.replace(/:[a-zA-Z]+/g, '1')
    const { status } = await api(url, { method, cookie: '' })
    if (status !== 401) exposed.push(`${method} ${route}: ${status}`)
  }
  assert.deepEqual(exposed, [])
})

test('staff reach only their own routes, and nothing with prices, invoices or calls', async () => {
  const leaked: string[] = []
  for (const { method, path: route } of allRoutes()) {
    if (OPEN_TO_ALL.has(route) || FOR_STAFF.test(route) || route === '/api/crisis/photo') continue
    const url = route.replace(/:[a-zA-Z]+/g, '1')
    const { status } = await api(url, { method, cookie: staff })
    if (status !== 403) leaked.push(`${method} ${route}: ${status}`)
  }
  assert.deepEqual(leaked, [])
})

test('a rejected promise in a route reaches the error handler, and the server stays up', async () => {
  await db.run(`ALTER TABLE credits RENAME TO credits_away`)
  const logged = console.error
  console.error = () => undefined
  try {
    const failed = await api('/api/checks')
    assert.equal(failed.status, 502)
    assert.deepEqual(failed.json, { error: "That didn't work. Try again." })
  } finally {
    console.error = logged
    await db.run(`ALTER TABLE credits_away RENAME TO credits`)
  }
  assert.equal((await api('/api/checks')).status, 200)
})
