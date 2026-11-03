import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStorage } from './standins.ts'

/** Files in Supabase Storage, against a local stand-in for its REST API, through the real routes. */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-storage-'))
const SERVICE_KEY = 'service-key-that-must-stay-secret'
const storage = await startStorage(SERVICE_KEY)

process.env.DATA_DIR = dataDir
process.env.SAMPLE_DATA = '1'
process.env.MODEL_API_KEY = 'test-key'
process.env.OWNER_PASSCODE = 'owner-code'
process.env.STAFF_PASSCODE = 'staff-code'
process.env.SUPABASE_URL = storage.url
process.env.SUPABASE_SERVICE_KEY = SERVICE_KEY
process.env.SUPABASE_BUCKET = 'test-bucket'

const { startMockMeta } = await import('../server/sample/mockMeta.ts')
const mock = await startMockMeta()
process.env.META_BASE_URL = mock.httpBase
process.env.META_REALTIME_URL = mock.wsUrl
const { buildApp } = await import('../server/app.ts')
const files = await import('../server/core/files.ts')
const { backupIfDue, dataStatus } = await import('../server/core/backup.ts')
const { all, get, insert, isPostgres, nowIso, run } = await import('../server/core/db.ts')

const server = await buildApp()
let base = ''
let owner = ''
let staff = ''

const login = async (passcode: string) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })).headers.get('set-cookie')!.split(';')[0]
const api = async (cookie: string, url: string, options: { method?: string; body?: unknown; form?: FormData } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method: options.method ?? (options.body || options.form ? 'POST' : 'GET'), redirect: 'manual',
    headers: { Cookie: cookie, ...(options.form ? {} : { 'Content-Type': 'application/json' }) },
    body: options.form ?? (options.body ? JSON.stringify(options.body) : undefined),
  })
  const text = await response.text()
  let json: any = text
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json, location: response.headers.get('location') }
}
const picture = fs.readFileSync('public/samples/sample-thermometer.png')
const clip = fs.readFileSync('public/samples/sample-delivery.mp4')
const inStorage = (key: string) => storage.state.objects.get(key)

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  owner = await login('owner-code')
  staff = await login('staff-code')
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
  await storage.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** What a browser does with a big file, through the same routes. */
async function direct(cookie: string, name: string, bytes: Buffer) {
  const ticket = (await api(cookie, '/api/uploads/sign', { body: { name, size: bytes.length } })).json
  assert.equal(ticket.direct, true)
  const put = await fetch(ticket.url, { method: 'PUT', headers: { 'Content-Type': ticket.contentType }, body: new Uint8Array(bytes) })
  assert.equal(put.status, 200)
  return ticket
}

test('a saved file goes through to Storage, and a read fetches it back after the cache has gone', async () => {
  await files.writeFile('11111111-1111-1111-1111-111111111111.png', picture)
  const key = 'uploads/11111111-1111-1111-1111-111111111111.png'
  assert.deepEqual(inStorage(key)?.bytes, picture)
  assert.equal(inStorage(key)?.type, 'image/png')

  const local = path.join(dataDir, key)
  fs.rmSync(local)
  storage.state.requests.length = 0
  const found = await files.localFile('11111111-1111-1111-1111-111111111111.png')
  assert.deepEqual(fs.readFileSync(found), picture)
  assert.equal(storage.state.requests.filter((line) => line.startsWith('GET')).length, 1)

  // Now it's cached, so a second read costs nothing.
  storage.state.requests.length = 0
  await files.localFile('11111111-1111-1111-1111-111111111111.png')
  assert.equal(storage.state.requests.length, 0)
})

test('a file that exists nowhere is reported as missing, and removal clears both copies', async () => {
  assert.equal(await files.fileExists('22222222-2222-2222-2222-222222222222.png'), false)
  assert.equal(fs.existsSync(await files.localFile('22222222-2222-2222-2222-222222222222.png')), false)
  await files.writeFile('33333333-3333-3333-3333-333333333333.png', picture)
  await files.removeFile('33333333-3333-3333-3333-333333333333.png')
  assert.equal(inStorage('uploads/33333333-3333-3333-3333-333333333333.png'), undefined)
  assert.equal(await files.fileExists('33333333-3333-3333-3333-333333333333.png'), false)
})

test('names can\'t climb out of the folder or the bucket path', async () => {
  await files.writeFile('../../escape.png', picture)
  assert.ok(inStorage('uploads/escape.png'))
  assert.equal(fs.existsSync(path.join(dataDir, '..', 'escape.png')), false)
})

