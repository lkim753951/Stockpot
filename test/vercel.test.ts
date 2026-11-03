import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { startInstance, startStorage } from './standins.ts'

/**
 * The hosted entry point, imported the way Vercel loads it and sent real HTTP requests. It runs in
 * sample mode in the sample schema, with no Meta key, and a second instance shares only the database and Storage.
 * Vercel needs Postgres, so most of this only runs under npm run test:postgres.
 */

const postgres = !!process.env.DATABASE_URL
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-vercel-'))
const storage = await startStorage('service-key')

const hosted = {
  VERCEL: '1', NODE_ENV: 'production', TMPDIR: temp, DB_SCHEMA: 'sample',
  SUPABASE_URL: storage.url, SUPABASE_SERVICE_KEY: 'service-key', SUPABASE_BUCKET: 'sample-files',
  MODEL_API_KEY: '', OWNER_PASSCODE: '', STAFF_PASSCODE: '', SESSION_SECRET: '', CRON_SECRET: 'cron', REPLAY_SPEED: '40',
}

/** The hosted rules, checked in a process of their own, because they read the settings at start. */
async function startsWith(env: Record<string, string>) {
  const script = `const { assertSafeToStart } = await import('./server/config.ts'); assertSafeToStart(); console.log('started')`
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, NODE_TEST_CONTEXT: undefined, ...env } as NodeJS.ProcessEnv })
    return stdout.trim()
  } catch (error) {
    return String((error as Error).message).split('\n').find((line) => line.startsWith('Error:')) ?? 'failed'
  }
}

test('the real site will not start without its passcodes, its secret and its data', async () => {
  const real = { VERCEL: '1', NODE_ENV: 'production', MODEL_API_KEY: 'key', OWNER_PASSCODE: 'o', STAFF_PASSCODE: 's', SESSION_SECRET: 'x', DATABASE_URL: 'postgres://u@h/d', SUPABASE_URL: 'http://s', SUPABASE_SERVICE_KEY: 'k' }
  assert.equal(await startsWith(real), 'started')
  assert.match(await startsWith({ ...real, OWNER_PASSCODE: '' }), /OWNER_PASSCODE is required/)
  assert.match(await startsWith({ ...real, STAFF_PASSCODE: '' }), /STAFF_PASSCODE is required/)
  assert.match(await startsWith({ ...real, SESSION_SECRET: '' }), /SESSION_SECRET is required/)
  assert.match(await startsWith({ ...real, DATABASE_URL: '' }), /DATABASE_URL is required/)
  assert.match(await startsWith({ ...real, SUPABASE_SERVICE_KEY: '' }), /SUPABASE_URL and SUPABASE_SERVICE_KEY are required/)
})

test('a site with no key can only run on the sample schema, so it can never clear the real tables', async () => {
  const site = { VERCEL: '1', NODE_ENV: 'production', DATABASE_URL: 'postgres://u@h/d', SUPABASE_URL: 'http://s', SUPABASE_SERVICE_KEY: 'k' }
  assert.match(await startsWith(site), /Set DB_SCHEMA=sample/)
  assert.match(await startsWith({ ...site, DB_SCHEMA: 'public' }), /Set DB_SCHEMA=sample/)
  assert.equal(await startsWith({ ...site, DB_SCHEMA: 'sample' }), 'started')
  assert.match(await startsWith({ ...site, DB_SCHEMA: 'sample"; DROP' }), /DB_SCHEMA can only use/)
})

test('a sample with no database starts on Vercel, and a real site with no database still will not', async () => {
  assert.equal(await startsWith({ VERCEL: '1', NODE_ENV: 'production' }), 'started')
  assert.match(await startsWith({ VERCEL: '1', NODE_ENV: 'production', MODEL_API_KEY: 'key', OWNER_PASSCODE: 'o', STAFF_PASSCODE: 's', SESSION_SECRET: 'x' }), /DATABASE_URL is required/)
})

