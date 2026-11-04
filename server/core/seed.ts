import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { writeFile } from './files.ts'
import { startDemoDay } from './clock.ts'
import { all, daysAgo, get, insert, isPostgres, locked, nowIso, run, saveSetting, setting } from './db.ts'
import { seedChecklists } from '../operations/checklists.ts'
import { reportDeliveryProblems } from '../operations/checks.ts'
import { t } from './lang.ts'

const TABLES = [
  'stock_counts', 'credits', 'message_log', 'team_messages', 'team_proposals', 'checklist_entries', 'checklist_runs', 'checklist_items', 'checklist_templates', 'staff_reports', 'actions', 'weekly_reports', 'sales',
  'delivery_media', 'delivery_lines', 'deliveries', 'invoice_lines', 'invoices', 'order_lines', 'tasks', 'orders', 'live_cards', 'call_turns', 'calls',
  'price_history', 'recipe_lines', 'dishes', 'items', 'suppliers',
]

/** Portions of chicken curry sold by weekday, Sunday first. The wrap sells about seven for every ten curries. */
const CURRY_BY_DAY = [30, 24, 26, 28, 32, 44, 52]

/** Fictional restaurant and suppliers. Every name and price here is sample data. */
async function seedAll() {
  // 020 7946 0xxx is set aside by Ofcom for fiction, so these numbers can't ring anyone.
  const supplier = (name: string, contact: string, email: string, phone: string, category: string) =>
    insert('INSERT INTO suppliers (name, contact, email, phone, category) VALUES (?, ?, ?, ?, ?)', name, contact, email, phone, category)
  const harrow = await supplier('Harrow Lane Foods', 'Dave', 'orders@harrowlane.example', '020 7946 0101', 'Meat and fish')
  const northgate = await supplier('Northgate Wholesale', 'Priya', 'sales@northgate.example', '020 7946 0102', 'Veg and fruit')
  const oakfield = await supplier('Oakfield Dairy', 'Tom', 'hello@oakfield.example', '020 7946 0103', 'Dairy')
  // Rice and oil come from a dry-goods supplier, so the shopping list shows each kind of supplier with its own items.
  const spice = await supplier('Spice Route Traders', 'Amir', 'orders@spiceroute.example', '020 7946 0104', 'Spices and dry goods')

  const item = (name: string, aliases: string[], unit: string, caseQty: number | null = null) =>
    insert('INSERT INTO items (name, aliases, base_unit, case_qty) VALUES (?, ?, ?, ?)', name, JSON.stringify(aliases), unit, caseQty)

  const thighs = await item('Chicken thighs', ['chicken thighs', 'thighs', 'chicken thigh'], 'kg', 10)
  const onions = await item('Brown onions', ['brown onions', 'onions', 'onion'], 'kg', 25)
  const tomatoes = await item('Tomatoes', ['tomatoes', 'toms'], 'kg', 6)
  const rice = await item('Basmati rice', ['basmati rice', 'basmati', 'rice'], 'kg', 20)
  const oil = await item('Rapeseed oil', ['rapeseed oil', 'rapeseed', 'oil'], 'l', 20)
  const cream = await item('Double cream', ['double cream', 'cream'], 'l', 6)

  const price = (itemId: number, supplierId: number, days: number, pence: number) =>
    run('INSERT INTO price_history (item_id, supplier_id, date, price_p) VALUES (?, ?, ?, ?)', itemId, supplierId, daysAgo(days), pence)

  await price(thighs, harrow, 41, 580); await price(thighs, northgate, 20, 610); await price(thighs, harrow, 15, 590); await price(thighs, harrow, 7, 640)
  await price(onions, harrow, 27, 85); await price(onions, northgate, 20, 92); await price(onions, harrow, 15, 85); await price(onions, harrow, 6, 85)
  await price(tomatoes, northgate, 20, 225); await price(tomatoes, harrow, 15, 210); await price(tomatoes, harrow, 6, 210)
  await price(rice, northgate, 12, 195); await price(oil, northgate, 12, 160); await price(cream, oakfield, 5, 320)

  const dish = async (name: string, pricePence: number, target: number, lines: Array<[number, number]>) => {
    const id = await insert('INSERT INTO dishes (name, price_p, target_margin) VALUES (?, ?, ?)', name, pricePence, target)
    for (const [itemId, qty] of lines) await run('INSERT INTO recipe_lines (dish_id, item_id, qty_base) VALUES (?, ?, ?)', id, itemId, qty)
    return id
  }
  // Who the shopping list sends each ingredient to. Prices above stay as they were paid.
  for (const [itemId, supplierId, category] of [[thighs, harrow, 'Meat and fish'], [onions, northgate, 'Veg and fruit'], [tomatoes, northgate, 'Veg and fruit'],
    [rice, spice, 'Spices and dry goods'], [oil, spice, 'Spices and dry goods'], [cream, oakfield, 'Dairy']] as Array<[number, number, string]>) {
    await run('UPDATE items SET supplier_id = ?, category = ? WHERE id = ?', supplierId, category, itemId)
  }

  // Yesterday's stock count, so the Stock tab and the shopping list have something to show. The densities stand in for the AI's.
  for (const [itemId, density] of [[thighs, 0.75], [onions, 0.55], [tomatoes, 0.6], [rice, 0.85], [oil, 0.92], [cream, 1]]) {
    await run(`UPDATE items SET density_kg_l = ?, density_source = 'ai' WHERE id = ?`, density, itemId)
  }
  for (const [itemId, count, pack] of [[rice, 2, 'box'], [onions, 1, 'crate'], [oil, 3, 'container'], [cream, 2, 'container']] as Array<[number, number, string]>) {
    await insert(`INSERT INTO stock_counts (item_id, count_value, pack, counted_by, counted_at) VALUES (?, ?, ?, 'staff', ?)`, itemId, count, pack, new Date(Date.now() - 86400000).toISOString())
  }

  const curry = await dish('Chicken curry', 950, 80, [[thighs, 0.2], [rice, 0.15], [cream, 0.05], [onions, 0.1], [oil, 0.02]])
  const wrap = await dish('Grilled chicken wrap', 850, 85, [[thighs, 0.16], [tomatoes, 0.05], [onions, 0.03]])

  for (let days = 1; days <= 35; days += 1) {
    const date = daysAgo(days)
    const curries = CURRY_BY_DAY[new Date(`${date}T12:00:00Z`).getUTCDay()]
    const wraps = Math.round(curries * 0.7)
    await run('INSERT INTO sales (date, dish_id, qty, net_p) VALUES (?, ?, ?, ?)', date, curry, curries, curries * 950)
    await run('INSERT INTO sales (date, dish_id, qty, net_p) VALUES (?, ?, ?, ?)', date, wrap, wraps, wraps * 850)
  }

  // Last week's order, already checked and clean. It's the paper trail behind the price rise.
  const when = `${daysAgo(7)}T09:05:00.000Z`
  const callId = await insert(`INSERT INTO calls (supplier_id, status, source, consent_at, started_at, ended_at, duration_ms, summary) VALUES (?, 'done', 'sample', ?, ?, ?, 21000, ?)`,
    harrow, when, when, when, 'Ordered 20 kg chicken thighs at the new price of £6.40 a kilo.')
  const turns: Array<[string, string, string]> = [
    ['A', 'owner', 'Morning Dave, twenty kilos of chicken thighs please.'],
    ['B', 'supplier', 'Chicken thighs are going up from five ninety to six forty a kilo from today, Sam.'],
    ['A', 'owner', "OK, I'll take them at six forty for now."],
  ]
  for (const [index, [speaker, role, text]] of turns.entries()) {
    await run('INSERT INTO call_turns (call_id, turn_no, start_ms, end_ms, speaker, role, text) VALUES (?, ?, ?, ?, ?, ?, ?)', callId, index + 1, index * 7000, (index + 1) * 7000, speaker, role, text)
  }
  const orderId = await insert(`INSERT INTO orders (call_id, supplier_id, status, delivery_date, summary, created_at) VALUES (?, ?, 'confirmed', ?, ?, ?)`,
    callId, harrow, daysAgo(6), 'Ordered 20 kg chicken thighs at £6.40 a kilo.', when)
  await run('INSERT INTO order_lines (order_id, item_id, qty_milli, agreed_price_p, evidence_turn) VALUES (?, ?, 20000, 640, 2)', orderId, thighs)
  const deliveryId = await insert(`INSERT INTO deliveries (order_id, status, checked_at, stored_at) VALUES (?, 'done', ?, 'Walk-in fridge')`, orderId, `${daysAgo(6)}T07:40:00.000Z`)
  await run('INSERT INTO delivery_lines (delivery_id, item_id, received_milli) VALUES (?, ?, 20000)', deliveryId, thighs)
  const invoiceFile = `${crypto.randomUUID()}.png`
  const sample = path.resolve('public/samples/sample-invoice-previous.png')
  if (fs.existsSync(sample)) await writeFile(invoiceFile, fs.readFileSync(sample))
  const invoiceId = await insert(`INSERT INTO invoices (file, original_name, status, supplier_id, supplier_name, number, date, net_p, vat_p, gross_p, order_id, created_at)
                            VALUES (?, 'sample-invoice-previous.png', 'read', ?, 'Harrow Lane Foods', 'HLF-20377', ?, 12800, 0, 12800, ?, ?)`, invoiceFile, harrow, daysAgo(6), orderId, nowIso())
  await run(`INSERT INTO invoice_lines (invoice_id, item_id, description, qty_billed, unit, unit_price_p, line_total_p, vat_rate, qty_base_milli, price_base_p)
       VALUES (?, ?, 'Chicken thighs, boneless', 20, 'kg', 640, 12800, 0, 20000, 640)`, invoiceId, thighs)

  // Yesterday's delivery came up short, so the owner has someone to ring. Tomorrow's is on its way.
  const shortOrder = await insert(`INSERT INTO orders (supplier_id, status, delivery_date, summary, created_at) VALUES (?, 'confirmed', ?, ?, ?)`,
    northgate, daysAgo(1), 'Ordered 15 kg brown onions at 92p a kilo.', `${daysAgo(3)}T10:20:00.000Z`)
  await run('INSERT INTO order_lines (order_id, item_id, qty_milli, agreed_price_p) VALUES (?, ?, 15000, 92)', shortOrder, onions)
  const shortDelivery = await insert(`INSERT INTO deliveries (order_id, status, checked_at, stored_at, note) VALUES (?, 'done', ?, 'Dry store', ?)`,
    shortOrder, `${daysAgo(1)}T07:55:00.000Z`, 'Driver said the last bag was left at the depot.')
  await run(`INSERT INTO delivery_lines (delivery_id, item_id, received_milli, issue) VALUES (?, ?, 10000, 'short')`, shortDelivery, onions)
  const nextOrder = await insert(`INSERT INTO orders (supplier_id, status, delivery_date, summary, created_at) VALUES (?, 'confirmed', ?, ?, ?)`,
    oakfield, daysAgo(-1), 'Ordered 6 l double cream at £3.20 a litre.', `${daysAgo(1)}T14:10:00.000Z`)
  await run('INSERT INTO order_lines (order_id, item_id, qty_milli, agreed_price_p) VALUES (?, ?, 6000, 320)', nextOrder, cream)
  await insert('INSERT INTO deliveries (order_id) VALUES (?)', nextOrder)

  // Today's delivery is the one to film: 30 kg in 6 kg boxes, and the sample clip shows four boxes.
  const todayOrder = await insert(`INSERT INTO orders (supplier_id, status, delivery_date, summary, created_at) VALUES (?, 'confirmed', ?, ?, ?)`,
    northgate, daysAgo(0), 'Ordered 30 kg tomatoes at £2.25 a kilo.', `${daysAgo(2)}T11:05:00.000Z`)
  await run('INSERT INTO order_lines (order_id, item_id, qty_milli, agreed_price_p) VALUES (?, ?, 30000, 225)', todayOrder, tomatoes)
  await insert('INSERT INTO deliveries (order_id) VALUES (?)', todayOrder)

  await seedChecklists()
  await reportDeliveryProblems(shortOrder)
  await run(`UPDATE actions SET created_at = ? WHERE source_type = 'problem'`, `${daysAgo(1)}T07:55:00.000Z`)
}

