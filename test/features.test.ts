import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Runs the new features through the real routes, against the stand-in Meta API. */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-features-'))
process.env.DATA_DIR = dataDir
process.env.SAMPLE_DATA = '1'
process.env.MODEL_API_KEY = 'test-key'
process.env.OWNER_PASSCODE = 'owner-code'
process.env.STAFF_PASSCODE = 'staff-code'

const { startMockMeta } = await import('../server/sample/mockMeta.ts')
const mock = await startMockMeta()
process.env.META_BASE_URL = mock.httpBase
process.env.META_REALTIME_URL = mock.wsUrl
const { buildApp } = await import('../server/app.ts')
const { daysAgo } = await import('../server/core/db.ts')

let base = ''
let ownerCookie = ''
let staffCookie = ''
const server = await buildApp()

async function api(url: string, options: { method?: string; body?: unknown; cookie?: string; form?: FormData } = {}) {
  const response = await fetch(`${base}${url}`, {
    method: options.method ?? (options.body || options.form ? 'POST' : 'GET'),
    headers: { ...(options.form ? {} : { 'Content-Type': 'application/json' }), Cookie: options.cookie ?? ownerCookie },
    body: options.form ?? (options.body ? JSON.stringify(options.body) : undefined),
  })
  const text = await response.text()
  let json: any = text
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json }
}

const staff = (url: string, options: { method?: string; body?: unknown; form?: FormData } = {}) => api(url, { ...options, cookie: staffCookie })
const inbox = async () => (await api('/api/home')).json.actions as any[]
const clipForm = () => {
  const form = new FormData()
  form.append('audio', new Blob([fs.readFileSync('public/samples/sample-fridge.wav')], { type: 'audio/wav' }), 'clip.wav')
  return form
}

async function runNamed(name: string) {
  const runs = (await staff('/api/staff/runs')).json
  return (await staff(`/api/staff/runs/${runs.find((row: any) => row.name === name).id}`)).json
}

before(async () => {
  // These tests are about readings and ticks. Pictures have their own tests in setup.test.ts.
  ;await (await import('../server/core/db.ts')).run('UPDATE checklist_items SET proof = 0')
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const login = async (passcode: string) => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })
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

test('daily, weekly and monthly checks appear on their own', async () => {
  const runs = (await staff('/api/staff/runs')).json
  assert.deepEqual([...new Set(runs.map((run: any) => run.frequency))].sort(), ['daily', 'monthly', 'weekly'])
  assert.equal(runs.length, 5)
  // Asking again must not make duplicates.
  assert.equal((await staff('/api/staff/runs')).json.length, 5)
})

test('a spoken reading becomes a proposal, and only a staff confirmation logs it', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const heard = await staff(`/api/staff/runs/${fridge.id}/voice`, { form: clipForm() })
  assert.equal(heard.status, 200)
  assert.equal(heard.json.label, 'Fridge two')
  assert.equal(heard.json.value, 9)
  assert.equal(heard.json.outOfRange, true)
  assert.equal(heard.json.needsCheck, false)

  // Reports need language detection, and short clips shouldn't run speaker labelling.
  const settings = mock.state.clipSettings.at(-1)
  assert.equal(settings.mode, 'PUSH_TO_TALK')
  assert.equal(settings.languageBias, undefined)

  assert.equal((await inbox()).filter((action) => action.sourceType === 'reading').length, 0)
  assert.equal((await runNamed('Fridge and water checks')).items.find((item: any) => item.label === 'Fridge two').entry, null)

  const saved = await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId: heard.json.itemId, value: heard.json.value, source: 'voice', transcript: heard.json.transcript } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.flagged, true)
  const flag = (await inbox()).find((action) => action.sourceType === 'reading')
  assert.equal(flag.urgency, 'now')
  assert.match(flag.title, /Fridge two is at 9°C/)
  assert.equal(flag.href, `#/run/${fridge.id}`)
})

test('correcting a reading back into range clears the flag', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const itemId = fridge.items.find((item: any) => item.label === 'Fridge two').id
  await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId, value: 4, source: 'typed' } })
  assert.equal((await inbox()).filter((action) => action.sourceType === 'reading').length, 0)
  await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId, value: 9, source: 'typed' } })
})

