// Runs every dataset file through the real ingest functions with the real Meta key, and writes ingest-report.md.
// Nothing is saved anywhere that matters: it runs in a throwaway database and folder, with hosted storage turned off.
// Run it with: npx tsx scripts/test-ai-ingest.ts. Add --mock to try the script itself against the stand-in, with no key.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const useMock = process.argv.includes('--mock')
const reportFile = path.resolve(process.env.INGEST_REPORT ?? 'ingest-report.md')
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-ingest-'))
// Set before the server code loads, so this can't reach the owner's database, files or Storage, even if .env names them.
Object.assign(process.env, {
  DATA_DIR: folder, DATABASE_FILE: path.join(folder, 'stockpot.sqlite'), DATABASE_URL: '', DB_SCHEMA: '', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SAMPLE_DATA: '1',
  WHATSAPP_TOKEN: '', TWILIO_ACCOUNT_SID: '', GOOGLE_CLIENT_ID: '',
})
delete process.env.VERCEL

if (useMock) {
  const { startMockMeta } = await import('../server/sample/mockMeta.ts')
  const mock = await startMockMeta()
  Object.assign(process.env, { MODEL_API_KEY: 'mock-key', META_BASE_URL: mock.httpBase, META_REALTIME_URL: mock.wsUrl })
}

const { config } = await import('../server/core/config.ts')
if (config.mode !== 'live') {
  console.error('Add MODEL_API_KEY to .env first.')
  process.exit(1)
}
const { seedIfEmpty } = await import('../server/core/seed.ts')
const { saveDish } = await import('../server/setup/setup.ts')
const { all } = await import('../server/core/db.ts')
const { readIngest } = await import('../server/setup/ingest.ts')
const { uploadDir } = await import('../server/core/files.ts')
const { loadTruth, scoreFile } = await import('./ingest-score.ts')

/** Takes out anything that looks like a secret, so the report can be shared. */
const secrets = Object.entries(process.env).filter(([name, value]) => /KEY|TOKEN|SECRET|PASSCODE|PASSWORD/.test(name) && value && value.length >= 6).map(([, value]) => value!)
const scrub = (text: string) => secrets.reduce((clean, secret) => clean.replaceAll(secret, '[hidden]'), text)

const months = loadTruth()
await seedIfEmpty()
// The dishes have to be on the menu for sales to match. This is only in the throwaway database.
const onMenu = new Set((await all('SELECT name FROM dishes')).map((dish) => dish.name))
for (const recipe of months.flatMap((month) => month.files).filter((file) => file.kind === 'recipes').flatMap((file) => file.expected.recipes)) {
  if (!onMenu.has(recipe.name)) await saveDish({ name: recipe.name, pricePence: recipe.menuPricePence, targetMargin: recipe.targetMargin, lines: [] })
}

const rows: Array<{ month: string; file: string; kind: string; pass: boolean; found: string; totals: string; seconds: string; notes: string }> = []
const cell = (text: string) => scrub(text).replace(/\|/g, '/').replace(/\s+/g, ' ').trim()

/** The owner sees a plain message, and the real cause goes to the log. A report needs the real cause. */
let logged: string[] = []
console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')) }

function writeReport(finished: boolean) {
  const passed = rows.filter((row) => row.pass).length
  const lines = [
    '# Stockpot AI ingest report', '',
    useMock ? '**Mock run. The real Meta models were not used, so this only shows the script works.**' : `Real Muse Spark run, model ${config.sparkModel}.`,
    `Generated ${new Date().toISOString()}. ${finished ? 'Finished' : 'Still running'}: ${passed} of ${rows.length} files passed.`, '',
    'Nothing here touched your data. The run used a throwaway database and folder, which have been deleted.', '',
    '| Month | File | Type | Result | Rows found / expected | Totals | Seconds | Errors or differences |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.month} | ${row.file} | ${row.kind} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.found} | ${cell(row.totals)} | ${row.seconds} | ${cell(row.notes) || 'None'} |`), '',
  ]
  fs.writeFileSync(reportFile, lines.join('\n'))
}

for (const month of months) {
  for (const entry of month.files) {
    const started = Date.now()
    logged = []
    const stored = `${crypto.randomUUID()}${path.extname(entry.file)}`
    fs.copyFileSync(entry.full, path.join(uploadDir(), stored))
    let row: (typeof rows)[number]
    try {
      const score = scoreFile(entry, await readIngest(entry.kind, stored, entry.file))
      row = { month: entry.month, file: entry.file, kind: entry.kind, pass: score.pass, found: `${score.found} / ${score.wanted}`, totals: score.totals, seconds: '', notes: score.wrong.slice(0, 12).join('; ') }
    } catch (error) {
      // One bad file must never stop the rest.
      row = { month: entry.month, file: entry.file, kind: entry.kind, pass: false, found: 'none', totals: 'none', seconds: '', notes: [(error as Error).message, ...logged].join(' ') }
    }
    row.seconds = ((Date.now() - started) / 1000).toFixed(1)
    rows.push(row)
    console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${entry.month}/${entry.file} (${row.seconds} s)${row.notes ? `\n      ${scrub(row.notes).slice(0, 300)}` : ''}`)
    writeReport(false)
  }
}

writeReport(true)
fs.rmSync(folder, { recursive: true, force: true })
const failed = rows.filter((row) => !row.pass).length
console.log(`\n${rows.length - failed} of ${rows.length} files passed. Report: ${path.basename(reportFile)}`)
process.exit(failed ? 1 : 0)