export class RefusedWipe extends Error {}

/**
 * Three separate locks on the one thing that can empty the tables. A real key refuses it. On Postgres
 * only the sample schema can be cleared. And a database a real site has ever used is marked, so even
 * a key that goes missing from the settings can't turn the real restaurant into a sample to be cleared.
 */
async function assertOnlySample() {
  if (config.mode !== 'sample') throw new RefusedWipe(t('Stockpot will not clear data while a Meta key is set.'))
  if (isPostgres() && config.dbSchema !== 'sample') throw new RefusedWipe(t('Stockpot will only clear data in the sample schema.'))
  if (await setting('real_site') === '1') throw new RefusedWipe(t('This database belongs to a real restaurant, so Stockpot will not clear it.'))
}

/** Sample mode gets the fictional restaurant. A real owner starts clean, with starter checklists to edit. */
export async function seedIfEmpty() {
  const sample = config.mode === 'sample' || process.env.SAMPLE_DATA === '1'
  const marked = config.mode !== 'live' || await setting('real_site') === '1'
  // Every cold start comes through here, and it mustn't queue for a lock once the work is done.
  if (marked && (await all('SELECT id FROM checklist_templates LIMIT 1')).length) return
  // Two instances can start at once, and only one of them should fill an empty database.
  await locked('seed', async () => {
    if (config.mode === 'live') await saveSetting('real_site', '1')
    if (sample && !(await all('SELECT id FROM suppliers LIMIT 1')).length) {
      await seedAll()
      // Named people, so the staff tracker shows who has what.
      await run(`UPDATE checklist_templates SET assignee = 'Maria' WHERE name IN ('Fridge and water checks', 'Opening checks')`)
      await run(`UPDATE checklist_templates SET assignee = 'Dawid' WHERE name = 'Closing checks'`)
    }
    else if (!(await all('SELECT id FROM checklist_templates LIMIT 1')).length) await seedChecklists()
  })
}

/** Removes the fictional restaurant, so the owner's own data starts from nothing. */
export async function clearSampleData() {
  await assertOnlySample()
  await locked('seed', async () => {
    for (const table of TABLES) await run(`DELETE FROM ${table}`)
    await run('DELETE FROM proof_checks')
    await run('DELETE FROM crisis_cards')
    await seedChecklists()
  })
}

/** Clears the sample restaurant and builds it again, with dates that lead up to today. */
export async function resetSample() {
  await assertOnlySample()
  await locked('seed', async () => {
    for (const table of TABLES) await run(`DELETE FROM ${table}`)
    await startDemoDay()
    await seedAll()
  })
}

/** A hosted demo can sit for days. Without this, its sales would drift out of the weekly window. */
export async function refreshStaleSample() {
  const latest = await get('SELECT MAX(date) AS date FROM sales')
  if ((!latest?.date || latest.date < daysAgo(3)) && await setting('real_site') !== '1') await resetSample()
}