test('a number the speaker never said is marked for a closer look', async () => {
  const { findNumbers } = await import('../server/money/money.ts')
  assert.deepEqual(findNumbers('Fridge two is at nine degrees, freezer minus 18.5'), [2, 9, 18.5])
  const fridge = await runNamed('Fridge and water checks')
  mock.state.clipWords = 'Fridge two is fine'
  const missing = (await staff(`/api/staff/runs/${fridge.id}/voice`, { form: clipForm() })).json
  assert.equal(missing.matched, true)
  mock.state.clipWords = null
})

test('a thermometer photo gives a reading that staff still confirm', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const itemId = fridge.items.find((item: any) => item.label === 'Fridge one').id
  const seen = await staff(`/api/staff/runs/${fridge.id}/sample-photo`, { method: 'POST', body: { itemId } })
  assert.equal(seen.json.value, 9)
  assert.equal(seen.json.outOfRange, true)
  assert.ok(seen.json.photoFile)
  const saved = await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId, value: 3, source: 'photo', photoFile: seen.json.photoFile } })
  assert.equal(saved.json.flagged, false)
  assert.ok(saved.json.run.items.find((item: any) => item.id === itemId).entry.photo)
})

test('a tampered photo name is ignored', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const itemId = fridge.items.find((item: any) => item.label === 'Freezer').id
  const saved = await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId, value: -20, source: 'photo', photoFile: '../../etc/passwd' } })
  assert.equal(saved.json.run.items.find((item: any) => item.id === itemId).entry.photo, null)
})

test('a check from a different list is refused', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const closing = await runNamed('Closing checks')
  assert.equal((await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId: closing.items[0].id } })).status, 400)
})

test('a low stock count reaches the owner', async () => {
  const stock = await runNamed('Weekly stock check')
  const saved = await staff(`/api/staff/runs/${stock.id}/entries`, { body: { itemId: stock.items[0].id, value: 4, source: 'typed' } })
  assert.equal(saved.json.flagged, true)
  assert.ok((await inbox()).some((action) => /Chicken thighs is low/.test(action.title)))
})

test('a spoken Polish report becomes an English task, and the original stays', async () => {
  const filed = await staff('/api/staff/reports/sample', { method: 'POST' })
  assert.equal(filed.status, 201)
  assert.equal(filed.json.crisisKey, 'fridge')
  assert.equal(filed.json.urgency, 'now')
  assert.equal(mock.state.clipSettings.at(-1).languageBias, undefined)

  const report = (await api(`/api/reports/${filed.json.id}`)).json
  assert.equal(report.language, 'Polish')
  assert.match(report.original, /lodówka/)
  assert.match(report.english, /second fridge/)
  assert.ok(report.audio)

  const actions = await inbox()
  const task = actions.find((action) => action.sourceType === 'report')
  assert.equal(task.urgency, 'now')
  assert.equal(task.href, `#/report/${filed.json.id}`)
})

test('a report is kept even when Muse Spark is down', async () => {
  mock.state.failSpark = true
  try {
    const filed = await staff('/api/staff/reports', { body: { text: 'Lodówka nie działa' } })
    assert.equal(filed.status, 201)
    assert.equal(filed.json.translated, false)
    const report = (await api(`/api/reports/${filed.json.id}`)).json
    assert.equal(report.original, 'Lodówka nie działa')
    assert.equal(report.english, null)
  } finally {
    mock.state.failSpark = false
  }
})

test('the inbox lists the most urgent first and a closed item stays closed', async () => {
  const actions = await inbox()
  const ranks = actions.map((action) => ['now', 'today', 'soon'].indexOf(action.urgency))
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b))
  const report = actions.find((action) => action.sourceType === 'report')
  await api(`/api/actions/${report.id}/done`, { method: 'POST' })
  assert.ok(!(await inbox()).some((action) => action.id === report.id))
})

