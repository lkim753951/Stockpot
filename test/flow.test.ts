import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

/**
 * Runs the whole flow against the mock Meta API, through the real HTTP and WebSocket routes.
 * The app is in "live" mode here, so the same client code runs that a real key would use.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-test-'))
process.env.DATA_DIR = dataDir
process.env.SAMPLE_DATA = '1'
process.env.MODEL_API_KEY = 'test-key'
process.env.OWNER_PASSCODE = 'owner-code'
process.env.STAFF_PASSCODE = 'staff-code'
process.env.REPLAY_SPEED = '40'

const { startMockMeta } = await import('../server/sample/mockMeta.ts')
const mock = await startMockMeta()
process.env.META_BASE_URL = mock.httpBase
process.env.META_REALTIME_URL = mock.wsUrl
const { buildApp } = await import('../server/app.ts')

let base = ''
let wsBase = ''
let ownerCookie = ''
let staffCookie = ''
const server = await buildApp()

async function api(url: string, options: { method?: string; body?: unknown; cookie?: string } = {}) {
  const response = await fetch(`${base}${url}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Cookie: options.cookie ?? ownerCookie },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json: any = text
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json }
}

async function waitFor<T>(work: () => Promise<T | null | undefined | false>, label: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await work()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function runSampleCall(supplierId: number) {
  const created = await api('/api/calls', { body: { supplierId, consent: true, source: 'sample' } })
  assert.equal(created.status, 201)
  const socket = new WebSocket(`${wsBase}/ws/call/${created.json.id}`, { headers: { Cookie: ownerCookie } })
  const events: any[] = []
  socket.on('message', (data) => events.push(JSON.parse(data.toString())))
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
  const done = await waitFor(async () => events.find((event) => event.type === 'done'), 'call to finish', 15000)
  socket.close()
  return { events, orderId: done.orderId, callId: created.json.id }
}

before(async () => {
  // These tests are about readings and ticks. Pictures have their own tests in setup.test.ts.
  ;await (await import('../server/core/db.ts')).run('UPDATE checklist_items SET proof = 0')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  base = `http://127.0.0.1:${port}`
  wsBase = `ws://127.0.0.1:${port}`
  const login = async (passcode: string) => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  ownerCookie = await login('owner-code')
  staffCookie = await login('staff-code')
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('the API refuses people who have not signed in, and a wrong passcode', async () => {
  assert.equal((await api('/api/checks', { cookie: '' })).status, 401)
  assert.equal((await api('/api/login', { body: { passcode: 'nope' } })).status, 401)
})

test('a call needs the recording to have been announced', async () => {
  const response = await api('/api/calls', { body: { supplierId: 1, consent: false, source: 'sample' } })
  assert.equal(response.status, 400)
})

test('call, delivery and invoice flow finds the money owed', async () => {
  const suppliers = (await api('/api/suppliers')).json
  const harrow = suppliers.find((supplier: any) => supplier.name === 'Harrow Lane Foods')

  const { events, orderId, callId } = await runSampleCall(harrow.id)

  // Handshake used the documented realtime format, with catalogue words as keywords.
  const handshake = mock.state.handshakes.at(-1)
  assert.equal(handshake.mode, 'ENDPOINTING')
  assert.equal(handshake.audioEncoding, 'PCM_24KHZ')
  assert.ok(handshake.keywords.includes('Chicken thighs'))

  // The live card shows the rise, the last price paid, the rival and the effect on dishes.
  const offer = events.find((event) => event.type === 'card' && event.card.kind === 'offer' && event.card.itemName === 'Chicken thighs').card
  assert.equal(offer.pricePence, 690)
  assert.equal(offer.lastPaid.pence, 640)
  assert.equal(offer.deltaPence, 50)
  assert.equal(offer.deltaPercent, 7.8)
  assert.equal(offer.cheaper.supplier, 'Northgate Wholesale')
  assert.equal(offer.cheaper.pence, 610)
  assert.equal(offer.extraCostPence, 1000)
  assert.match(offer.sayThis, /£6\.40/)
  assert.ok(offer.dishes.some((dish: any) => dish.name === 'Chicken curry'))

  // A remembered price must not become the current offer, and the deal must land.
  const thighCards = events.filter((event) => event.type === 'card' && event.card.itemName === 'Chicken thighs').map((event) => event.card)
  assert.equal(thighCards.at(-1).kind, 'agreed')
  assert.equal(thighCards.at(-1).pricePence, 640)
  assert.ok(!thighCards.some((card) => card.kind === 'offer' && card.pricePence === 610))

  // The draft order uses the agreed price and points at the words.
  assert.ok(orderId)
  const order = (await api(`/api/orders/${orderId}`)).json
  assert.equal(order.status, 'draft')
  const thighs = order.lines.find((line: any) => line.item === 'Chicken thighs')
  assert.equal(thighs.agreedPence, 640)
  assert.equal(thighs.quantity, 20)
  assert.equal(thighs.needsReview, false)
  assert.equal(order.turns[thighs.evidenceTurn - 1].role, 'supplier')
  assert.ok(order.tasks.some((task: any) => /Check in/.test(task.title)))

  // The recording is playable with range requests, which audio seeking needs.
  const audio = await fetch(`${base}/api/calls/${callId}/audio`, { headers: { Cookie: ownerCookie, Range: 'bytes=0-99' } })
  assert.equal(audio.status, 206)

  await api(`/api/orders/${orderId}/confirm`, { body: {} })

  // Staff read the delivery note, keep the handwritten 18 kg, and never see a price.
  const note = await api(`/api/staff/deliveries/${orderId}/sample-photo`, { method: 'POST', cookie: staffCookie })
  assert.equal(note.status, 200)
  assert.ok(!/pence|price|£/i.test(JSON.stringify(note.json).replace(/"notes":\[[^\]]*\]/, '')))
  const staffThighs = note.json.lines.find((line: any) => line.item === 'Chicken thighs')
  assert.equal(staffThighs.received, 18)
  const counts = note.json.lines.map((line: any) => ({ itemId: line.itemId, received: line.received }))
  assert.equal((await api(`/api/staff/deliveries/${orderId}/counts`, { body: { lines: counts }, cookie: staffCookie })).status, 200)

  // Checking in the delivery finishes the task the call created.
  const afterDelivery = (await api('/api/home')).json.actions
  assert.ok(!afterDelivery.some((action: any) => /^Check in the/.test(action.title)))

  // Staff are blocked from money routes.
  assert.equal((await api('/api/checks', { cookie: staffCookie })).status, 403)
  assert.equal((await api('/api/week', { cookie: staffCookie })).status, 403)
  assert.equal((await api(`/api/orders/${orderId}`, { cookie: staffCookie })).status, 403)

  await api('/api/invoices/sample', { method: 'POST' })
  const invoice = await waitFor(async () => {
    const list = (await api('/api/invoices')).json
    return list[0]?.status !== 'reading' && list[0]
  }, 'invoice')
  assert.equal(invoice.status, 'read')
  assert.equal(invoice.orderId, orderId)

  // 20 kg at £6.90 billed, 18 kg at £6.40 owed: £13.80 short plus £9.00 on price.
  const check = (await api(`/api/checks/${orderId}`)).json
  const line = check.lines.find((row: any) => row.item === 'Chicken thighs')
  assert.equal(line.shortPence, 1380)
  assert.equal(line.priceGapPence, 900)
  assert.equal(check.owedPence, 2280)
  assert.equal(check.state, 'owed')
  assert.equal(line.evidence.text, 'Go on then, six forty a kilo for you this week.')

  // The money owed reaches the owner's inbox, and the link opens the evidence.
  const claim = (await api('/api/home')).json.actions.find((action: any) => action.sourceType === 'check')
  assert.equal(claim.title, '£22.80 to claim from Harrow Lane Foods')
  assert.equal(claim.href, `#/checks/${orderId}`)

  const drafted = (await api(`/api/checks/${orderId}/credit`, { method: 'POST' })).json
  assert.equal(drafted.credit.status, 'draft')
  assert.match(drafted.credit.body, /Total credit requested: £22\.80/)
  assert.match(drafted.credit.body, /agreed £6\.40 per kg on the phone, billed £6\.90/)

  const approved = (await api(`/api/checks/${orderId}/approve`, { body: { subject: drafted.credit.subject, body: drafted.credit.body } })).json
  assert.equal(approved.credit.status, 'approved')

  await api(`/api/checks/${orderId}/settled`, { method: 'POST' })
  assert.ok(!(await api('/api/home')).json.actions.some((action: any) => action.sourceType === 'check'))

  const week = (await api('/api/week')).json
  assert.equal(week.foundPence, 2280)
  assert.equal(week.talkedDownPence, 1000)
  assert.ok(week.priceRises.some((rise: any) => rise.item === 'Chicken thighs' && rise.nowPence === 690))

  const csv = (await api('/api/invoices.csv')).json
  assert.match(csv, /Chicken thighs, boneless/)
})

test('a printed sum that does not add up is flagged, not trusted', async () => {
  const { checkInvoiceSums } = await import('../server/setup/documents.ts')
  const result = checkInvoiceSums({
    supplier_id: 1, supplier_name: 'X', invoice_number: '1', invoice_date: '2026-11-02',
    lines: [{ description: 'Onions', item_id: 2, quantity: 10, unit: 'kg', pack_quantity: null, unit_price_pence: 85, line_total_pence: 950, vat_rate: 0 }],
    net_total_pence: 850, vat_total_pence: 0, gross_total_pence: 900, unreadable: ['Line 3 price'],
  })
  assert.equal(result.lineIssues.size, 1)
  assert.equal(result.issues.length, 3)
})

test('a formula in a printed description cannot run in a spreadsheet export', async () => {
  const { insert, nowIso } = await import('../server/core/db.ts')
  const invoice = await insert('INSERT INTO invoices (file, original_name, status, created_at) VALUES (?, ?, ?, ?)', 'x.png', 'x.png', 'read', nowIso())
  await insert(`INSERT INTO invoice_lines (invoice_id, description, qty_billed, unit, unit_price_p, line_total_p, qty_base_milli, price_base_p)
          VALUES (?, ?, 1, 'each', 100, 100, 1000, 100)`, invoice, '=HYPERLINK("http://x")')
  const csv = (await api('/api/invoices.csv')).json
  assert.match(csv, /"'=HYPERLINK/)
})

test('if Muse Spark is down during a call, clear prices still show and the call is saved', async () => {
  mock.state.failSpark = true
  try {
    const created = await api('/api/calls', { body: { supplierId: 1, consent: true, source: 'sample' } })
    const socket = new WebSocket(`${wsBase}/ws/call/${created.json.id}`, { headers: { Cookie: ownerCookie } })
    const events: any[] = []
    socket.on('message', (data) => events.push(JSON.parse(data.toString())))
    await waitFor(async () => events.find((event) => event.type === 'done'), 'failed call', 25000)
    socket.close()
    assert.ok(events.some((event) => event.type === 'card' && event.card.pricePence === 690))
    assert.ok(events.some((event) => event.type === 'warning'))
    assert.equal((await api(`/api/calls/${created.json.id}`)).json.status, 'failed')
    const audio = await fetch(`${base}/api/calls/${created.json.id}/audio`, { headers: { Cookie: ownerCookie } })
    assert.equal(audio.status, 200)
  } finally {
    mock.state.failSpark = false
  }
})

test('a price the model cannot point to in the transcript goes to the owner for review', async () => {
  const { saveDraftOrder } = await import('../server/operations/calls.ts')
  const { all, get, insert, nowIso } = await import('../server/core/db.ts')
  const callId = await insert('INSERT INTO calls (supplier_id, consent_at) VALUES (?, ?)', 1, nowIso())
  const item = (await get("SELECT id FROM items WHERE name = 'Brown onions'"))!
  const orderId = await saveDraftOrder(callId, 1, {
    speaker_roles: [], delivery_date: '2020-01-01', summary: 'x', tasks: [],
    lines: [{ item_id: Number(item.id), quantity: 10, quantity_unit: 'kg', agreed_price_pence: 999, per: 'base', evidence_turn: 1 }],
  }, [{ turnId: 1, startMs: 0, endMs: 1000, transcript: 'Ten kilos of onions, usual price.' }], '2026-11-02')
  const line = (await all('SELECT needs_review, review_note FROM order_lines WHERE order_id = ?', orderId))[0]
  assert.equal(line.needs_review, 1)
  assert.match(String(line.review_note), /Check this price/)
  // A delivery date in the past is refused rather than stored.
  assert.equal((await get('SELECT delivery_date FROM orders WHERE id = ?', orderId))!.delivery_date, null)
})

test('the "deliver 10 kg onions on Thursday" test call becomes an order and a task due Thursday', async () => {
  const original = mock.state.script
  mock.state.script = [{ turn: 1, speaker: 'A', startMs: 500, endMs: 3000, text: 'Please deliver 10 kg onions on Thursday.' }]
  try {
    const { orderId } = await runSampleCall(1)
    const order = (await api(`/api/orders/${orderId}`)).json
    assert.equal(order.lines[0].quantity, 10)
    assert.equal(new Date(`${order.deliveryDate}T12:00:00Z`).getUTCDay(), 4)
    assert.ok(order.tasks.some((task: any) => task.dueDate === order.deliveryDate))
  } finally {
    mock.state.script = original
  }
})

test('a new restaurant: names work on a call, and a call can start the item list', async () => {
  const { loadCatalogue, findItem } = await import('../server/ai/spotter.ts')
  const { saveDraftOrder } = await import('../server/operations/calls.ts')
  const { get, insert, nowIso } = await import('../server/core/db.ts')
  await insert(`INSERT INTO items (name, base_unit) VALUES ('Plum tomatoes, tinned', 'kg')`)
  assert.equal(findItem('how much are the plum tomatoes this week', await loadCatalogue())?.name, 'Plum tomatoes, tinned')

  const supplier = await get('SELECT id FROM suppliers ORDER BY id LIMIT 1')
  const callId = await insert(`INSERT INTO calls (supplier_id, status, source, consent_at, started_at) VALUES (?, 'processing', 'upload', ?, ?)`, supplier!.id, nowIso(), nowIso())
  const orderId = await saveDraftOrder(callId, Number(supplier!.id), {
    speaker_roles: [], delivery_date: null, summary: 'Ordered saffron.', tasks: [],
    lines: [{ item_id: null, new_item_name: 'Saffron threads', quantity: 2, quantity_unit: 'kg', agreed_price_pence: null, per: 'base', evidence_turn: null }],
  }, [], '2026-11-03')
  assert.ok(orderId)
  const line = await get('SELECT i.name FROM order_lines l JOIN items i ON i.id = l.item_id WHERE l.order_id = ?', orderId)
  assert.equal(line!.name, 'Saffron threads')
})
