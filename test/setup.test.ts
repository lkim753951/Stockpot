import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

/** A real owner's own data, photo and video proof, date ranges and Gmail, through the real routes. */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-setup-'))
const envFile = path.join(dataDir, 'env')
fs.writeFileSync(envFile, '')
process.env.ENV_FILE = envFile
process.env.DATA_DIR = dataDir
process.env.MODEL_API_KEY = 'test-key'
process.env.OWNER_PASSCODE = 'owner-code'
process.env.STAFF_PASSCODE = 'staff-code'
process.env.GOOGLE_CLIENT_ID = 'client'
process.env.GOOGLE_CLIENT_SECRET = 'secret'

const google = { sent: [] as any[], messages: new Map<string, any>(), tokenRequests: [] as string[] }
const fake = http.createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    const send = (payload: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)) }
    const url = request.url ?? ''
    if (url === '/token') { google.tokenRequests.push(body); return send({ access_token: 'access', expires_in: 3600, refresh_token: 'refresh' }) }
    if (url === '/gmail/users/me/profile') return send({ emailAddress: 'owner@restaurant.test' })
    if (url === '/gmail/users/me/messages/send') { google.sent.push(JSON.parse(body)); return send({ id: 'sent' }) }
    if (url.startsWith('/gmail/users/me/messages?')) return send({ messages: [...google.messages.keys()].map((id) => ({ id })) })
    const attachment = url.match(/\/messages\/([^/]+)\/attachments\/(.+)$/)
    if (attachment) return send({ data: fs.readFileSync('public/samples/sample-invoice-previous.png').toString('base64url') })
    const message = url.match(/\/messages\/([^/?]+)\?format=full/)
    if (message) return send(google.messages.get(message[1]))
    response.writeHead(404).end('{}')
  })
})
await new Promise<void>((resolve) => fake.listen(0, resolve))
const googleBase = `http://localhost:${(fake.address() as any).port}`
process.env.GOOGLE_AUTH_URL = `${googleBase}/auth`
process.env.GOOGLE_TOKEN_URL = `${googleBase}/token`
process.env.GOOGLE_API_URL = `${googleBase}/gmail`

const { startMockMeta } = await import('../server/sample/mockMeta.ts')
const mock = await startMockMeta()
process.env.META_BASE_URL = mock.httpBase
process.env.META_REALTIME_URL = mock.wsUrl
const { buildApp } = await import('../server/app.ts')
const { readSamBoxes, readSamFrames } = await import('../server/ai/meta.ts')
const { mp4FrameCount, summariseTrack } = await import('../server/money/proof.ts')
const { priceCheck } = await import('../server/money/priceCheck.ts')
const { insert, run } = await import('../server/core/db.ts')
const { countObjects, phraseFor } = await import('../server/ai/countVideo.ts')
const { translateCount, translateSaved } = await import('../shared/lang.ts')

let base = ''
let owner = ''
let staff = ''
const server = await buildApp()