test('food cost matches a hand calculation', async () => {
  const facts = (await api('/api/summary')).json.facts
  // Curries sold 236 and wraps 165 in every 7 days.
  // Curry cost: 0.2 kg thighs + 0.15 kg rice at 195p + 0.05 l cream at 320p + 0.1 kg onions at 85p + 0.02 l oil at 160p.
  // Wrap cost: 0.16 kg thighs + 0.05 kg tomatoes at 210p + 0.03 kg onions at 85p.
  const curry = (thighs: number) => 0.2 * thighs + 0.15 * 195 + 0.05 * 320 + 0.1 * 85 + 0.02 * 160
  const wrap = (thighs: number) => 0.16 * thighs + 0.05 * 210 + 0.03 * 85
  const net = 236 * 950 + 165 * 850
  const cost = (thighs: number) => Math.round(236 * curry(thighs) + 165 * wrap(thighs))

  assert.equal(facts.food_cost.net_sales_pence, net)
  assert.equal(facts.previous_food_cost.net_sales_pence, net)
  assert.equal(facts.previous_food_cost.food_cost_pence, cost(590))
  assert.equal(facts.food_cost.food_cost_pence, cost(640))
  assert.equal(facts.food_cost.food_cost_percent, 17.2)
  assert.equal(facts.previous_food_cost.food_cost_percent, 16.2)
  assert.equal(facts.food_cost_change_points, 1)

  const curryRow = facts.dishes.find((dish: any) => dish.dish === 'Chicken curry')
  assert.equal(curryRow.margin_percent, Math.round((1 - curry(640) / 950) * 1000) / 10)
  assert.equal(curryRow.previous_margin_percent, Math.round((1 - curry(590) / 950) * 1000) / 10)

  // 50p a kilo on (236 × 0.2 + 165 × 0.16) kg.
  const top = facts.price_changes[0]
  assert.equal(top.item, 'Chicken thighs')
  assert.equal(top.extra_cost_on_sales_pence, Math.round((236 * 0.2 + 165 * 0.16) * 50))
})

test('the analyst investigates through tools, then gives a summary with real sources', async () => {
  mock.state.requests.length = 0
  const { json } = await api('/api/summary/run', { method: 'POST' })
  const report = json.report
  assert.equal(report.wordsFrom, 'muse-spark')
  assert.match(report.headline, /17\.2%/)
  assert.match(report.cause, /Harrow Lane Foods/)
  assert.equal(report.actions.length, 3)
  assert.ok(report.steps.includes('Opened the invoices and calls'))
  assert.equal(mock.state.requests.filter((name) => name === 'tool_loop').length, 5)

  const kinds = report.sources.map((source: any) => source.kind)
  assert.ok(kinds.includes('Invoice'))
  assert.ok(kinds.includes('Phone call'))
  assert.ok(report.sources.some((source: any) => /HLF-20377/.test(source.title)))

  const added = await api(`/api/summary/${report.id}/actions/0`, { method: 'POST' })
  assert.equal(added.status, 200)
  assert.ok((await inbox()).some((action) => action.sourceType === 'suggestion'))
  assert.ok((await inbox()).some((action) => action.sourceType === 'summary'))
})

test('a figure no tool produced is refused, and the owner gets the plain summary', async () => {
  mock.state.summaryOverride = {
    headline: 'Food cost hit 31%', summary: 'You lost £999.00 this week.', cause: 'Unknown.',
    actions: [{ title: 'a', why: 'b' }, { title: 'c', why: 'd' }, { title: 'e', why: 'f' }], source_ids: ['invoice:99999'],
  }
  try {
    const { json } = await api('/api/summary/run', { method: 'POST' })
    assert.equal(json.report.wordsFrom, 'template')
    assert.doesNotMatch(json.report.headline, /31%/)
    assert.deepEqual(json.report.sources, [])
  } finally {
    mock.state.summaryOverride = null
  }
})

