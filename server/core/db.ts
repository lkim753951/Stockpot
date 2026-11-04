import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

/**
 * One database API with two backends. Postgres runs when DATABASE_URL is set, and SQLite otherwise.
 * Every statement is written once, with ? placeholders, in SQL that both can read.
 * What can't be shared is changed in one place, by toPostgres and postgresSchema below.
 */

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT, email TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL DEFAULT '[]',
  base_unit TEXT NOT NULL CHECK (base_unit IN ('kg','l','each')), case_qty REAL
);
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  count_value REAL NOT NULL, pack TEXT NOT NULL CHECK (pack IN ('container','box','crate','unit')),
  counted_by TEXT NOT NULL, counted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id), date TEXT NOT NULL,
  price_p REAL NOT NULL, invoice_line_id INTEGER
);
CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_p INTEGER NOT NULL, target_margin INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_lines (
  dish_id INTEGER NOT NULL REFERENCES dishes(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty_base REAL NOT NULL, PRIMARY KEY (dish_id, item_id)
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'ready', source TEXT NOT NULL DEFAULT 'microphone',
  consent_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  audio_file TEXT, summary TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS call_turns (
  id INTEGER PRIMARY KEY, call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  turn_no INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  speaker TEXT, role TEXT, text TEXT NOT NULL, UNIQUE (call_id, turn_no)
);
CREATE TABLE IF NOT EXISTS live_cards (
  id INTEGER PRIMARY KEY, call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), kind TEXT NOT NULL, price_p REAL NOT NULL,
  qty_base REAL, source TEXT NOT NULL, latency_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, call_id INTEGER REFERENCES calls(id), supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft', delivery_date TEXT, summary TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), qty_milli INTEGER NOT NULL, agreed_price_p REAL,
  evidence_turn INTEGER, needs_review INTEGER NOT NULL DEFAULT 0, review_note TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, call_id INTEGER REFERENCES calls(id), title TEXT NOT NULL,
  due_date TEXT, done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  photo_file TEXT, status TEXT NOT NULL DEFAULT 'open', checked_at TEXT
);
CREATE TABLE IF NOT EXISTS delivery_lines (
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), received_milli INTEGER NOT NULL,
  PRIMARY KEY (delivery_id, item_id)
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, original_name TEXT, status TEXT NOT NULL DEFAULT 'reading',
  supplier_id INTEGER REFERENCES suppliers(id), supplier_name TEXT, number TEXT, date TEXT,
  net_p INTEGER, vat_p INTEGER, gross_p INTEGER, order_id INTEGER REFERENCES orders(id),
  issues TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id), description TEXT NOT NULL, qty_billed REAL NOT NULL, unit TEXT NOT NULL,
  pack_qty REAL, unit_price_p REAL NOT NULL, line_total_p INTEGER NOT NULL, vat_rate REAL,
  qty_base_milli INTEGER NOT NULL, price_base_p REAL NOT NULL, issue TEXT
);
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'draft', subject TEXT NOT NULL, body TEXT NOT NULL, total_p INTEGER NOT NULL,
  approved_at TEXT, settled_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, source_id INTEGER NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('now','today','soon')), title TEXT NOT NULL, detail TEXT,
  due_date TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT,
  UNIQUE (source_type, source_id)
);
CREATE TABLE IF NOT EXISTS message_log (
  id INTEGER PRIMARY KEY, channel TEXT NOT NULL, action_id INTEGER, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_messages (
  id INTEGER PRIMARY KEY, wa_id TEXT UNIQUE, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  contact TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT, file TEXT, run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'sent', detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_proposals (
  id INTEGER PRIMARY KEY, contact TEXT NOT NULL, updates TEXT NOT NULL, transcript TEXT, photo_file TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  role TEXT NOT NULL DEFAULT 'staff', due_time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, label TEXT NOT NULL, check_type TEXT NOT NULL CHECK (check_type IN ('tick','temperature','stock')),
  unit TEXT, min_value REAL, max_value REAL
);
CREATE TABLE IF NOT EXISTS checklist_runs (
  id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  period TEXT NOT NULL, due_at TEXT NOT NULL, completed_at TEXT, UNIQUE (template_id, period)
);
CREATE TABLE IF NOT EXISTS checklist_entries (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE, value REAL, photo_file TEXT, transcript TEXT,
  source TEXT NOT NULL DEFAULT 'tick', status TEXT NOT NULL DEFAULT 'done', created_at TEXT NOT NULL,
  UNIQUE (run_id, item_id)
);
CREATE TABLE IF NOT EXISTS staff_reports (
  id INTEGER PRIMARY KEY, language TEXT, original_text TEXT NOT NULL, english_text TEXT, title TEXT NOT NULL,
  category TEXT, urgency TEXT NOT NULL, crisis_key TEXT, audio_file TEXT, translated INTEGER NOT NULL DEFAULT 1,
  action_id INTEGER REFERENCES actions(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, dish_id INTEGER NOT NULL REFERENCES dishes(id),
  qty INTEGER NOT NULL, net_p INTEGER NOT NULL, UNIQUE (date, dish_id)
);
CREATE TABLE IF NOT EXISTS weekly_reports (
  id INTEGER PRIMARY KEY, week_start TEXT NOT NULL, week_end TEXT NOT NULL, facts TEXT NOT NULL, headline TEXT NOT NULL,
  summary_text TEXT NOT NULL, cause TEXT, actions TEXT NOT NULL, sources TEXT NOT NULL, steps TEXT NOT NULL,
  words_from TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_media (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  file TEXT NOT NULL, video_file TEXT, added_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS mail_seen (message_id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crisis_cards (key TEXT PRIMARY KEY, title TEXT NOT NULL, call_number TEXT, steps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT, created_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS proof_checks (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, item_id INTEGER NOT NULL, file TEXT NOT NULL, video_file TEXT,
  verdict TEXT NOT NULL, reason TEXT NOT NULL, target TEXT, boxes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS call_segments (
  call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE, offset_bytes INTEGER NOT NULL, bytes INTEGER NOT NULL,
  file TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (call_id, offset_bytes)
);
CREATE TABLE IF NOT EXISTS uploads (
  name TEXT PRIMARY KEY, role TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
);
`

/** A database on an owner's machine can be older than this code, so new columns are added in place. */
const LATER_COLUMNS: Array<[string, string, string]> = [
  ['actions', 'snoozed_until', 'TEXT'],
  ['actions', 'assigned_to', 'TEXT'],
  ['tasks', 'urgency', 'TEXT'],
  ['staff_reports', 'photo_file', 'TEXT'],
  ['staff_reports', 'reporter', 'TEXT'],
  ['checklist_runs', 'sent_at', 'TEXT'],
  ['checklist_entries', 'reported_by', 'TEXT'],
  ['suppliers', 'phone', 'TEXT'],
  ['checklist_templates', 'retired', 'INTEGER NOT NULL DEFAULT 0'],
  ['checklist_items', 'retired', 'INTEGER NOT NULL DEFAULT 0'],
  ['checklist_items', 'proof', 'INTEGER NOT NULL DEFAULT 0'],
  ['checklist_items', 'proof_hint', 'TEXT'],
  ['checklist_items', 'proof_target', 'TEXT'],
  ['checklist_entries', 'proof_id', 'INTEGER'],
  ['staff_reports', 'video_file', 'TEXT'],
  ['invoices', 'region', 'TEXT'],
  ['invoices', 'source', 'TEXT'],
  ['orders', 'emailed_at', 'TEXT'],
  ['orders', 'sent_via', 'TEXT'],
  ['orders', 'sent_at', 'TEXT'],
  ['orders', 'replied_at', 'TEXT'],
  ['orders', 'supplier_reply', 'TEXT'],
  ['orders', 'eta_time', 'TEXT'],
  ['orders', 'invoice_accepted_at', 'TEXT'],
  ['orders', 'staff_alerted_at', 'TEXT'],
  ['weekly_reports', 'language', 'TEXT'],
  ['checklist_templates', 'schedule', 'TEXT'],
  ['checklist_templates', 'assignee', 'TEXT'],
  ['checklist_templates', 'chase_after', 'INTEGER'],
  ['checklist_templates', 'call_who', 'TEXT'],
  ['checklist_templates', 'language', 'TEXT'],
  ['checklist_runs', 'reminded_at', 'TEXT'],
  ['checklist_runs', 'chased_at', 'TEXT'],
  ['actions', 'urgency_set', 'INTEGER NOT NULL DEFAULT 0'],
  ['dishes', 'method', 'TEXT'],
  ['deliveries', 'stored_at', 'TEXT'],
  ['deliveries', 'note', 'TEXT'],
  ['deliveries', 'issue_photo', 'TEXT'],
  ['deliveries', 'received_by', 'TEXT'],
  ['orders', 'ordered_on', 'TEXT'],
  ['delivery_media', 'item_id', 'INTEGER'],
  ['delivery_media', 'counted', 'INTEGER'],
  ['delivery_lines', 'issue', 'TEXT'],
  ['dishes', 'photo_file', 'TEXT'],
  ['proof_checks', 'track', 'TEXT'],
  ['crisis_cards', 'added_at', 'TEXT'],
  ['suppliers', 'category', 'TEXT'],
  ['items', 'supplier_id', 'INTEGER'],
  ['items', 'category', 'TEXT'],
  ['items', 'density_kg_l', 'REAL'],
  ['items', 'density_source', 'TEXT'],
  ['dishes', 'weekly_portions', 'INTEGER'],
  ['calls', 'connections', 'INTEGER NOT NULL DEFAULT 0'],
  ['calls', 'last_seen_at', 'TEXT'],
  ['dishes', 'portions', 'INTEGER'],
  ['dishes', 'prep_minutes', 'INTEGER'],
  ['dishes', 'service_minutes', 'INTEGER'],
  ['dishes', 'recipe_file', 'TEXT'],
  ['dishes', 'recipe_file_name', 'TEXT'],
]

/**
 * The newest price paid on or before a date. If an item has no price that early, its first known price is used.
 * The views and the owner's cost calculator both use this, so a dish costs the same on both screens.
 */
export const priceOn = (date: string, field = 'price_p') => `COALESCE(
      (SELECT p.${field} FROM price_history p WHERE p.item_id = r.item_id AND p.date <= ${date} ORDER BY p.date DESC, p.id DESC LIMIT 1),
      (SELECT p.${field} FROM price_history p WHERE p.item_id = r.item_id ORDER BY p.date ASC, p.id ASC LIMIT 1))`

/** Postgres rounds a double half to even and SQLite rounds it away from zero, so money rounds through numeric there. */
const views = (decimal: string) => `
DROP VIEW IF EXISTS v_three_way;
CREATE VIEW v_three_way AS
SELECT
  o.id AS order_id, o.supplier_id, o.call_id, ol.id AS order_line_id, ol.item_id, i.name AS item_name,
  i.base_unit, ol.qty_milli AS ordered_milli, ol.agreed_price_p, ol.evidence_turn,
  d.id AS delivery_id, dl.received_milli, il.id AS invoice_line_id, il.invoice_id,
  il.qty_base_milli AS billed_milli, il.price_base_p AS billed_price_p, il.line_total_p,
  CASE WHEN dl.received_milli IS NULL OR il.id IS NULL THEN NULL
       ELSE CAST(ROUND((CASE WHEN il.qty_base_milli > dl.received_milli THEN il.qty_base_milli - dl.received_milli ELSE 0 END * il.price_base_p / 1000.0)${decimal}) AS INTEGER) END AS short_p,
  CASE WHEN dl.received_milli IS NULL OR il.id IS NULL OR ol.agreed_price_p IS NULL THEN NULL
       ELSE CAST(ROUND((CASE WHEN il.qty_base_milli < dl.received_milli THEN il.qty_base_milli ELSE dl.received_milli END
         * CASE WHEN il.price_base_p > ol.agreed_price_p THEN il.price_base_p - ol.agreed_price_p ELSE 0 END / 1000.0)${decimal}) AS INTEGER) END AS price_gap_p
FROM order_lines ol
JOIN orders o ON o.id = ol.order_id
JOIN items i ON i.id = ol.item_id
LEFT JOIN deliveries d ON d.order_id = o.id AND d.status = 'done'
LEFT JOIN delivery_lines dl ON dl.delivery_id = d.id AND dl.item_id = ol.item_id
LEFT JOIN invoices inv ON inv.order_id = o.id
LEFT JOIN invoice_lines il ON il.invoice_id = inv.id AND il.item_id = ol.item_id;

-- Recipe cost of each day's sales, using the newest price paid on or before that day.
-- If an item has no price that early, its first known price is used.
DROP VIEW IF EXISTS v_food_cost;
DROP VIEW IF EXISTS v_dish_margin;
CREATE VIEW v_dish_margin AS
SELECT
  sa.date, sa.dish_id, d.name AS dish_name, d.target_margin, sa.qty, sa.net_p,
  sa.qty * (
    SELECT SUM(r.qty_base * ${priceOn('sa.date')})
    FROM recipe_lines r WHERE r.dish_id = sa.dish_id
  ) AS cost_p
FROM sales sa JOIN dishes d ON d.id = sa.dish_id;

CREATE VIEW v_food_cost AS
SELECT date, SUM(net_p) AS net_p, SUM(cost_p) AS cost_p FROM v_dish_margin GROUP BY date;
`

/** Every table, for exports and for naming the schema on Postgres. */
export const TABLES = [...BASE_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1])
const VIEWS = ['v_three_way', 'v_dish_margin', 'v_food_cost']
const RELATIONS = new Set([...TABLES, ...VIEWS])

/** Bump this when the schema changes. Postgres only runs its setup when this number moves. */
const SCHEMA_VERSION = '6'

/** Runs fn over the code in a statement, leaving strings, quoted names and comments alone. */
function mapCode(sql: string, fn: (code: string) => string) {
  let out = ''
  let code = ''
  const flush = () => { out += fn(code); code = '' }
  for (let at = 0; at < sql.length;) {
    const start = sql[at]
    if (start === "'" || start === '"') {
      let end = at + 1
      while (end < sql.length) {
        if (sql[end] === start) {
          if (sql[end + 1] !== start) break
          end += 1
        }
        end += 1
      }
      flush()
      out += sql.slice(at, end + 1)
      at = end + 1
    } else if (start === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at)
      flush()
      at = end < 0 ? sql.length : end
    } else {
      code += start
      at += 1
    }
  }
  flush()
  return out
}

const quoted = (schema: string) => `"${schema}"`

/** The one place SQL changes for Postgres: placeholders, names in the right schema, and text that means something else there. */
export function toPostgres(sql: string, schema: string = config.dbSchema) {
  let number = 0
  return mapCode(sql, (code) => code
    .replace(/\?/g, () => `$${number += 1}`)
    // Postgres folds an unquoted alias to lower case, which would silently rename the field in the JSON.
    .replace(/\bAS\s+([a-z]+[A-Z][A-Za-z0-9]*)\b/g, 'AS "$1"')
    // SQLite's LIKE ignores case. Postgres's doesn't.
    .replace(/\bLIKE\b/g, 'ILIKE')
    // Schema names go in the statement, because a transaction pooler can't keep a search_path between statements.
    .replace(/\b(FROM|JOIN|INTO|UPDATE|TABLE|VIEW|REFERENCES)(\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?)([a-z_][a-z0-9_]*)\b/g, (whole, word, gap, name) =>
      (RELATIONS.has(name) ? `${word}${gap}${quoted(schema)}.${name}` : whole)))
}

/** Table definitions for Postgres. Text compares byte by byte, like SQLite, whatever locale the database has. */
export function postgresSchema(sql: string, schema: string = config.dbSchema) {
  const types = mapCode(sql, (code) => code
    .replace(/\bINTEGER PRIMARY KEY\b/g, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
    .replace(/\bINTEGER\b/g, 'BIGINT')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
    .replace(/\bTEXT\b/g, 'TEXT COLLATE "C"')
    // So a view can't be used to read past the row-level security on its tables.
    .replace(/\bCREATE VIEW (\w+) AS\b/g, 'CREATE VIEW $1 WITH (security_invoker = true) AS'))
  return toPostgres(types, schema)
}

export type Row = Record<string, any>
type Params = unknown[]

/** Inside a transaction this holds its connection, so everything awaited in there uses the same one. */
const scope = new AsyncLocalStorage<unknown>()
export interface RunResult { changes: number }

interface Backend {
  kind: 'sqlite' | 'postgres'
  boot(): Promise<void>
  all(sql: string, params: Params): Promise<Row[]>
  run(sql: string, params: Params): Promise<RunResult>
  insert(sql: string, params: Params): Promise<number>
  exec(sql: string): Promise<void>
  transaction<T>(work: () => Promise<T>, lock?: string): Promise<T>
  addColumn(table: string, column: string, type: string): Promise<void>
}

/** A NaN or an endless number would be a type error on Postgres and no match on SQLite. No match is the right answer. */
const cleanNumber = (value: unknown) => (typeof value === 'number' && !Number.isFinite(value) ? null : value ?? null)

function createSqlite(): Backend {
  fs.mkdirSync(config.dataDir, { recursive: true })
  const file = process.env.DATABASE_FILE ?? path.join(config.dataDir, 'stockpot.sqlite')
  let handle: import('node:sqlite').DatabaseSync | null = null
  // One connection, so a transaction that waits on something must keep other statements out until it ends.
  let tail: Promise<unknown> = Promise.resolve()
  const open = async () => {
    if (handle) return handle
    const { DatabaseSync } = await import('node:sqlite')
    handle ??= new DatabaseSync(file)
    return handle
  }
  const turn = async () => {
    const opened = await open()
    if (!scope.getStore()) await tail
    return opened
  }
  type Prepared = { all(...values: unknown[]): Row[]; run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
  const prepared = async (sql: string) => (await turn()).prepare(sql) as unknown as Prepared

  const backend: Backend = {
    kind: 'sqlite',
    async boot() {
      const opened = await open()
      opened.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
      opened.exec(BASE_SCHEMA)
      for (const [table, column, type] of LATER_COLUMNS) await backend.addColumn(table, column, type)
      opened.exec(views(''))
    },
    async all(sql, params) { return (await prepared(sql)).all(...params.map(cleanNumber)) },
    async run(sql, params) { return { changes: Number((await prepared(sql)).run(...params.map(cleanNumber)).changes) } },
    async insert(sql, params) {
      const result = (await prepared(sql)).run(...params.map(cleanNumber))
      return Number(result.changes) ? Number(result.lastInsertRowid) : 0
    },
    async exec(sql) { (await turn()).exec(sql) },
    async transaction(work) {
      if (scope.getStore()) return work()
      const opened = await open()
      const previous = tail
      let finish = () => undefined as void
      tail = new Promise<void>((resolve) => { finish = resolve })
      await previous
      opened.exec('BEGIN IMMEDIATE')
      try {
        const result = await scope.run(true, work)
        opened.exec('COMMIT')
        return result
      } catch (error) {
        opened.exec('ROLLBACK')
        throw error
      } finally {
        finish()
      }
    },
    async addColumn(table, column, type) {
      const opened = await open()
      const columns = opened.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!columns.some((row) => row.name === column)) opened.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    },
  }
  return backend
}

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)

/** Supabase's pooler has its own certificate chain, so sslmode in the address is dropped and TLS is set here. */
export function postgresConnection(address: string, ca = process.env.DATABASE_CA?.trim() || '') {
  let url: URL
  try { url = new URL(address) } catch { return { connectionString: address, ssl: { rejectUnauthorized: false } as const } }
  const mode = url.searchParams.get('sslmode')
  url.searchParams.delete('sslmode')
  url.searchParams.delete('pgbouncer')
  const plain = mode === 'disable' || (isLocalHost(url.hostname) && !mode)
  return { connectionString: url.toString(), ssl: plain ? false as const : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false } }
}

/** A number for an advisory lock, the same on every instance. */
const lockNumber = (name: string) => createHash('sha256').update(name).digest().readInt32BE(0)

/** Postgres text can't hold a zero byte, and a model's reply or a message might. */
const cleanForPostgres = (value: unknown) => {
  const clean = cleanNumber(value)
  return typeof clean === 'string' && clean.includes('\u0000') ? clean.replaceAll('\u0000', '') : clean
}

function createPostgres(): Backend {
  const schema = config.dbSchema
  type Held = { client: import('pg').PoolClient; line: Promise<unknown> }
  let loaded: Promise<import('pg').Pool> | null = null
  const pool = () => (loaded ??= (async () => {
    const { default: pg } = await import('pg')
    // Counts come back as bigint and sums as numeric, and pg gives both as text. Money has to stay a number.
    pg.types.setTypeParser(pg.types.builtins.INT8, Number)
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)
    const made = new pg.Pool({
      ...postgresConnection(config.databaseUrl),
      max: Number(process.env.DB_POOL_MAX ?? 3), min: 0,
      idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000, allowExitOnIdle: true,
    })
    made.on('error', (error) => console.error('database:', error.message))
    if (process.env.VERCEL) {
      const { attachDatabasePool } = await import('@vercel/functions')
      attachDatabasePool(made)
    }
    return made
  })())
  /**
   * Never a named statement and never SET: on a transaction pooler each statement can land on a different connection.
   * Inside a transaction there's one connection and it takes one statement at a time, so they queue here.
   */
  const query = async (text: string, params: Params = []) => {
    const values = params.map(cleanForPostgres)
    const held = scope.getStore() as Held | undefined
    if (!held) return (await pool()).query(text, values)
    const result = held.line.then(() => held.client.query(text, values))
    held.line = result.catch(() => undefined)
    return result
  }

  const currentVersion = async () => {
    const found = await query('SELECT to_regclass($1) AS relation', [`${quoted(schema)}.settings`])
    if (!found.rows[0]?.relation) return null
    return (await query(`SELECT value FROM ${quoted(schema)}.settings WHERE key = 'schema_version'`)).rows[0]?.value ?? null
  }

  const backend: Backend = {
    kind: 'postgres',
    async boot() {
      if (await currentVersion() === SCHEMA_VERSION) return
      // Two instances can boot at once. The second waits here, then finds the work done.
      // A session lock wouldn't survive the pooler, so this one lasts as long as the transaction.
      await backend.transaction(async () => {
        if (await currentVersion() === SCHEMA_VERSION) return
        await query(`CREATE SCHEMA IF NOT EXISTS ${quoted(schema)}`)
        await query(postgresSchema(BASE_SCHEMA, schema))
        for (const [table, column, type] of LATER_COLUMNS) await backend.addColumn(table, column, type)
        await query(postgresSchema(views('::numeric'), schema))
        // Supabase's Data API reads public tables with a key anyone can see. Stockpot connects as the owner, so this shuts only that door.
        for (const table of TABLES) await query(`ALTER TABLE ${quoted(schema)}.${table} ENABLE ROW LEVEL SECURITY`)
        await query(`INSERT INTO ${quoted(schema)}.settings (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [SCHEMA_VERSION])
      }, `schema:${schema}`)
    },
    async all(sql, params) { return (await query(toPostgres(sql, schema), params)).rows },
    async run(sql, params) { return { changes: (await query(toPostgres(sql, schema), params)).rowCount ?? 0 } },
    async insert(sql, params) {
      const text = toPostgres(sql, schema)
      const result = await query(/\bRETURNING\b/.test(text) ? text : `${text} RETURNING id`, params)
      return Number(result.rows[0]?.id ?? 0)
    },
    async exec(sql) { await query(toPostgres(sql, schema)) },
    async transaction(work, lock) {
      if (scope.getStore()) return work()
      const client = await (await pool()).connect()
      try {
        await client.query('BEGIN')
        return await scope.run({ client, line: Promise.resolve() } satisfies Held, async () => {
          if (lock) await client.query('SELECT pg_advisory_xact_lock($1)', [lockNumber(`stockpot:${schema}:${lock}`)])
          const result = await work()
          await client.query('COMMIT')
          return result
        })
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    async addColumn(table, column, type) {
      await query(postgresSchema(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`, schema))
    },
  }
  return backend
}

const backend: Backend = config.databaseUrl ? createPostgres() : createSqlite()

export const isPostgres = () => backend.kind === 'postgres'

let booted: Promise<void> | null = null
/** The schema is built on first use, so /healthz and a plain import touch no database. */
const ready = () => (booted ??= backend.boot().catch((error) => { booted = null; throw error }))

const whenReady = async () => { if (!scope.getStore()) await ready() }

export const all = async (sql: string, ...params: Params) => { await whenReady(); return backend.all(sql, params) }
export const get = async (sql: string, ...params: Params): Promise<Row | undefined> => (await all(sql, ...params))[0]
export const run = async (sql: string, ...params: Params) => { await whenReady(); return backend.run(sql, params) }
/** Adds a row and returns its id, or 0 if a conflict meant nothing was added. */
export const insert = async (sql: string, ...params: Params) => { await whenReady(); return backend.insert(sql, params) }

export const db = {
  exec: async (sql: string) => { await whenReady(); return backend.exec(sql) },
}

/** All of it happens or none of it does. Other statements stay out of the way until it ends. */
export async function transaction<T>(work: () => Promise<T>) {
  await whenReady()
  return backend.transaction(work)
}

/** A transaction that also waits its turn across every instance, for work only one of them should do. */
export async function locked<T>(name: string, work: () => Promise<T>) {
  await whenReady()
  return backend.transaction(work, name)
}

/** For work started from inside a transaction that must outlive it. */
export const outsideTransaction = <T>(work: () => T) => scope.exit(work)

export const addColumn = async (table: string, column: string, type: string) => { await whenReady(); return backend.addColumn(table, column, type) }

export const setting = async (key: string) => ((await get('SELECT value FROM settings WHERE key = ?', key))?.value as string | undefined) ?? null
export const saveSetting = async (key: string, value: string | null) => {
  if (value === null) await run('DELETE FROM settings WHERE key = ?', key)
  else await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
}

/**
 * Takes a named claim for a while, across every instance. Only one caller gets it, and if that
 * caller dies the claim runs out by itself. Returns false if someone else holds it.
 */
export async function claim(name: string, forMs: number) {
  const now = nowIso()
  const { changes } = await run(`INSERT INTO settings (key, value) VALUES (?, ?)
                                 ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value < ?`,
    `claim:${name}`, new Date(Date.now() + forMs).toISOString(), now)
  return changes > 0
}

export const releaseClaim = (name: string) => saveSetting(`claim:${name}`, null)

export function nowIso() {
  return new Date().toISOString()
}

export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function daysAgo(days: number) {
  return isoDate(new Date(Date.now() - days * 86400000))
}