const cookie = async (passcode: string) => {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })
  return response.headers.get('set-cookie')!.split(';')[0]
}
const call = async (who: string, url: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${base}${url}`, { method, headers: { Cookie: who, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, data: await response.json().catch(() => null) as any }
}
const image = () => new Blob([fs.readFileSync('public/samples/sample-thermometer.png')], { type: 'image/png' })
const upload = async (who: string, url: string, fields: Record<string, string>, field = 'frames', name = 'frame-0.png') => {
  const form = new FormData()
  form.append(field, image(), name)
  Object.entries(fields).forEach(([key, value]) => form.append(key, value))
  const response = await fetch(`${base}${url}`, { method: 'POST', headers: { Cookie: who }, body: form })
  return { status: response.status, data: await response.json().catch(() => null) as any }
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  base = `http://localhost:${(server.address() as any).port}`
  owner = await cookie('owner-code')
  staff = await cookie('staff-code')
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
  fake.closeAllConnections()
  fake.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('a real install starts with no sample restaurant and tells the owner what to add', async () => {
  const { data } = await call(owner, '/api/home')
  assert.equal((await call(owner, '/api/setup/suppliers')).data.length, 0)
  assert.equal(data.setup.sampleData, false)
  assert.deepEqual(data.setup.steps.map((step: any) => step.key), ['suppliers', 'menu', 'checklists', 'sales', 'team', 'gmail'])
  assert.equal(data.setup.steps[0].done, false)
})

test('the owner adds, changes and removes a supplier, and bad details are refused', async () => {
  assert.equal((await call(owner, '/api/setup/suppliers', 'POST', { name: '' })).status, 400)
  assert.equal((await call(owner, '/api/setup/suppliers', 'POST', { name: 'Brook Farm', email: 'not an email' })).status, 400)
  const { data } = await call(owner, '/api/setup/suppliers', 'POST', { name: 'Brook Farm', email: 'sales@brookfarm.test', phone: '020 7946 0000' })
  assert.equal((await call(owner, '/api/setup/suppliers', 'POST', { name: 'Brook Farm' })).status, 400)
  await call(owner, `/api/setup/suppliers/${data.id}`, 'PUT', { name: 'Brook Farm Ltd', email: 'sales@brookfarm.test' })
  const spare = await call(owner, '/api/setup/suppliers', 'POST', { name: 'Spare' })
  await call(owner, `/api/setup/suppliers/${spare.data.id}`, 'DELETE')
  assert.deepEqual((await call(owner, '/api/setup/suppliers')).data.map((row: any) => row.name), ['Brook Farm Ltd'])
  assert.equal((await call(staff, '/api/setup/suppliers')).status, 403)
})

test('a dish keeps its recipe in base units, and a printed menu needs a check before it is saved', async () => {
  const { data } = await call(owner, '/api/setup/dishes', 'POST', { name: 'Burger', pricePence: 1200, targetMargin: 70, lines: [{ name: 'Beef mince', quantity: 180, unit: 'g' }, { name: 'Bun', quantity: 1, unit: 'each' }] })
  const dish = (await call(owner, '/api/setup/dishes')).data.find((row: any) => row.id === data.id)
  assert.deepEqual(dish.lines.map((line: any) => [line.name, line.quantity, line.unit]), [['Beef mince', 0.18, 'kg'], ['Bun', 1, 'each']])
  assert.equal(dish.costPence, null)
  assert.deepEqual(dish.unpriced.sort(), ['Beef mince', 'Bun'])
  assert.equal((await call(owner, '/api/setup/dishes', 'POST', { name: 'Odd', pricePence: 500, lines: [{ name: 'Bun', quantity: 1, unit: 'kg' }] })).status, 400)

  const before = (await call(owner, '/api/setup/dishes')).data.length
  const read = await upload(owner, '/api/setup/menu/read', {}, 'file', 'menu.png')
  assert.equal(read.data[0].name, 'Lamb kofta')
  assert.equal(read.data[1].pricePence, null)
  assert.equal((await call(owner, '/api/setup/dishes')).data.length, before)
})

test('a new checklist reaches staff, and a removed check keeps its past records', async () => {
  const saved = await call(owner, '/api/setup/checklists', 'POST', {
    name: 'Fryer close', dueTime: '23:00',
    schedule: { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6] },
    items: [{ label: 'Fryer cleaned', type: 'tick', proof: true, proofHint: 'The fryer is clean and off' }, { label: 'Oil level', type: 'tick' }],
  })
  assert.equal(saved.status, 201)
  const runs = (await call(staff, '/api/staff/runs')).data
  const run = runs.find((row: any) => row.name === 'Fryer close')
  assert.equal(run.total, 2)
  const view = (await call(staff, `/api/staff/runs/${run.id}`)).data
  assert.equal(view.items[0].needsProof, true)
  const list = (await call(owner, '/api/setup/checklists')).data.find((row: any) => row.name === 'Fryer close')
  await call(owner, `/api/setup/checklists/${list.id}`, 'PUT', { ...list, items: list.items.slice(0, 1) })
  assert.equal((await call(staff, `/api/staff/runs/${run.id}`)).data.items.length, 1)
  assert.equal((await call(owner, '/api/setup/checklists', 'POST', { name: 'Fryer close', dueTime: '23:00', items: [{ label: 'A', type: 'tick' }] })).status, 400)
})