test('the tool loop survives bad arguments, unknown tools and endless requests', async () => {
  const { sparkTools } = await import('../server/ai/meta.ts')
  const ran: unknown[] = []
  const tool = {
    name: 'get_thing', description: 'x', run: (args: unknown) => { ran.push(args); return { ok: true } },
    parameters: { type: 'object', additionalProperties: false, required: ['from'], properties: { from: { type: 'string' } } },
  }
  const asks = (name: string, args: string) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] })

  mock.state.toolReplies = [asks('get_thing', '{"wrong":1}'), asks('drop_tables', '{}'), asks('get_thing', 'not json'), asks('get_thing', '{"from":"a"}'), { role: 'assistant', content: 'Finished.' }]
  const result = await sparkTools({ system: 's', prompt: 'p', tools: [tool] })
  assert.equal(result.text, 'Finished.')
  assert.deepEqual(result.steps.map((step) => step.ok), [false, false, false, true])
  assert.equal(ran.length, 1)

  mock.state.toolReplies = Array.from({ length: 10 }, () => asks('get_thing', '{"from":"a"}'))
  const capped = await sparkTools({ system: 's', prompt: 'p', tools: [tool], maxRounds: 3 })
  assert.equal(capped.stoppedEarly, true)
  assert.equal(capped.steps.length, 3)

  mock.state.toolReplies = null
})

test('a sales CSV loads good rows and reports bad ones', async () => {
  const csv = [
    'Date,Dish,Quantity,Net Sales',
    `${daysAgo(0)},Chicken curry,10,"£95.00"`,
    '02/11/2026,Grilled chicken wrap,4,34.00',
    'not a date,Chicken curry,1,9.50',
    `${daysAgo(0)},Mystery pie,1,9.50`,
    `${daysAgo(0)},Chicken curry,-1,9.50`,
  ].join('\n')
  const form = new FormData()
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'sales.csv')
  const { json } = await api('/api/sales/import', { form })
  assert.equal(json.imported, 2)
  assert.equal(json.problems.length, 3)

  const again = new FormData()
  again.append('file', new Blob(['just,some,columns\n1,2,3'], { type: 'text/csv' }), 'sales.csv')
  assert.match((await api('/api/sales/import', { form: again })).json.problems[0], /needs date/)
})

test('staff can never reach the owner routes, and their own routes carry no costs', async () => {
  for (const url of ['/api/home', '/api/summary', '/api/reports/1', '/api/sales/template.csv']) {
    assert.equal((await staff(url)).status, 403, url)
  }
  assert.equal((await staff('/api/summary/run', { method: 'POST' })).status, 403)
  assert.equal((await staff('/api/actions/1/done', { method: 'POST' })).status, 403)

  const runs = (await staff('/api/staff/runs')).json
  const views = await Promise.all(runs.map(async (run: any) => (await staff(`/api/staff/runs/${run.id}`)).json))
  assert.doesNotMatch(JSON.stringify([runs, views]), /pence|price|£|cost|margin/i)
})

test('wrong audio is refused before it costs a model call', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const form = new FormData()
  form.append('audio', new Blob([Buffer.alloc(2000)], { type: 'audio/wav' }), 'clip.wav')
  mock.state.requests.length = 0
  assert.equal((await staff(`/api/staff/runs/${fridge.id}/voice`, { form })).status, 400)
  assert.equal(mock.state.requests.length, 0)
})

test('an overdue check is flagged, and clears when the work is done', async () => {
  const { run } = await import('../server/core/db.ts')
  const closing = await runNamed('Closing checks')
  await run('UPDATE checklist_runs SET due_at = ? WHERE id = ?', '2020-01-01T22:00', closing.id)
  const flag = (await inbox()).find((action) => action.href === `#/run/${closing.id}`)
  assert.match(flag.title, /Closing checks are overdue/)
  assert.equal(flag.closable, false)
  assert.equal((await staff('/api/staff/runs')).json.find((row: any) => row.id === closing.id).state, 'overdue')

  for (const item of closing.items) await staff(`/api/staff/runs/${closing.id}/entries`, { body: { itemId: item.id } })
  assert.ok(!(await inbox()).some((action) => action.href === `#/run/${closing.id}`))
})

test('the crisis cards never touch a model and the gas card starts as agreed', async () => {
  const { CRISIS_CARDS } = await import('../server/operations/crisis.ts')
  assert.deepEqual(CRISIS_CARDS.map((card) => card.key).sort(), ['fridge', 'gas', 'power', 'water', 'wifi'])
  const gas = CRISIS_CARDS.find((card) => card.key === 'gas')!
  assert.match(gas.steps[0], /Open windows/)
  assert.match(gas.steps[1], /Turn off the gas at the meter/)
  assert.match(gas.steps[2], /No switches and no flames/)
  assert.match(gas.steps[3], /0800 111 999/)
})