test('a file in an ordinary form is written through, so another instance can read it', async () => {
  const form = new FormData()
  form.append('files', new Blob([picture], { type: 'image/png' }), 'pile.png')
  const { json } = await api(owner, '/api/invoices', { form })
  const invoice = (await get('SELECT file FROM invoices WHERE id = ?', json.ids[0]))!
  assert.ok(inStorage(`uploads/${invoice.file}`))
})

test('a big file goes straight to Storage, and the route gets the same file object', async () => {
  const fridge = (await api(staff, '/api/staff/runs')).json.find((row: any) => row.name === 'Fridge and water checks')
  const item = (await api(staff, `/api/staff/runs/${fridge.id}`)).json.items[0]
  const big = await direct(staff, 'clip.mp4', clip)
  assert.ok(inStorage(`uploads/${big.path}`), 'the bytes never passed through the server')

  const form = new FormData()
  form.append('frames', new Blob([picture], { type: 'image/png' }), 'frame-0.png')
  form.append('storedFiles', JSON.stringify([{ field: 'video', path: big.path, name: 'clip.mp4' }]))
  form.append('itemId', String(item.id))
  form.append('seconds', '4')
  const checked = await api(staff, `/api/staff/runs/${fridge.id}/proof`, { form })
  assert.equal(checked.status, 200)
  assert.equal(checked.json.video, big.path)
  assert.equal(checked.json.verdict, 'ok')
})

test('SAM gets a short-lived link instead of the whole video, and frames are still counted from the file', async () => {
  mock.state.videoUrls.length = 0
  const made = await api(owner, '/api/orders', { body: { supplierId: (await api(owner, '/api/suppliers')).json[0].id, deliveryDate: '2099-01-01', lines: [{ name: 'Linked boxes', quantity: 30, unit: 'kg' }] } })
  const order = (await api(staff, `/api/staff/deliveries/${made.json.id}`)).json
  const big = await direct(staff, 'delivery.mp4', clip)
  const form = new FormData()
  form.append('frames', new Blob([picture], { type: 'image/png' }), 'frame-0.png')
  form.append('storedFiles', JSON.stringify([{ field: 'video', path: big.path, name: 'delivery.mp4' }]))
  Object.entries({ itemId: String(order.lines[0].itemId), what: 'box', seconds: '4', addedBy: 'Maria' }).forEach(([key, value]) => form.append(key, value))
  const counted = await api(staff, `/api/staff/deliveries/${made.json.id}/count`, { form })
  assert.equal(counted.status, 201)
  assert.equal(counted.json.count, 4)
  assert.equal(counted.json.track.path.at(-1).t, 3.93, 'the 60 frames in the file set the timing')
  assert.match(mock.state.videoUrls[0], new RegExp(`^${storage.url}/storage/v1/object/sign/test-bucket/uploads/${big.path}\\?token=`))
  assert.ok(!mock.state.videoUrls.some((url: string) => url.startsWith('data:')))
})

test('a stored path works once, for the role it was issued to, and only while its ticket is fresh', async () => {
  const fridge = (await api(staff, '/api/staff/runs')).json.find((row: any) => row.name === 'Opening checks')
  const item = (await api(staff, `/api/staff/runs/${fridge.id}`)).json.items[0]
  const attempt = (cookie: string, stored: string) => {
    const form = new FormData()
    form.append('storedFiles', JSON.stringify([{ field: 'frames', path: stored, name: 'frame.png' }]))
    form.append('itemId', String(item.id))
    return api(cookie, `/api/staff/runs/${fridge.id}/proof`, { form })
  }
  const invoice = await direct(owner, 'invoice.png', picture)
  assert.equal((await attempt(staff, invoice.path)).status, 400, 'an owner upload can not be claimed by staff')

  const mine = await direct(staff, 'photo.png', picture)
  assert.equal((await attempt(staff, mine.path)).status, 200)
  assert.equal((await attempt(staff, mine.path)).status, 400, 'a ticket works once')

  const stale = await direct(staff, 'old.png', picture)
  await run('UPDATE uploads SET created_at = ? WHERE name = ?', '2020-01-01T00:00:00.000Z', stale.path)
  assert.equal((await attempt(staff, stale.path)).status, 400, 'a ticket runs out')

  assert.equal((await attempt(staff, '../../etc/passwd')).status, 400)
})

test('only allowed kinds of file get a link, and the file size is checked after it arrives', async () => {
  assert.equal((await api(staff, '/api/uploads/sign', { body: { name: 'run-me.exe', size: 10 } })).status, 400)
  assert.equal((await api(staff, '/api/uploads/sign', { body: { name: 'huge.mp4', size: 500 * 1024 * 1024 } })).status, 400)
  assert.equal((await api('', '/api/uploads/sign', { body: { name: 'a.png', size: 10 } })).status, 401)

  const oversized = await direct(owner, 'big.png', Buffer.alloc(16 * 1024 * 1024))
  const form = new FormData()
  form.append('storedFiles', JSON.stringify([{ field: 'files', path: oversized.path, name: 'big.png' }]))
  const refused = await api(owner, '/api/invoices', { form })
  assert.equal(refused.status, 400)
  assert.equal(refused.json.error, 'That file is too large.')
  assert.equal(inStorage(`uploads/${oversized.path}`), undefined)
})