test('SAM finds the thing, Spark judges it, and only the worker saves', async () => {
  const run = (await call(staff, '/api/staff/runs')).data.find((row: any) => row.name === 'Fryer close')
  const item = (await call(staff, `/api/staff/runs/${run.id}`)).data.items[0]
  const checked = await upload(staff, `/api/staff/runs/${run.id}/proof`, { itemId: String(item.id) })
  assert.equal(checked.status, 200)
  assert.equal(checked.data.verdict, 'ok')
  assert.equal(checked.data.boxes.length, 1)
  assert.ok(mock.state.samPhrases.includes('fryer'))
  assert.equal((await call(staff, `/api/staff/runs/${run.id}`)).data.items[0].entry, null)

  mock.state.proofVerdict = 'recheck'
  const doubtful = await upload(staff, `/api/staff/runs/${run.id}/proof`, { itemId: String(item.id) })
  assert.equal(doubtful.data.verdict, 'recheck')
  await call(staff, `/api/staff/runs/${run.id}/entries`, 'POST', { itemId: item.id, proofId: doubtful.data.proofId, source: 'photo' })
  const saved = (await call(staff, `/api/staff/runs/${run.id}`)).data.items[0].entry
  assert.equal(saved.proof.verdict, 'recheck')
  const action = (await call(owner, '/api/home')).data.actions.find((row: any) => row.sourceType === 'proof')
  assert.equal(action.title, 'Check the photo: Fryer cleaned')
  assert.match(action.href, /^#\/run\//)
  mock.state.proofVerdict = 'ok'
})

test('a check that needs a picture cannot be saved without one, and a photo fills in the reading', async () => {
  const run = (await call(staff, '/api/staff/runs')).data.find((row: any) => row.name === 'Opening checks')
  const item = (await call(staff, `/api/staff/runs/${run.id}`)).data.items[0]
  const refused = await call(staff, `/api/staff/runs/${run.id}/entries`, 'POST', { itemId: item.id, source: 'tick' })
  assert.equal(refused.status, 400)
  assert.equal(refused.data.error, 'Add a photo or video first.')
  const fridge = (await call(staff, '/api/staff/runs')).data.find((row: any) => row.name === 'Fridge and water checks')
  const reading = (await call(staff, `/api/staff/runs/${fridge.id}`)).data.items[0]
  assert.equal(reading.needsProof, true)
  const checked = await upload(staff, `/api/staff/runs/${fridge.id}/proof`, { itemId: String(reading.id) })
  assert.equal(checked.data.reading, 4)
  assert.equal(checked.data.type, 'temperature')
  await call(staff, `/api/staff/runs/${fridge.id}/entries`, 'POST', { itemId: reading.id, proofId: checked.data.proofId, value: 4, source: 'photo' })
  assert.equal((await call(staff, `/api/staff/runs/${fridge.id}`)).data.items[0].entry.value, 4)
})

test('a proof from another check is ignored', async () => {
  const runs = (await call(staff, '/api/staff/runs')).data
  const run = runs.find((row: any) => row.name === 'Fryer close')
  const other = runs.find((row: any) => row.name === 'Opening checks')
  const item = (await call(staff, `/api/staff/runs/${other.id}`)).data.items[0]
  const fryer = (await call(staff, `/api/staff/runs/${run.id}`)).data.items[0]
  const checked = await upload(staff, `/api/staff/runs/${run.id}/proof`, { itemId: String(fryer.id) })
  const refused = await call(staff, `/api/staff/runs/${other.id}/entries`, 'POST', { itemId: item.id, proofId: checked.data.proofId, source: 'tick' })
  assert.equal(refused.status, 400)
  assert.equal((await call(staff, `/api/staff/runs/${other.id}`)).data.items[0].entry, null)
})

test('SAM box text reads the way the docs show it', () => {
  const boxes = readSamBoxes('<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~a|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561;c=0.8|><|mask;x=0;y=0;data=1|>')
  assert.deepEqual(boxes.map((box) => [box.x1, box.h, box.c]), [[353, 561, null], [260, 561, 0.8]])
})

test('a photo with several receipts becomes one row each', async () => {
  mock.state.samBoxes = [{ x1: 0, y1: 0, x2: 400, y2: 700, c: 0.9 }, { x1: 500, y1: 0, x2: 900, y2: 700, c: 0.9 }, { x1: 1, y1: 1, x2: 3, y2: 3, c: 0.9 }]
  const form = new FormData()
  form.append('files', image(), 'pile.png')
  await fetch(`${base}/api/invoices`, { method: 'POST', headers: { Cookie: owner }, body: form })
  for (let wait = 0; wait < 60; wait += 1) {
    const rows = (await call(owner, '/api/invoices')).data.filter((row: any) => row.name === 'pile.png')
    if (rows.length === 2 && rows.every((row: any) => row.status !== 'reading')) {
      mock.state.samBoxes = null
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail('expected two rows from one photo')
})

test('receipts and their export follow the chosen dates, and sort as asked', async () => {
  const all = (await call(owner, '/api/invoices')).data
  assert.ok(all.length)
  assert.equal((await call(owner, '/api/invoices?from=2001-01-01&to=2001-12-31')).data.length, 0)
  const csv = await fetch(`${base}/api/invoices.csv?from=2001-01-01&to=2001-12-31`, { headers: { Cookie: owner } })
  assert.match(csv.headers.get('content-disposition')!, /2001-01-01-to-2001-12-31/)
  assert.equal((await csv.text()).trim().split('\r\n').length, 1)
  const sorted = (await call(owner, '/api/invoices?sort=amount&direction=asc')).data.map((row: any) => row.grossPence ?? 0)
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b))
})

test('the dashboard works for any dates and keeps a list of reports', async () => {
  const range = { from: '2026-01-01', to: '2026-01-31' }
  const view = (await call(owner, `/api/summary?from=${range.from}&to=${range.to}`)).data
  assert.deepEqual(view.facts.period, range)
  assert.deepEqual(view.facts.previous, { from: '2025-12-01', to: '2025-12-31' })
  const ran = (await call(owner, '/api/summary/run', 'POST', range)).data
  assert.equal(ran.report.weekStart, range.from)
  assert.ok(ran.reports.length >= 1)
  assert.equal((await call(owner, `/api/summary/${ran.report.id}`)).data.id, ran.report.id)
  assert.equal((await call(owner, '/api/summary?from=2026-02-01&to=2026-02-28')).data.report, null)
})

test('Gmail signs in, sends a confirmation, and brings each supplier invoice in once', async () => {
  const login = await fetch(`${base}/api/google/login`, { headers: { Cookie: owner }, redirect: 'manual' })
  const location = new URL(login.headers.get('location')!)
  assert.match(location.searchParams.get('scope')!, /gmail\.send/)
  await fetch(`${base}/api/google/callback?code=abc&state=forged`, { headers: { Cookie: owner }, redirect: 'manual' })
  assert.equal((await call(owner, '/api/connections')).data.gmail.connected, false)
  const state = location.searchParams.get('state')!
  await fetch(`${base}/api/google/callback?code=abc&state=${state}`, { headers: { Cookie: owner }, redirect: 'manual' })
  const status = (await call(owner, '/api/connections')).data
  assert.equal(status.gmail.connected, true)
  assert.equal(status.gmail.account, 'owner@restaurant.test')
  assert.doesNotMatch(JSON.stringify(status), /refresh/)

  const { buildMail } = await import('../server/integrations/gmail.ts')
  const raw = Buffer.from(buildMail({ to: 'a@b.test\r\nBcc: evil@b.test', subject: 'Hello\r\nBcc: evil@b.test', body: 'Hi' }), 'base64url').toString()
  assert.doesNotMatch(raw, /\r\nBcc:/)

  const added = () => call(owner, '/api/google/check', 'POST')
  google.messages.set('m1', { payload: { parts: [{ filename: 'invoice.png', body: { attachmentId: 'a1' } }, { filename: 'notes.exe', body: { attachmentId: 'a2' } }] } })
  assert.equal((await added()).data.added, 1)
  assert.equal((await added()).data.added, 0)
  const rows = (await call(owner, '/api/invoices')).data.filter((row: any) => row.source === 'gmail')
  assert.equal(rows.length, 1)
})

test('keys and staff numbers saved in the app go to the file and never come back', async () => {
  const saved = await call(owner, '/api/connections/save', 'POST', { WHATSAPP_TOKEN: 'wa-token', HACK: 'nope' })
  assert.equal(saved.status, 200)
  await call(owner, '/api/team/people', 'POST', { name: 'Ana', number: '+44 7700 900123', language: 'ro' })
  const text = fs.readFileSync(envFile, 'utf8')
  assert.match(text, /WHATSAPP_TOKEN=wa-token/)
  assert.match(text, /WHATSAPP_STAFF_NUMBERS=Ana:447700900123:ro/)
  assert.doesNotMatch(text, /HACK/)
  const setup = JSON.stringify((await call(owner, '/api/setup')).data)
  assert.match(setup, /Ana/)
  assert.doesNotMatch(setup + JSON.stringify((await call(owner, '/api/connections')).data), /447700900123|wa-token/)
})

test('schedules land on the right days', async () => {
  const { occursOn, cleanSchedule } = await import('../server/core/schedule.ts')
  const firstAndThirdWednesday = { kind: 'monthly', rules: [{ week: 1, day: 3 }, { week: 3, day: 3 }] } as const
  assert.deepEqual(['2026-11-04', '2026-11-11', '2026-11-18', '2026-11-25'].map((date) => occursOn(firstAndThirdWednesday as any, date)), [true, false, true, false])
  assert.equal(occursOn({ kind: 'monthly', rules: [{ week: -1, day: 5 }] }, '2026-11-27'), true)
  assert.equal(occursOn({ kind: 'monthly', rules: [{ week: -1, day: 5 }] }, '2026-11-20'), false)
  assert.equal(occursOn({ kind: 'days', days: [1, 3] }, '2026-11-02'), true)
  assert.equal(occursOn({ kind: 'days', days: [1, 3] }, '2026-11-03'), false)
  assert.equal(cleanSchedule({ kind: 'days', days: [] }), null)
  assert.equal((await call(owner, '/api/setup/checklists', 'POST', { name: 'Never', schedule: { kind: 'days', days: [] }, dueTime: '10:00', items: [{ label: 'A', type: 'tick' }] })).status, 400)
})

test('the calendar shows what happened and what is planned', async () => {
  const { localTime } = await import('../server/core/clock.ts')
  const { date } = localTime()
  const days = (await call(owner, `/api/checklists/calendar?month=${date.slice(0, 7)}`)).data
  const today = days.find((day: any) => day.date === date)
  assert.ok(today.items.some((item: any) => item.name === 'Opening checks' && item.runId))
  assert.equal((await call(owner, '/api/checklists/calendar?month=nope')).status, 400)
})

test('the owner adds a task and sets its priority, and Stockpot keeps to it', async () => {
  const { data } = await call(owner, '/api/actions', 'POST', { title: 'Ring the landlord', urgency: 'soon' })
  await call(owner, `/api/actions/${data.id}/urgency`, 'POST', { urgency: 'now' })
  const task = (await call(owner, '/api/home')).data.actions.find((row: any) => row.id === data.id)
  assert.equal(task.urgency, 'now')
  assert.equal(task.source, 'You added this')
  const overdue = (await call(owner, '/api/home')).data.actions.find((row: any) => row.sourceType === 'overdue')
  if (overdue) {
    await call(owner, `/api/actions/${overdue.id}/urgency`, 'POST', { urgency: 'soon' })
    assert.equal((await call(owner, '/api/home')).data.actions.find((row: any) => row.id === overdue.id).urgency, 'soon')
  }
})

test('a late checklist goes to the person, then the owner, and rings a phone once', async () => {
  const { db } = await import('../server/core/db.ts')
  const { chaseLate } = await import('../server/operations/chase.ts')
  const { config } = await import('../server/core/config.ts')
  const { callScript } = await import('../server/integrations/phone.ts')
  Object.assign(config.twilio, { accountSid: 'AC1', authToken: 'secret', fromNumber: '+15550001111', baseUrl: mock.httpBase })
  Object.assign(config.whatsapp, { token: 'wa', phoneNumberId: '555', ownerNumber: '447700900001', baseUrl: mock.httpBase, staff: [{ name: 'Maria', number: '447700900002', language: 'pl' }] })
  const list = await call(owner, '/api/setup/checklists', 'POST', { name: 'Late list', schedule: { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6] }, dueTime: '00:00', assignee: 'Maria', chaseAfter: 0, callWho: 'assignee', items: [{ label: 'One', type: 'tick', proof: false }] })
  await call(staff, '/api/staff/runs')
  const before = mock.state.whatsapp.length
  const { localTime } = await import('../server/core/clock.ts')
  const earlier = new Date(Date.parse(`${localTime().stamp}:00Z`) - 5 * 60000).toISOString().slice(0, 16)
  await db.exec(`UPDATE checklist_runs SET due_at = '${earlier}', completed_at = NULL WHERE template_id = ${list.data.id}`)
  await chaseLate()
  await chaseLate()
  assert.equal(mock.state.whatsapp.length, before + 1)
  assert.equal(mock.state.whatsapp.at(-1).body.to, '447700900002')
  assert.equal(mock.state.calls.length, 1)
  const form = new URLSearchParams(mock.state.calls[0].body)
  assert.equal(form.get('To'), '+447700900002')
  assert.match(form.get('Twiml')!, /language="pl-PL" voice="Google.pl-PL-Standard-F"/)
  assert.match(callScript('A & B', 'ko'), /A &amp; B/)
  assert.match(callScript('Hello', 'ne'), /language="en-GB"/)
  assert.match(callScript('Hello', 'ar'), /language="ar-XA"/)
})