test('the calls list shows each call with its summary and tasks', async () => {
  const calls = (await api('/api/calls')).json
  assert.ok(calls.length >= 1)
  assert.match(calls.at(-1).summary, /chicken thighs/i)
  assert.ok(calls.at(-1).orderId)
  assert.equal((await staff('/api/calls')).status, 403)
})

test('a pile of receipts comes out as rows, and a line that does not add up is flagged', async () => {
  await api('/api/invoices/sample-pile', { method: 'POST' })
  let invoices: any[] = []
  for (let tries = 0; tries < 200; tries += 1) {
    invoices = (await api('/api/invoices')).json
    if (!invoices.some((invoice) => invoice.status === 'reading')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const northgate = invoices.find((invoice) => invoice.number === 'NG-7741')
  assert.equal(northgate.status, 'needs-review')
  assert.match(northgate.lines.find((line: any) => line.description === 'Basmati rice').issue, /doesn't equal/)
  assert.equal(invoices.find((invoice) => invoice.number === 'OD-1183').status, 'read')
  assert.ok(northgate.file)
  const csv = (await api('/api/invoices.csv')).json
  assert.match(csv, /Double cream/)
})

test('the alert feed lists urgent items for the owner only', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const itemId = fridge.items.find((item: any) => item.label === 'Hot water').id
  await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId, value: 30, source: 'typed' } })
  const alerts = (await api('/api/alerts')).json
  assert.ok(alerts.count >= 1)
  assert.ok(alerts.urgent.some((action: any) => /Hot water is at 30/.test(action.title)))
  assert.equal((await staff('/api/alerts')).status, 403)
})

test('signing out clears the session', async () => {
  const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: staffCookie } })
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/)
})

test('the analyst answers a question with a view built from tool results', async () => {
  const { json } = await api('/api/analyst/ask', { body: { question: 'Which dish sells the most?' } })
  assert.match(json.answer, /Chicken curry/)
  const components = json.surface.operations.find((operation: any) => operation.updateComponents).updateComponents.components
  assert.ok(components.some((part: any) => part.component === 'Chart'))
  const table = components.find((part: any) => part.component === 'Table')
  const facts = (await api('/api/summary')).json.facts
  const curry = facts.dishes.find((dish: any) => dish.dish === 'Chicken curry')
  assert.ok(JSON.stringify(table.rows).includes(`${curry.margin_percent}%`))
  assert.equal((await staff('/api/analyst/ask', { body: { question: 'x' } })).status, 403)
})

test('a trend leaves out weeks with no sales, instead of showing them as zero', async () => {
  const { json } = await api('/api/analyst/ask', { body: { question: 'How is food cost going week by week?' } })
  const chart = json.surface.operations.find((operation: any) => operation.updateComponents).updateComponents.components.find((part: any) => part.component === 'Chart')
  assert.ok(chart.data.length >= 4)
  assert.ok(chart.data.every((point: any) => point.value > 0))
})

test('a made-up figure in an answer is dropped', async () => {
  const { allowedFigures, unknownFigures } = await import('../server/ai/analyst.ts')
  assert.deepEqual(unknownFigures('Food cost hit 40%', allowedFigures([{ food_cost_percent: 17.2 }])), ['40'])
})

test('the owner can tick an item off Today and untick it', async () => {
  const fridge = await runNamed('Fridge and water checks')
  const itemId = fridge.items.find((item: any) => item.label === 'Freezer').id
  await staff(`/api/staff/runs/${fridge.id}/entries`, { body: { itemId, value: -2, source: 'typed' } })
  const item = (await inbox()).find((action) => /Freezer is at -2/.test(action.title))
  assert.equal(item.closable, true)
  assert.ok(item.createdAt)

  await api(`/api/actions/${item.id}/done`, { method: 'POST' })
  let home = (await api('/api/home')).json
  assert.ok(!home.actions.some((action: any) => action.id === item.id))
  assert.ok(home.doneToday.some((action: any) => action.id === item.id))

  await api(`/api/actions/${item.id}/done`, { body: { done: false } })
  home = (await api('/api/home')).json
  assert.ok(home.actions.some((action: any) => action.id === item.id))
})

