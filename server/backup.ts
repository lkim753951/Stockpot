import fs from 'node:fs'
import path from 'node:path'
import { all, claim, db, get, isPostgres, TABLES } from './db.ts'
import { areaDir, listBackups, removeFile, writeFile } from './files.ts'
import { localTime } from './clock.ts'

const KEEP = 7
const NAMED = /^stockpot-\d{4}-\d{2}-\d{2}\.(sqlite|json)$/
/** Nothing here is needed to read a backup, and a backup is a poor place for a key to Gmail. */
const LEFT_OUT = new Set(['google_refresh_token'])

/** SQLite's copy stays beside the database, and only the Postgres export goes to Storage. */
const copies = async () => (isPostgres() ? await listBackups() : fs.readdirSync(areaDir('backups'))).filter((name) => NAMED.test(name)).sort()

/** Every table as JSON, because Supabase's free plan keeps no backups of its own. */
async function exportTables(name: string) {
  const tables: Record<string, unknown[]> = {}
  for (const table of TABLES) {
    const rows = await all(`SELECT * FROM ${table}`)
    tables[table] = table === 'settings' ? rows.filter((row) => !LEFT_OUT.has(String(row.key)) && !String(row.key).startsWith('claim:')) : rows
  }
  await writeFile(name, Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), tables })), 'backups')
}

/** One copy of the database a day, a week kept. On SQLite everything is on one disk, so this guards against mistakes, not a lost disk. */
export async function backupIfDue() {
  const day = localTime().date
  const name = `stockpot-${day}.${isPostgres() ? 'json' : 'sqlite'}`
  if ((await copies()).includes(name)) return false
  if (isPostgres()) {
    if (!await claim(`backup:${day}`, 10 * 60000)) return false
    await exportTables(name)
  } else {
    const file = path.join(areaDir('backups'), name)
    fs.rmSync(file, { force: true })
    await db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }
  for (const old of (await copies()).slice(0, -KEEP)) {
    if (isPostgres()) await removeFile(old, 'backups')
    else fs.rmSync(path.join(areaDir('backups'), old), { force: true })
  }
  return true
}

/** What's saved, for the developer screen. */
export async function dataStatus() {
  const count = async (table: string) => Number((await get(`SELECT COUNT(*) AS total FROM ${table}`))?.total ?? 0)
  const saved = await copies()
  return {
    kept: { suppliers: await count('suppliers'), orders: await count('orders'), invoices: await count('invoices'), calls: await count('calls'), checklists: await count('checklist_runs') },
    backups: saved.length,
    lastBackup: saved.at(-1)?.slice(9, 19) ?? null,
  }
}