test('numbers become ones Twilio can dial, and its errors never quote them', async () => {
  const { config } = await import('../server/core/config.ts')
  const { dialable, testCall } = await import('../server/integrations/phone.ts')
  assert.equal(dialable('07700 900123'), '+447700900123')
  assert.equal(dialable('0044 7700 900123'), '+447700900123')
  assert.equal(dialable('+1 (415) 555-0100'), '+14155550100')
  assert.equal(dialable('447700900123'), '+447700900123')
  assert.equal(dialable(''), '')

  const saved = { ...config.twilio }
  Object.assign(config.twilio, { accountSid: 'AC1', authToken: 'secret', fromNumber: '+15550001111', baseUrl: mock.httpBase, ownerNumber: '07700 900999' })
  const worked = await testCall()
  assert.equal(worked.ok, true)
  assert.equal(new URLSearchParams(mock.state.calls.at(-1).body).get('To'), '+447700900999')

  mock.state.callError = { code: 21219, message: 'The number +447700900999 is unverified.' }
  const refused = await testCall()
  assert.equal(refused.ok, false)
  assert.match(refused.detail!, /trial Twilio account/)
  assert.doesNotMatch(refused.detail!, /447700900999/)
  const status = (await call(owner, '/api/connections')).data
  assert.equal(status.phone.last.status, 'failed')
  assert.doesNotMatch(JSON.stringify(status), /447700900999/)
  mock.state.callError = null
  Object.assign(config.twilio, saved)
})