test('a recording goes through the same helper and lands where recordings live', async () => {
  const wav = fs.readFileSync('public/samples/sample-call.wav')
  const big = await direct(owner, 'recording.wav', wav)
  const form = new FormData()
  form.append('supplierId', String((await api(owner, '/api/suppliers')).json[0].id))
  form.append('consent', 'true')
  form.append('storedFiles', JSON.stringify([{ field: 'audio', path: big.path, name: 'recording.wav' }]))
  const { status, json } = await api(owner, '/api/calls/upload', { form })
  assert.equal(status, 202)
  assert.deepEqual(inStorage(`calls/${json.id}.wav`)?.bytes, wav)
  assert.equal(inStorage(`uploads/${big.path}`), undefined)
  for (let wait = 0; wait < 100 && (await api(owner, `/api/calls/${json.id}`)).json.status === 'processing'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await api(owner, `/api/calls/${json.id}`)).json.status, 'done')
})

test('files reach a browser by a short link, and the link supports the range requests video needs', async () => {
  const name = '44444444-4444-4444-4444-444444444444.mp4'
  await files.writeFile(name, clip)
  await insert(`INSERT INTO delivery_media (order_id, file, video_file, created_at) VALUES ((SELECT MIN(id) FROM orders), ?, ?, ?)`, 'frame.png', name, nowIso())
  const sent = await fetch(`${base}/api/staff/delivery-media/${name}`, { headers: { Cookie: staff }, redirect: 'manual' })
  assert.equal(sent.status, 302)
  assert.equal(sent.headers.get('cache-control'), 'private, no-store')
  const link = sent.headers.get('location')!
  assert.doesNotMatch(link, new RegExp(SERVICE_KEY))
  const part = await fetch(link, { headers: { Range: 'bytes=0-99' } })
  assert.equal(part.status, 206)
  assert.equal((await part.arrayBuffer()).byteLength, 100)
  assert.equal((await fetch(`${base}/api/staff/delivery-media/${name}`, { redirect: 'manual' })).status, 401)
})

test('staff can open pictures from their own checks, and never an invoice or a recording', async () => {
  const invoice = (await all('SELECT file FROM invoices WHERE file IS NOT NULL'))[0]
  assert.equal((await api(staff, `/api/files/${invoice.file}`)).status, 403)
  assert.equal((await api(owner, `/api/files/${invoice.file}`)).status, 302)
  assert.equal((await api('', `/api/files/${invoice.file}`)).status, 401)
  assert.equal((await api(staff, '/api/calls/1/audio')).status, 403)

  const proof = (await get('SELECT file FROM proof_checks LIMIT 1'))!
  assert.equal((await api(staff, `/api/files/${proof.file}`)).status, 302)
  assert.equal((await api(owner, '/api/files/00000000-0000-0000-0000-000000000000.png')).status, 404)
})

test('the service key never reaches a browser or a log', async () => {
  storage.state.seenKeys.clear()
  const lines: string[] = []
  const original = console.error
  console.error = (...words: unknown[]) => { lines.push(words.join(' ')) }
  try {
    const saved = config.supabase.bucket
    config.supabase.bucket = 'broken/route'
    await files.writeFile('55555555-5555-5555-5555-555555555555.png', picture).catch((error) => lines.push(String(error.message)))
    config.supabase.bucket = saved
    const pages = await Promise.all(['/api/connections', '/api/setup', '/api/home'].map((url) => api(owner, url)))
    assert.doesNotMatch(JSON.stringify(pages) + lines.join(' '), new RegExp(SERVICE_KEY))
  } finally {
    console.error = original
  }
})

