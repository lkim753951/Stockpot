// Puts Stockpot on Vercel and Supabase. Run it through put-stockpot-online.command, which asks for the keys first.
// Safe to run again: it keeps its secrets, overwrites settings and deploys both sites once more.
// It prints no key, passcode or phone number. Values reach Vercel over stdin, never on a command line.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { storageHeaders } from '../server/files.ts'

const VERCEL = (process.env.VERCEL_BIN ?? 'npx --yes vercel@65.10.0').split(' ')
const HOSTING_FILE = '.env.hosting'
const REGIONS = ['lhr1', 'dub1', 'cdg1', 'fra1', 'iad1']
const REAL_PROJECT = 'stockpot'
const SAMPLE_PROJECT = 'stockpot-sample'
const REAL_BUCKET = 'stockpot'
const SAMPLE_BUCKET = 'stockpot-sample'

/** Only these go from .env on this Mac to the real site. */
const COPIED = ['MODEL_API_KEY', 'MAX_MODEL_CALLS', 'RESTAURANT_TIMEZONE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'OWNER_PHONE',
  'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_OWNER_NUMBER', 'WHATSAPP_BUSINESS_NUMBER', 'WHATSAPP_STAFF_NUMBERS', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']

const say = (text: string) => console.log(text)
function stop(text: string): never {
  say(`\nStopped: ${text}`)
  say('Fix that and double-click put-stockpot-online.command again. Nothing is lost.')
  process.exit(1)
}

function readEnv(file: string) {
  const values: Record<string, string> = {}
  if (!fs.existsSync(file)) return values
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match?.[2]) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

function remember(name: string, value: string) {
  const kept = fs.readFileSync(HOSTING_FILE, 'utf8').split('\n').filter((line) => line && !line.startsWith(`${name}=`))
  fs.writeFileSync(HOSTING_FILE, `${[...kept, `${name}=${value}`].join('\n')}\n`, { mode: 0o600 })
}

const hosting = readEnv(HOSTING_FILE)
const local = readEnv('.env')

function secret(name: string) {
  hosting[name] ||= crypto.randomBytes(32).toString('hex')
  remember(name, hosting[name])
  return hosting[name]
}

function vercel(args: string[], options: { input?: string, capture?: boolean } = {}) {
  const [command, ...before] = VERCEL
  // A captured command gets an empty stdin, so it fails instead of waiting on a prompt nobody can see.
  const input = options.input ?? (options.capture ? '' : undefined)
  const result = spawnSync(command, [...before, ...args], {
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit'],
  })
  return { ok: result.status === 0, text: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, out: result.stdout ?? '' }
}

/** The project reference is the part after "postgres." in a pooled address. */
function projectUrl(address: string) {
  let parsed: URL
  try { parsed = new URL(address) } catch { stop("That Supabase address doesn't look right. It should start with postgresql://") }
  if (parsed.port !== '6543') stop('Use the Transaction pooler address from Supabase. It has port 6543.')
  const reference = decodeURIComponent(parsed.username).split('.')[1]
  if (!reference) stop('Use the Transaction pooler address from Supabase. Its user name is postgres. followed by your project reference.')
  return `https://${reference}.supabase.co`
}

function database(address: string) {
  const url = new URL(address)
  const local = ['localhost', '127.0.0.1'].includes(url.hostname)
  url.searchParams.delete('sslmode')
  return new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 })
}

async function checkDatabase(address: string) {
  const client = database(address)
  try {
    await client.connect()
    await client.query('select 1')
  } catch (error) {
    stop(`Supabase refused the database connection (${(error as Error).message.slice(0, 120)}). Check the password in the address.`)
  } finally {
    await client.end().catch(() => {})
  }
}

async function makeBucket(url: string, key: string, bucket: string) {
  const headers = { ...storageHeaders(key), 'Content-Type': 'application/json' }
  const made = await fetch(`${url}/storage/v1/bucket`, { method: 'POST', headers, body: JSON.stringify({ id: bucket, name: bucket, public: false }) })
  if (made.ok) return
  const text = await made.text()
  if (!/exist|duplicate/i.test(text)) stop(`Supabase refused to create the ${bucket} bucket (${made.status}). Check the secret key.`)
}