test('the database is copied once a day and only a week is kept', async () => {
  const { backupIfDue, dataStatus } = await import('../server/core/backup.ts')
  const { config } = await import('../server/core/config.ts')
  const { isPostgres, run: sql } = await import('../server/core/db.ts')
  const folder = path.join(config.dataDir, 'backups')
  const ending = isPostgres() ? 'json' : 'sqlite'
  assert.equal(await backupIfDue(), true)
  assert.equal(await backupIfDue(), false)
  for (let day = 1; day <= 9; day += 1) fs.writeFileSync(path.join(folder, `stockpot-2020-01-0${day}.${ending}`), '')
  fs.rmSync(path.join(folder, fs.readdirSync(folder).sort().at(-1)!))
  await sql(`DELETE FROM settings WHERE key LIKE 'claim:backup:%'`)
  assert.equal(await backupIfDue(), true)
  assert.equal(fs.readdirSync(folder).length, 7)
  assert.ok((await dataStatus()).kept.suppliers > 0)
  assert.ok((await dataStatus()).lastBackup)
})

test('an invite link adds someone the moment they send it, and only once', async () => {
  const { joinByInvite } = await import('../server/operations/invites.ts')
  const made = await call(owner, '/api/team/invites', 'POST', { name: 'Tomasz', language: 'pl' })
  assert.match(made.data.link, /^https:\/\/wa\.me\/447700900111\?text=JOIN%20[0-9A-F]{6}$/)
  assert.equal(await joinByInvite({ from: '447700900055', text: { body: 'hello' } }), false)
  assert.equal(await joinByInvite({ from: '447700900055', text: { body: `JOIN ${made.data.code}` } }), true)
  assert.equal(await joinByInvite({ from: '447700900056', text: { body: `JOIN ${made.data.code}` } }), false)
  const setup = (await call(owner, '/api/setup')).data
  assert.ok(setup.people.some((person: any) => person.name === 'Tomasz'))
  assert.doesNotMatch(JSON.stringify(setup), /447700900055/)
})

test('past reports list their numbers from the day they were written', async () => {
  const { reports } = (await call(owner, '/api/summary')).data
  assert.ok(reports.length)
  assert.ok('salesPence' in reports[0] && 'foodCost' in reports[0])
})