test('the daily copy lands in Storage on Postgres and a week is kept, and SQLite keeps its file', async () => {
  assert.equal(await backupIfDue(), true)
  assert.equal(await backupIfDue(), false)
  const status = await dataStatus()
  assert.equal(status.backups, 1)
  assert.ok(status.lastBackup)
  const names = [...storage.state.objects.keys()].filter((key) => key.startsWith('backups/'))
  if (!isPostgres()) return assert.deepEqual(names, [])

  assert.equal(names.length, 1)
  const saved = JSON.parse(storage.state.objects.get(names[0])!.bytes.toString())
  assert.ok(saved.exportedAt)
  assert.ok(saved.tables.suppliers.length > 0)
  assert.ok(saved.tables.invoices.length > 0)
  assert.ok('checklist_runs' in saved.tables)
  assert.equal(JSON.stringify(saved).includes('google_refresh_token'), false)

  for (let day = 1; day <= 9; day += 1) storage.state.objects.set(`backups/stockpot-2020-01-0${day}.json`, { bytes: Buffer.from('{}'), type: 'application/json' })
  storage.state.objects.delete(names[0])
  await run(`DELETE FROM settings WHERE key LIKE 'claim:backup:%'`)
  assert.equal(await backupIfDue(), true)
  const kept = [...storage.state.objects.keys()].filter((key) => key.startsWith('backups/')).sort()
  assert.equal(kept.length, 7)
  assert.ok(kept.includes(names[0]))
  assert.ok(!kept.includes('backups/stockpot-2020-01-01.json'))
})

test('a backup is only made once when two passes run together', { skip: !isPostgres() }, async () => {
  await run(`DELETE FROM settings WHERE key LIKE 'claim:backup:%'`)
  for (const key of storage.state.objects.keys()) if (key.startsWith('backups/')) storage.state.objects.delete(key)
  const done = await Promise.all([backupIfDue(), backupIfDue(), backupIfDue()])
  assert.equal(done.filter(Boolean).length, 1)
})

const { config } = await import('../server/core/config.ts')

test('a newer Supabase secret key travels in apikey alone', async () => {
  const { storageHeaders } = await import('../server/core/files.ts')
  assert.deepEqual(storageHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' })
  assert.deepEqual(storageHeaders('eyJabc'), { Authorization: 'Bearer eyJabc', apikey: 'eyJabc' })
})

test('a recipe file and a dish photo live in Storage, and a read needs only the instance that gets the request', async () => {
  const dishes = (await api(owner, '/api/setup/dishes')).json
  const dish = dishes.find((row: any) => row.name === 'Chicken curry')
  const pdf = fs.readFileSync('public/samples/sample-recipe.pdf')
  const form = new FormData()
  form.append('recipe', new Blob([pdf]), 'sample-recipe.pdf')
  form.append('photo', new Blob([fs.readFileSync('public/samples/sample-dish.png')]), 'sample-dish.png')
  const saved = await api(owner, `/api/setup/dishes/${dish.id}/files`, { form })
  assert.equal(saved.status, 200)
  assert.ok(storage.state.objects.has(`uploads/${saved.json.recipeFile}`))
  assert.ok(storage.state.objects.has(`uploads/${saved.json.photo}`))

  // A new instance has an empty temp folder, so the file has to come back from Storage.
  fs.rmSync(path.join(dataDir, 'uploads', saved.json.recipeFile))
  const again = await api(owner, `/api/setup/dishes/${dish.id}/read-again`, { method: 'POST' })
  assert.equal(again.status, 200)
  assert.equal(again.json.recipe.name, 'Lamb kofta')

  const redirected = await api(staff, `/api/staff/recipe-photo/${saved.json.photo}`)
  assert.equal(redirected.status, 302)
  assert.equal((await api(staff, `/api/files/${saved.json.recipeFile}`)).status, 403)
})

test('a big Word file or workbook can go straight to Storage, and the upload is gone after a read', async () => {
  const docx = fs.readFileSync('public/samples/datasets/2026-08/recipes-book.docx')
  const ticket = (await api(owner, '/api/uploads/sign', { body: { name: 'recipes-book.docx', size: docx.length } })).json
  assert.equal(ticket.direct, true)
  assert.equal(ticket.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal((await fetch(ticket.url, { method: 'PUT', headers: { 'Content-Type': ticket.contentType }, body: docx })).status, 200)
  const form = new FormData()
  form.append('kind', 'recipes')
  form.append('storedFiles', JSON.stringify([{ field: 'file', path: ticket.path, name: 'recipes-book.docx' }]))
  const read = await api(owner, '/api/ingest/read', { form })
  assert.equal(read.status, 200)
  assert.deepEqual(read.json.recipes.map((recipe: any) => recipe.name), ['Chicken curry', 'Grilled chicken wrap'])
  assert.ok(!storage.state.objects.has(`uploads/${ticket.path}`))

  // Staff can ask for a link, but the file can't then be used on an owner's route.
  const staffTicket = (await api(staff, '/api/uploads/sign', { body: { name: 'a.xlsx', size: 10 } })).json
  assert.equal(staffTicket.direct, true)
  const bad = new FormData()
  bad.append('kind', 'sales')
  bad.append('storedFiles', JSON.stringify([{ field: 'file', path: staffTicket.path, name: 'a.xlsx' }]))
  assert.equal((await api(owner, '/api/ingest/read', { form: bad })).status, 400)
})