async function checkStorage(url: string, key: string, bucket: string) {
  const headers = storageHeaders(key)
  const route = `${url}/storage/v1/object/${bucket}/setup-check.txt`
  const put = await fetch(route, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain', 'x-upsert': 'true' }, body: 'stockpot' })
  if (!put.ok) stop(`Supabase Storage refused a test file (${put.status}). Check the secret key.`)
  const read = await fetch(route, { headers })
  if (!read.ok || await read.text() !== 'stockpot') stop(`Supabase Storage didn't give the test file back (${read.status}).`)
  await fetch(route, { method: 'DELETE', headers })
}

function setRegion(region: string) {
  const settings = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))
  settings.regions = [region]
  fs.writeFileSync('vercel.json', `${JSON.stringify(settings, null, 2)}\n`)
}

function linkProject(name: string) {
  fs.rmSync('.vercel', { recursive: true, force: true })
  vercel(['project', 'add', name], { capture: true })
  if (!vercel(['link', '--yes', '--project', name], { capture: true }).ok) stop(`Vercel couldn't link the ${name} project.`)
}

function setVariables(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const added = vercel(['env', 'add', name, '--environment', 'production', '--force', '--yes', '--sensitive'], { input: value, capture: true })
    if (!added.ok) stop(`Vercel refused the setting ${name}.`)
  }
}

function deploy(name: string) {
  say(`  Building ${name} on Vercel. This takes a minute or two.`)
  const done = vercel(['deploy', '--prod', '--yes'], { capture: true })
  const deployment = done.out.match(/https:\/\/[^\s]+\.vercel\.app/g)?.at(-1)
  if (!done.ok || !deployment) { say(done.text.slice(-1500)); stop(`Vercel couldn't build ${name}.`) }
  const details = vercel(['inspect', deployment], { capture: true }).text
  const addresses = [...new Set(details.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g) ?? [])].filter((address) => address !== deployment)
  return addresses.sort((a, b) => a.length - b.length)[0] ?? `https://${name}.vercel.app`
}

async function waitUntilUp(address: string) {
  for (let turn = 0; turn < 30; turn += 1) {
    const reply = await fetch(`${address}/healthz`).catch(() => null)
    if (reply?.ok) return
    if (reply?.status === 401 || reply?.status === 403) stop(`${address} is behind Vercel's Deployment Protection. Turn it off for production in the project's settings.`)
    await new Promise((done) => setTimeout(done, 2000))
  }
  stop(`${address}/healthz didn't answer. Open the project's logs on Vercel.`)
}