test('a sample with no database works from the hosted entry point', async () => {
  const site = await startInstance({ VERCEL: '1', NODE_ENV: 'production', STOCKPOT_ENTRY: 'api', TMPDIR: fs.mkdtempSync(path.join(temp, 'throwaway-')), DATABASE_URL: '', DB_SCHEMA: '', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_BUCKET: '', MODEL_API_KEY: '', OWNER_PASSCODE: '', STAFF_PASSCODE: '', SESSION_SECRET: '' })
  try {
    const session = await json(site.base, '/api/session')
    assert.equal(session.status, 200)
    assert.equal(session.data.mode, 'sample')
    const home = await json(site.base, '/api/home')
    assert.equal(home.status, 200)
    assert.ok(home.data.toConfirm)
    const suppliers = await json(site.base, '/api/suppliers')
    assert.ok(suppliers.data.length > 0)
    const words = await json(site.base, '/api/uploads/sign', 'POST', { name: 'a.jpg', size: 10 })
    assert.equal(words.status, 200)
    assert.equal(words.data.direct, false)
  } finally {
    site.child.removeAllListeners('exit')
    site.kill()
  }
})

test('a Mac needs none of it', async () => {
  assert.equal(await startsWith({}), 'started')
})

test('vercel.json sends every kind of address to the right place', () => {
  const settings = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))
  const route = (url: string) => {
    for (const { source, destination } of settings.rewrites) {
      const pattern = source.replace(/\/:path\*/, '(/.*)?')
      if (new RegExp(`^${pattern}$`).test(url)) return destination
    }
    return null
  }
  for (const url of ['/api/home', '/api/cron', '/api/whatsapp/webhook', '/ws/call/12', '/healthz', '/whatsapp/webhook']) assert.equal(route(url), '/api/index', url)
  for (const url of ['/', '/anything', '/receipts']) assert.equal(route(url), '/index.html', url)
  assert.equal(settings.outputDirectory, 'dist')
  assert.deepEqual(settings.regions, ['lhr1'])
  const fn = settings.functions['api/index.ts']
  assert.equal(fn.maxDuration, 300)
  assert.match(fn.includeFiles, /public\/samples/)
  assert.match(fn.includeFiles, /shared\/words/)
})

let server: import('node:http').Server | undefined
let base = ''
let wsBase = ''
let other: Awaited<ReturnType<typeof startInstance>> | undefined

const json = async (at: string, url: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${at}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: url === '/api/cron' ? 'Bearer cron' : '' }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, data: await response.json().catch(() => null) as any }
}