test('the analyst can run in the background and shows its steps', async () => {
  const range = { from: '2026-03-01', to: '2026-03-31' }
  const started = await call(owner, '/api/summary/run', 'POST', { ...range, background: true })
  assert.equal(started.status, 202)
  assert.equal(started.data.running, true)
  for (let wait = 0; wait < 100; wait += 1) {
    const view = (await call(owner, `/api/summary?from=${range.from}&to=${range.to}`)).data
    if (!view.running) {
      assert.equal(view.report.weekStart, range.from)
      assert.ok(view.progress.length)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail('the analyst never finished')
})

test('staff can read recipes, and never a price', async () => {
  const dish = (await call(owner, '/api/setup/dishes', 'POST', { name: 'Dal', pricePence: 900, targetMargin: 75, method: 'Simmer for 30 minutes.', lines: [{ name: 'Red lentils', quantity: 120, unit: 'g' }] })).data
  const recipes = (await call(staff, '/api/staff/recipes')).data
  const dal = recipes.find((row: any) => row.id === dish.id)
  assert.equal(dal.method, 'Simmer for 30 minutes.')
  assert.equal(dal.lines[0].quantity, 0.12)
  assert.doesNotMatch(JSON.stringify(recipes), /price|margin|cost/i)
})

test('the owner edits a crisis card, staff get it, and it can go back to the standard one', async () => {
  const { crisisCard } = await import('../server/operations/crisisCards.ts')
  const standard = (await crisisCard('gas'))!
  assert.equal(standard.edited, false)
  assert.equal((await call(staff, '/api/crisis/gas', 'PUT', { title: 'x', steps: [{ text: 'y' }] })).status, 403)
  assert.equal((await call(owner, '/api/crisis/gas', 'PUT', { title: 'Gas', steps: [] })).status, 400)
  await call(owner, '/api/crisis/gas', 'PUT', { title: 'Gas leak', number: '020 7946 0001', steps: [{ text: 'Open the back door.', photo: null }] })
  const open = await (await fetch(`${base}/api/crisis`)).json() as any[]
  const gas = open.find((card) => card.key === 'gas')
  assert.equal(gas.title, 'Gas leak')
  assert.equal(gas.steps[0].text, 'Open the back door.')
  assert.equal(gas.call.number, '02079460001')
  const made = await call(owner, '/api/crisis', 'POST', { title: 'Flood', steps: [{ text: 'Turn off the water.' }] })
  assert.ok((await call(owner, '/api/home')).data.features.find((row: any) => row.key === 'crisis').note.startsWith('6'))
  await call(owner, `/api/crisis/${made.data.key}`, 'DELETE')
  await call(owner, '/api/crisis/gas', 'DELETE')
  assert.deepEqual(await crisisCard('gas'), standard)
  assert.equal((await fetch(`${base}/api/crisis/photo/not-a-photo.png`)).status, 404)
})

test('a delivery is tracked from order to arrival, and a problem reaches the owner with a call button', async () => {
  const supplier = (await call(owner, '/api/setup/suppliers', 'POST', { name: 'Coastline Fish', email: 'hi@coastline.test', phone: '020 7946 0100' })).data
  const today = new Date().toISOString().slice(0, 10)
  assert.equal((await call(owner, '/api/orders', 'POST', { supplierId: supplier.id, deliveryDate: today, lines: [] })).status, 400)
  const order = (await call(owner, '/api/orders', 'POST', { supplierId: supplier.id, deliveryDate: today, lines: [{ name: 'Cod loin', quantity: 5, unit: 'kg' }, { name: 'Lemons', quantity: 500, unit: 'g' }] })).data
  const check = (await call(owner, `/api/checks/${order.id}`)).data
  assert.equal(check.state, 'waiting')
  assert.equal(check.arrivedAt, null)
  assert.equal(check.lines[1].ordered, 0.5)
  const due = (await call(owner, '/api/home')).data.actions.find((row: any) => row.sourceType === 'delivery' && row.href === `#/checks/${order.id}`)
  assert.equal(due.suggested.href, 'tel:02079460100')

  const view = (await call(staff, `/api/staff/deliveries/${order.id}`)).data
  await call(staff, `/api/staff/deliveries/${order.id}/counts`, 'POST', {
    stored: 'Walk-in fridge', note: 'Box was wet.',
    lines: [{ itemId: view.lines[0].itemId, received: 3 }, { itemId: view.lines[1].itemId, received: 0.5, issue: 'damaged' }],
  })
  const after = (await call(owner, `/api/checks/${order.id}`)).data
  assert.ok(after.arrivedAt)
  assert.equal(after.storedAt, 'Walk-in fridge')
  assert.equal(after.deliveryNote, 'Box was wet.')
  assert.deepEqual(after.lines.map((line: any) => line.issue), ['short', 'damaged'])
  const problem = (await call(owner, '/api/home')).data.toConfirm.find((row: any) => row.sourceType === 'problem')
  assert.equal(problem.urgency, 'now')
  assert.equal(problem.title, 'Problem with the Coastline Fish delivery')
  assert.match(problem.detail, /Cod loin: short, 3 of 5 kg/)
  assert.equal(problem.suggested.href, 'tel:02079460100')
  assert.equal(problem.href, `#/checks/${order.id}`)
  assert.equal((await call(owner, '/api/home')).data.actions.some((row: any) => row.sourceType === 'delivery' && row.href === `#/checks/${order.id}`), false)
})

test('a delivery with no problems sends nothing urgent', async () => {
  const supplier = (await call(owner, '/api/setup/suppliers', 'POST', { name: 'Clean Veg' })).data
  const order = (await call(owner, '/api/orders', 'POST', { supplierId: supplier.id, deliveryDate: '2099-01-01', lines: [{ name: 'Leeks', quantity: 2, unit: 'kg' }] })).data
  const view = (await call(staff, `/api/staff/deliveries/${order.id}`)).data
  await call(staff, `/api/staff/deliveries/${order.id}/counts`, 'POST', { stored: 'Dry store', lines: [{ itemId: view.lines[0].itemId, received: 2 }] })
  assert.equal((await call(owner, `/api/checks/${order.id}`)).data.problem, false)
})

test('counted and saved words translate, and details stay as they were', () => {
  const words = { '{n} lists': { one: '{n} lista', few: '{n} listy', many: '{n} list', other: '{n} listy' }, '{item} is low: {value}': '{item}: mało ({value})', 'Chicken thighs': 'Udka' }
  assert.equal(translateCount(words, 'pl', 1, '{n} list', '{n} lists'), '1 lista')
  assert.equal(translateCount(words, 'pl', 3, '{n} list', '{n} lists'), '3 listy')
  assert.equal(translateCount(words, 'pl', 5, '{n} list', '{n} lists'), '5 list')
  assert.equal(translateSaved(words, 'Chicken thighs is low: 3 kg'), 'Udka: mało (3 kg)')
  assert.equal(translateSaved(words, 'Something the model wrote'), 'Something the model wrote')
})

test('SAM follows the thing through a video and Spark sees the stills it was in', async () => {
  const run = (await call(staff, '/api/staff/runs')).data.find((row: any) => row.name === 'Fryer close')
  const item = (await call(staff, `/api/staff/runs/${run.id}`)).data.items[0]
  const form = new FormData()
  for (let index = 0; index < 4; index += 1) form.append('frames', image(), `frame-${index}.png`)
  form.append('video', new Blob([fs.readFileSync('public/samples/sample-proof.mp4')], { type: 'video/mp4' }), 'clip.mp4')
  form.append('itemId', String(item.id))
  form.append('seconds', '2')
  const sent = () => fetch(`${base}/api/staff/runs/${run.id}/proof`, { method: 'POST', headers: { Cookie: staff }, body: form }).then((response) => response.json() as any)

  const followed = await sent()
  assert.equal(followed.boxes.length, 0)
  assert.equal(followed.track.objects, 1)
  assert.equal(followed.track.share, 67)
  assert.ok(followed.track.path[0].t > 0.3 && followed.track.path[0].boxes[0].id === 0)

  mock.state.samVideoFrames = []
  const missing = await sent()
  assert.equal(missing.track.share, 0)
  assert.deepEqual(missing.track.path, [])
  mock.state.samVideoFrames = null
})

test('readSamFrames keeps ids and skips frames with nothing in them', () => {
  const box = 'box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=0.5'
  const frames = readSamFrames(`<3f>0<|${box}|><|mask;x=0;y=0;data=1,!AA|>,2<|${box}|><|mask;x=0;y=0;data=1,!AA|>\n<7f>2<|${box}|><|mask;x=0;y=0;data=1,!AA|>`)
  assert.deepEqual(frames.map((frame) => [frame.frame, frame.objects.map((object) => object.id)]), [[3, [0, 2]], [7, [2]]])
  assert.equal(summariseTrack(frames, 0).objects, 2)
  assert.equal(summariseTrack([], 2).share, 0)
})

test('a delivery can bring a new supplier, with its own order date', async () => {
  const lines = [{ name: 'Lemons', quantity: 6, unit: 'kg' }]
  const early = await call(owner, '/api/orders', 'POST', { newSupplier: { name: 'Corner Greens' }, orderedOn: '2026-11-03', deliveryDate: '2026-11-02', lines })
  assert.equal(early.status, 400)
  assert.equal((await call(owner, '/api/setup/suppliers')).data.some((row: any) => row.name === 'Corner Greens'), false)

  assert.equal((await call(owner, '/api/orders', 'POST', { newSupplier: { name: '' }, orderedOn: '2026-11-01', deliveryDate: '2026-11-02', lines })).status, 400)
  const made = await call(owner, '/api/orders', 'POST', { newSupplier: { name: 'Corner Greens', phone: '020 7946 0199' }, orderedOn: '2026-10-30', deliveryDate: '2026-11-02', lines })
  assert.equal(made.status, 201)
  const check = (await call(owner, `/api/checks/${made.data.id}`)).data
  assert.equal(check.supplier, 'Corner Greens')
  assert.equal(check.orderedOn, '2026-10-30')
  assert.equal(check.deliveryDate, '2026-11-02')
})

test('owner or staff can take a delivery in and add pictures', async () => {
  const orderId = (await call(owner, '/api/checks')).data.find((row: any) => row.supplier === 'Corner Greens').orderId
  const added = await upload(staff, `/api/staff/deliveries/${orderId}/media`, { addedBy: 'Maria' })
  assert.equal(added.status, 201)
  assert.equal(added.data.media[0].addedBy, 'Maria')
  assert.equal((await fetch(`${base}/api/staff/delivery-media/${added.data.media[0].file}`, { headers: { Cookie: staff } })).status, 200)
  assert.equal((await fetch(`${base}/api/staff/delivery-media/not-a-delivery.png`, { headers: { Cookie: staff } })).status, 404)
  assert.equal((await upload(owner, `/api/staff/deliveries/${orderId}/media`, { addedBy: 'Owner' })).status, 201)

  const itemId = (await call(staff, `/api/staff/deliveries/${orderId}`)).data.lines[0].itemId
  const done = await call(owner, `/api/staff/deliveries/${orderId}/counts`, 'POST', { receivedBy: 'Sam', arrivedOn: '2026-10-31', stored: 'Kitchen', lines: [{ itemId, received: 6 }] })
  assert.equal(done.status, 200)
  const check = (await call(owner, `/api/checks/${orderId}`)).data
  assert.equal(check.receivedBy, 'Sam')
  assert.equal(check.arrivedAt.slice(0, 10), '2026-10-31')
  assert.equal(check.media.length, 2)
})

test('the real frame count comes from the MP4 file', () => {
  assert.equal(mp4FrameCount(fs.readFileSync('public/samples/sample-proof.mp4')), 30)
  assert.equal(mp4FrameCount(fs.readFileSync('public/samples/sample-delivery.mp4')), 60)
  assert.equal(mp4FrameCount(Buffer.from('not a video')), 0)
  const seen = [{ frame: 0, objects: [{ id: 0, x1: 0, y1: 0, x2: 1, y2: 1, w: 2, h: 2, c: null }] }]
  assert.equal(summariseTrack(seen, 4, 60).fps, 15)
})

test('a blink is not one more box, and each object keeps one number', () => {
  const object = (id: number) => ({ id, x1: 0, y1: 0, x2: 1, y2: 1, w: 2, h: 2, c: null })
  const frames = [...Array(30).keys()].map((frame) => ({ frame, objects: [object(0), ...(frame > 15 ? [object(4)] : []), ...(frame === 7 ? [object(9)] : [])] }))
  const { count, peak, numbers } = countObjects(frames, 30)
  assert.equal(count, 2)
  assert.equal(peak, 2)
  assert.deepEqual([...numbers.entries()], [[0, 1], [4, 2]])
  assert.equal(phraseFor('box', 'Tomatoes'), 'cardboard box')
  assert.equal(phraseFor('item', 'Tomatoes'), 'tomatoes')
})

test('filming a delivery counts it, but only a person changes the number', async () => {
  const made = await call(owner, '/api/orders', 'POST', { supplierId: (await call(owner, '/api/suppliers')).data[0].id, deliveryDate: '2099-01-01', lines: [{ name: 'Tinned plum tomatoes', quantity: 30, unit: 'kg' }] })
  const order = (await call(staff, `/api/staff/deliveries/${made.data.id}`)).data
  const form = new FormData()
  form.append('frames', image(), 'frame-0.png')
  form.append('video', new Blob([fs.readFileSync('public/samples/sample-delivery.mp4')], { type: 'video/mp4' }), 'clip.mp4')
  Object.entries({ itemId: String(order.lines[0].itemId), what: 'box', seconds: '4', addedBy: 'Maria' }).forEach(([key, value]) => form.append(key, value))
  const counted = await fetch(`${base}/api/staff/deliveries/${made.data.id}/count`, { method: 'POST', headers: { Cookie: staff }, body: form }).then((response) => response.json() as any)
  assert.equal(counted.count, 4)
  assert.equal(counted.track.path[0].t, 0)
  assert.equal(counted.track.path.at(-1).t, 3.93)
  assert.ok(counted.track.path.some((row: any) => row.boxes.some((box: any) => box.n === 4)))
  assert.equal(counted.media.at(-1).counted, 4)
  assert.equal((await call(staff, `/api/staff/deliveries/${made.data.id}`)).data.lines[0].received, null)

  const refused = await call(staff, `/api/staff/deliveries/${made.data.id}/count-sample`, 'POST', { itemId: order.lines[0].itemId, what: 'box' })
  assert.equal(refused.status, 400)
})

test('what to say on a call uses the numbers from the check, and refuses any the model writes', async () => {
  const supplierId = (await call(owner, '/api/suppliers')).data[0].id
  const made = await call(owner, '/api/orders', 'POST', { supplierId, deliveryDate: '2099-01-01', lines: [{ name: 'Lemon crates', quantity: 10, unit: 'kg' }] })
  const itemId = (await call(staff, `/api/staff/deliveries/${made.data.id}`)).data.lines[0].itemId
  await call(staff, `/api/staff/deliveries/${made.data.id}/counts`, 'POST', { lines: [{ itemId, received: 8 }] })
  const words = (await call(owner, `/api/checks/${made.data.id}/what-to-say`, 'POST')).data
  assert.ok(words.facts.some((fact: string) => fact.includes('10 kg') && fact.includes('8 kg')))
  assert.ok(!/\d/.test(words.opening + words.ask + words.pushback))
  assert.equal((await call(staff, `/api/checks/${made.data.id}/what-to-say`, 'POST')).status, 403)
  assert.equal((await call(owner, '/api/checks/99999/what-to-say', 'POST')).status, 404)
})

test('old invoices alone show what prices cost, and anything billed twice', async () => {
  const supplier = await insert("INSERT INTO suppliers (name) VALUES ('Price Check Foods')")
  const item = await insert("INSERT INTO items (name, aliases, base_unit) VALUES ('Check beef', '[]', 'kg')")
  const invoice = async (number: string, date: string, gross: number, price: number, quantity: number, line?: number) => {
    const id = await insert(`INSERT INTO invoices (file, original_name, status, supplier_id, supplier_name, number, date, net_p, vat_p, gross_p, created_at) VALUES ('x.png', 'x.png', 'read', ?, 'Price Check Foods', ?, ?, ?, 0, ?, '2026-01-01')`, supplier, number, date, gross, gross)
    await run(`INSERT INTO invoice_lines (invoice_id, item_id, description, qty_billed, unit, unit_price_p, line_total_p, qty_base_milli, price_base_p) VALUES (?, ?, 'Beef mince', ?, 'kg', ?, ?, ?, ?)`, id, line ?? item, quantity, price, price * quantity, quantity * 1000, price)
  }
  await invoice('A1', '2024-01-02', 5000, 500, 10)
  await invoice('A2', '2024-01-09', 5500, 550, 10)
  await invoice('A3', '2024-01-16', 6000, 600, 10)
  await invoice('A3', '2024-01-16', 6000, 600, 10)
  await invoice('A4', '2024-01-20', 4800, 480, 10)
  const found = await priceCheck({ from: '2024-01-01', to: '2024-01-31' })
  assert.equal(found.invoices, 5)
  assert.equal(found.extraPence, 2500)
  assert.deepEqual([found.items[0].firstPence, found.items[0].times], [500, 3])
  assert.equal(found.twice.length, 1)
  assert.equal((await priceCheck({ from: '2024-02-01', to: '2024-02-28' })).extraPence, 0)
})

test('Test Meta covers images, video, voice and live calls', async () => {
  const tested = await call(owner, '/api/connections/meta/test', 'POST')
  assert.match(tested.data.detail, /Video: found/)
  assert.match(tested.data.detail, /Voice: heard/)
  assert.match(tested.data.detail, /Live call: connected/)
})