test('a call task can be ticked and unticked', async () => {
  const { insert, nowIso, run } = await import('../server/core/db.ts')
  const callId = await insert('INSERT INTO calls (supplier_id, status, consent_at) VALUES (1, ?, ?)', 'done', nowIso())
  const taskId = await insert('INSERT INTO tasks (call_id, title, due_date) VALUES (?, ?, ?)', callId, 'Ring Dave back', '2030-01-01')
  // A task from a call waits for the owner, then behaves as it always has.
  assert.ok(!(await inbox()).some((action) => action.title === 'Ring Dave back'))
  const waiting = (await api('/api/home')).json.toConfirm.find((action: any) => action.title === 'Ring Dave back')
  await api(`/api/actions/${waiting.id}/confirm`, { method: 'POST' })
  assert.ok((await inbox()).some((action) => action.title === 'Ring Dave back'))
  await api(`/api/tasks/${taskId}/done`, { body: { done: true } })
  assert.ok(!(await inbox()).some((action) => action.title === 'Ring Dave back'))
  await api(`/api/tasks/${taskId}/done`, { body: { done: false } })
  assert.ok((await inbox()).some((action) => action.title === 'Ring Dave back'))
  await run('UPDATE tasks SET done = 1 WHERE id = ?', taskId)
})

test('a tick on a checklist can be taken back, and the list reopens', async () => {
  const opening = await runNamed('Opening checks')
  for (const item of opening.items) await staff(`/api/staff/runs/${opening.id}/entries`, { body: { itemId: item.id } })
  assert.ok((await staff(`/api/staff/runs/${opening.id}`)).json.completedAt)
  const undone = await api(`/api/staff/runs/${opening.id}/entries/${opening.items[0].id}`, { method: 'DELETE' })
  assert.equal(undone.json.run.items[0].entry, null)
  assert.equal(undone.json.run.completedAt, null)
})

test('connection status never reveals a secret', async () => {
  const status = (await api('/api/connections')).json
  assert.equal(status.meta.connected, true)
  assert.equal(status.whatsapp.connected, false)
  assert.doesNotMatch(JSON.stringify(status), /test-key/)
  assert.equal((await staff('/api/connections')).status, 403)
  const meta = (await api('/api/connections/meta/test', { method: 'POST' })).json
  assert.equal(meta.ok, true)
})

test('an urgent item goes out on WhatsApp once, and a failure stays out of the way', async () => {
  const { config } = await import('../server/core/config.ts')
  const { addAction } = await import('../server/operations/actions.ts')
  config.whatsapp = { ...config.whatsapp, baseUrl: mock.httpBase, token: 'wa-token', phoneNumberId: '555', ownerNumber: '441234000000' }
  try {
    mock.state.whatsapp.length = 0
    const first = { sourceType: 'report' as const, sourceId: 777001, urgency: 'now' as const, title: 'Gas smell', detail: 'Kitchen' }
    await addAction(first)
    await addAction(first)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(mock.state.whatsapp.length, 1)
    const sent = mock.state.whatsapp[0]
    assert.equal(sent.url, '/555/messages')
    assert.equal(sent.auth, 'Bearer wa-token')
    assert.equal(sent.body.messaging_product, 'whatsapp')
    assert.equal(sent.body.to, '441234000000')
    assert.match(sent.body.text.body, /Gas smell/)

    await addAction({ ...first, sourceId: 777002, urgency: 'today' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(mock.state.whatsapp.length, 1)

    const status = (await api('/api/connections')).json
    assert.equal(status.whatsapp.connected, true)
    assert.doesNotMatch(JSON.stringify(status), /441234000000|wa-token/)
    assert.equal(status.whatsapp.last.status, 'sent')

    mock.state.failWhatsapp = true
    const test = (await api('/api/connections/whatsapp/test', { method: 'POST' })).json
    assert.equal(test.ok, false)
    assert.doesNotMatch(JSON.stringify(test), /441234000000|wa-token/)
    assert.equal(mock.state.whatsapp.at(-1).body.template.name, 'hello_world')
  } finally {
    mock.state.failWhatsapp = false
    config.whatsapp = { ...config.whatsapp, token: '', phoneNumberId: '', ownerNumber: '' }
  }
})