before(async () => {
  if (!postgres) return
  Object.assign(process.env, hosted)
  // A plain import and a health check must do no database work, so a database outage can't hide behind them.
  const sick = await startInstanceFor({ ...hosted, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' })
  const health = await fetch(`${sick.base}/healthz`)
  assert.deepEqual(await health.json(), { ok: true })
  sick.child.removeAllListeners('exit')
  sick.kill()

  server = (await import('../api/index.ts')).default
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  base = `http://127.0.0.1:${port}`
  wsBase = `ws://127.0.0.1:${port}`
  await json(base, '/api/session')
  other = await startInstanceFor(hosted)
})

/** A server from the hosted entry point, in its own process. */
function startInstanceFor(env: Record<string, string>) {
  return startInstance({ ...env, STOCKPOT_ENTRY: 'api' })
}

after(async () => {
  other?.child.removeAllListeners('exit')
  other?.kill()
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
  }
  await storage.close()
  fs.rmSync(temp, { recursive: true, force: true })
})

test('the default export is a server, and it answers with no key, in sample mode', { skip: !postgres }, async () => {
  const session = (await json(base, '/api/session')).data
  assert.equal(session.mode, 'sample')
  assert.equal(session.role, 'owner')
  assert.equal((await json(base, '/api/home')).status, 200)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal((await fetch(`${base}/`)).status, 404, 'the screens are served by Vercel, not the function')
})

test('sample data is in the sample schema, and files are in Storage', { skip: !postgres }, async () => {
  const { all } = await import('../server/db.ts')
  assert.ok((await all('SELECT id FROM suppliers')).length >= 3)
  const pg = (await import('pg')).default
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const where = await client.query(`SELECT table_schema FROM information_schema.tables WHERE table_name = 'suppliers'`)
  await client.end()
  assert.deepEqual(where.rows.map((row) => row.table_schema), ['sample'])
  assert.ok([...storage.state.objects.keys()].some((key) => key.startsWith('uploads/')))
})

test('sample mode works when requests land on different instances', { skip: !postgres }, async () => {
  assert.equal((await json(base, '/api/sample/clock', 'POST', { time: '21:15' })).status, 200)
  assert.equal((await json(other!.base, '/api/session')).data.demoTime.slice(0, 2), '21')
  assert.equal((await json(other!.base, '/api/sample/clock', 'POST', { time: '09:05' })).status, 200)
  assert.equal((await json(base, '/api/session')).data.demoTime.slice(0, 2), '09')

  // A file made on one instance opens on the other, and the sample reading goes round the same way.
  const made = await json(base, '/api/invoices/sample', 'POST')
  assert.equal(made.status, 202)
  let invoice: any
  for (let wait = 0; wait < 200; wait += 1) {
    invoice = (await json(other!.base, '/api/invoices')).data.find((row: any) => row.id === made.data.ids[0])
    if (invoice?.status !== 'reading') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.notEqual(invoice.status, 'reading')
  const link = await fetch(`${other!.base}/api/files/${invoice.file}`, { redirect: 'manual' })
  assert.equal(link.status, 302)
  assert.equal((await fetch(link.headers.get('location')!)).status, 200)
})

test('the sample call runs over a socket through the hosted entry point', { skip: !postgres }, async () => {
  const supplier = (await json(base, '/api/suppliers')).data[0]
  const call = await json(base, '/api/calls', 'POST', { supplierId: supplier.id, consent: true, source: 'sample' })
  const socket = new WebSocket(`${wsBase}/ws/call/${call.data.id}`)
  const events: any[] = []
  socket.on('message', (data) => events.push(JSON.parse(data.toString())))
  for (let wait = 0; wait < 800 && !events.some((event) => event.type === 'done'); wait += 1) await new Promise((resolve) => setTimeout(resolve, 25))
  socket.close()
  assert.ok(events.some((event) => event.type === 'done'), `events: ${events.map((event) => event.type).join(',')}`)
  assert.ok(events.some((event) => event.type === 'card'))
  assert.ok(storage.state.objects.has(`calls/${call.data.id}.wav`), 'the recording is in Storage')
  const audio = await fetch(`${other!.base}/api/calls/${call.data.id}/audio`, { redirect: 'manual' })
  assert.equal(audio.status, 302)
})

test('a sample upload never gets a Storage link, and a public visitor can\'t fill the bucket', { skip: !postgres }, async () => {
  assert.deepEqual((await json(base, '/api/uploads/sign', 'POST', { name: 'a.png', size: 10 })).data, { direct: false })
})

test('Start again works in sample mode, from any instance, and the seed is safe to repeat', { skip: !postgres }, async () => {
  const reset = await Promise.all([json(base, '/api/sample/reset', 'POST'), json(other!.base, '/api/sample/reset', 'POST')])
  for (const { status } of reset) assert.equal(status, 200)
  const suppliers = (await json(other!.base, '/api/suppliers')).data
  assert.equal(suppliers.length, 3)
})

test('the hosted scheduler stays off, and /api/cron does the work', { skip: !postgres }, async () => {
  const { startScheduler } = await import('../server/scheduler.ts')
  startScheduler()
  const pass = await json(base, '/api/cron', 'POST')
  assert.equal(pass.status, 200)
  assert.equal(Object.values(pass.data.results).includes('failed'), false, JSON.stringify(pass.data.results))
})

test('staff added on one instance reach every other, and nothing is written to a file', { skip: !postgres }, async () => {
  const added = await json(base, '/api/team/people', 'POST', { name: 'Ana', number: '+44 7700 900123', language: 'ro' })
  assert.equal(added.status, 201)
  const seen = (await json(other!.base, '/api/setup')).data
  assert.ok(seen.people.some((person: any) => person.name === 'Ana'))
  assert.doesNotMatch(JSON.stringify(seen), /447700900123/)
  await json(other!.base, '/api/team/people/Ana', 'DELETE')
  assert.ok(!(await json(base, '/api/setup')).data.people.some((person: any) => person.name === 'Ana'))
  assert.equal((await json(base, '/api/connections/save', 'POST', { WHATSAPP_TOKEN: 'x' })).status, 400)
})
