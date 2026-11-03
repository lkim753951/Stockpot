// Runs every test file on real Postgres, each with a database of its own, so no file sees another's rows.
// Run with: npm run test:postgres. Set TEST_DATABASE_URL to use your own server.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const address = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres'

async function connect() {
  const client = new pg.Client({ connectionString: address })
  try { await client.connect() } catch (error) {
    throw new Error(`No Postgres at ${address}. Start one, or set TEST_DATABASE_URL. ${(error as Error).message}`)
  }
  return client
}

const totals = { tests: 0, pass: 0, fail: 0 }
const wanted = process.argv.slice(2)
const files = fs.readdirSync('test').filter((name) => name.endsWith('.test.ts')).filter((name) => !wanted.length || wanted.some((word) => name.includes(word))).sort()
const admin = await connect()

function runFile(file: string, url: string) {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit', '--test-reporter=tap', `test/${file}`], {
      env: { ...process.env, DATABASE_URL: url, DB_SCHEMA: process.env.DB_SCHEMA ?? '' }, stdio: ['ignore', 'pipe', 'inherit'],
    })
    let tail = ''
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      tail += text
      process.stdout.write(text.split('\n').filter((line) => /^(not ok|# Subtest)|^\s+(error|expected|actual|code):/.test(line) && !line.startsWith('# Subtest')).map((line) => `${line}\n`).join(''))
    })
    child.on('close', (code) => {
      for (const key of ['tests', 'pass', 'fail'] as const) totals[key] += Number(tail.match(new RegExp(`^# ${key} (\\d+)`, 'm'))?.[1] ?? 0)
      resolve(code ?? 1)
    })
  })
}

let failed = 0
for (const file of files) {
  const name = `stockpot_${path.basename(file, '.test.ts').replace(/\W/g, '_')}_${process.pid}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(address)
  url.pathname = `/${name}`
  const code = await runFile(file, url.toString())
  console.log(`${code ? 'FAILED' : 'ok    '} ${file}`)
  failed += code ? 1 : 0
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
}
await admin.end()
console.log(`postgres: ${totals.tests} tests, ${totals.pass} passed, ${totals.fail} failed`)
process.exit(failed ? 1 : 0)