async function testMeta(address: string, passcode: string) {
  const login = await fetch(`${address}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!login.ok || !cookie) return { ok: false, detail: `Sign-in failed with ${login.status}.` }
  const reply = await fetch(`${address}/api/connections/meta/test`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' } })
  const body = await reply.json().catch(() => null) as { ok?: boolean, detail?: string } | null
  return { ok: !!body?.ok, detail: body?.detail ?? `Test Meta answered ${reply.status}.` }
}

/** Meta can refuse a cloud region, so Stockpot moves until it answers. */
async function reachMeta(address: string, passcode: string) {
  const start = JSON.parse(fs.readFileSync('vercel.json', 'utf8')).regions?.[0] ?? REGIONS[0]
  const order = [start, ...REGIONS.filter((region) => region !== start)]
  for (const [index, region] of order.entries()) {
    if (index) {
      say(`  Meta refused the last region. Moving the real site to ${region}.`)
      setRegion(region)
      deploy(REAL_PROJECT)
      await waitUntilUp(address)
    }
    const result = await testMeta(address, passcode)
    say(`  ${region}: ${result.detail}`)
    if (result.ok) return region
  }
  return null
}

async function setUpCron(address: string, databaseUrl: string, cronSecret: string) {
  const client = database(databaseUrl)
  const job = `select net.http_post(url := '${address}/api/cron', headers := jsonb_build_object('Authorization', 'Bearer ${cronSecret}'), timeout_milliseconds := 290000);`
  try {
    await client.connect()
    await client.query('create extension if not exists pg_cron with schema pg_catalog')
    await client.query('create extension if not exists pg_net with schema extensions')
    await client.query(`select cron.schedule('stockpot-pass', '*/5 * * * *', $$ ${job} $$)`)
    return true
  } catch (error) {
    say(`  Supabase Cron wasn't set up: ${(error as Error).message.slice(0, 160)}`)
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

async function main() {
  const databaseUrl = hosting.DATABASE_URL
  const serviceKey = hosting.SUPABASE_SERVICE_KEY
  if (!databaseUrl || !serviceKey || !hosting.OWNER_PASSCODE || !hosting.STAFF_PASSCODE) stop('Run put-stockpot-online.command, which asks for these first.')
  if (!local.MODEL_API_KEY) stop('Your Meta key is not in .env yet. Double-click connect-apis.command first.')
  const supabaseUrl = hosting.SUPABASE_URL || projectUrl(databaseUrl)

  say('1 of 5. Checking Supabase.')
  await checkDatabase(databaseUrl)
  await makeBucket(supabaseUrl, serviceKey, REAL_BUCKET)
  await makeBucket(supabaseUrl, serviceKey, SAMPLE_BUCKET)
  await checkStorage(supabaseUrl, serviceKey, REAL_BUCKET)
  say('  The database and both private buckets work.')

  say('2 of 5. Signing in to Vercel.')
  if (!vercel(['whoami'], { capture: true }).ok && !vercel(['login']).ok) stop("Vercel sign-in didn't finish.")

  const shared = { DATABASE_URL: databaseUrl, SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_KEY: serviceKey }
  const timezone: Record<string, string> = local.RESTAURANT_TIMEZONE ? { RESTAURANT_TIMEZONE: local.RESTAURANT_TIMEZONE } : {}

  say('3 of 5. The sample site, for judges and visitors.')
  linkProject(SAMPLE_PROJECT)
  setVariables({ ...shared, ...timezone, DB_SCHEMA: 'sample', SUPABASE_BUCKET: SAMPLE_BUCKET, CRON_SECRET: secret('SAMPLE_CRON_SECRET') })
  const sampleAddress = deploy(SAMPLE_PROJECT)
  await waitUntilUp(sampleAddress)
  remember('SAMPLE_SITE', sampleAddress)
  say(`  Up at ${sampleAddress}`)

  say('4 of 5. The real site.')
  const cronSecret = secret('CRON_SECRET')
  linkProject(REAL_PROJECT)
  const copied = Object.fromEntries(COPIED.filter((name) => local[name]).map((name) => [name, local[name]]))
  setVariables({
    ...shared, ...copied, SUPABASE_BUCKET: REAL_BUCKET, CRON_SECRET: cronSecret, SESSION_SECRET: secret('SESSION_SECRET'),
    OWNER_PASSCODE: hosting.OWNER_PASSCODE, STAFF_PASSCODE: hosting.STAFF_PASSCODE,
  })
  say(`  Copied from .env: ${Object.keys(copied).join(', ')}`)
  const realAddress = deploy(REAL_PROJECT)
  await waitUntilUp(realAddress)
  remember('REAL_SITE', realAddress)
  say(`  Up at ${realAddress}`)
  say('  Testing Meta from Vercel. This takes up to a minute.')
  const region = await reachMeta(realAddress, hosting.OWNER_PASSCODE)

  say('5 of 5. The 5-minute timer.')
  const scheduled = await setUpCron(realAddress, databaseUrl, cronSecret)
  const pass = await fetch(`${realAddress}/api/cron`, { method: 'POST', headers: { Authorization: `Bearer ${cronSecret}` } }).catch(() => null)
  say(pass?.ok ? '  One pass ran cleanly.' : `  A test pass failed with ${pass?.status ?? 'no answer'}.`)

  say('\nDone.')
  say(`Real site:   ${realAddress}`)
  say(`Sample site: ${sampleAddress}`)
  say(`Meta:        ${region ? `answers from ${region}` : 'refused every region. Stockpot needs a relay, see META_BASE_URL in the README.'}`)
  say(`Timer:       ${scheduled ? 'every 5 minutes on Supabase Cron' : 'not set up, see Supabase Cron in the README'}`)
  if (local.GOOGLE_CLIENT_ID) say(`Google:      add ${realAddress}/api/google/callback as a redirect URI`)
  if (local.WHATSAPP_VERIFY_TOKEN) say(`WhatsApp:    set the callback URL to ${realAddress}/whatsapp/webhook`)
}

await main().catch((error) => stop((error as Error).message.slice(0, 200))).finally(() => { for (const leftover of ['.vercel', '.env.local']) fs.rmSync(leftover, { recursive: true, force: true }) })
