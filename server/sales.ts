import { all, get, run, transaction } from './db.ts'
import { nameKey, parseDate } from './parsing.ts'
import { marginPercent } from '../shared/costing.ts'

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null)

/** Food cost for a date range, from the same SQL view the app shows. */
export async function foodCost(from: string, to: string) {
  const row = (await get('SELECT COALESCE(SUM(net_p), 0) AS net_p, COALESCE(SUM(cost_p), 0) AS cost_p, COUNT(*) AS days FROM v_food_cost WHERE date BETWEEN ? AND ?', from, to))!
  const net = Number(row.net_p)
  const cost = Math.round(Number(row.cost_p))
  return { from, to, days: Number(row.days), net_sales_pence: net, food_cost_pence: cost, food_cost_percent: percent(cost, net) }
}

export async function dishMargins(from: string, to: string) {
  // A dish missing a price would look cheaper than it is, so the screen is told its cost isn't complete.
  const incomplete = new Set((await all(`SELECT d.id FROM dishes d WHERE NOT EXISTS (SELECT 1 FROM recipe_lines r WHERE r.dish_id = d.id)
                OR EXISTS (SELECT 1 FROM recipe_lines r WHERE r.dish_id = d.id AND NOT EXISTS (SELECT 1 FROM price_history p WHERE p.item_id = r.item_id))`)).map((row) => Number(row.id)))
  return (await all(`SELECT dish_id, dish_name, target_margin, SUM(qty) AS qty, SUM(net_p) AS net_p, SUM(cost_p) AS cost_p
              FROM v_dish_margin WHERE date BETWEEN ? AND ? GROUP BY dish_id, dish_name, target_margin ORDER BY dish_name`, from, to))
    .map((row) => {
      const net = Number(row.net_p)
      const cost = Math.round(Number(row.cost_p))
      return {
        dish: row.dish_name, sold: Number(row.qty), net_sales_pence: net, food_cost_pence: cost,
        margin_percent: marginPercent(net, cost), target_margin_percent: Number(row.target_margin), cost_incomplete: incomplete.has(Number(row.dish_id)),
      }
    })
}

/** Splits one CSV line, including quoted cells with commas in them. */
function cells(line: string) {
  const out: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' && quoted && line[index + 1] === '"') { cell += '"'; index += 1 }
    else if (character === '"') quoted = !quoted
    else if (character === ',' && !quoted) { out.push(cell); cell = '' }
    else cell += character
  }
  out.push(cell)
  return out.map((value) => value.trim())
}

const COLUMNS = {
  date: ['date', 'day', 'sale date'],
  dish: ['dish', 'item', 'name', 'product', 'menu item'],
  qty: ['quantity', 'qty', 'sold', 'count'],
  net: ['net sales', 'net', 'net_sales', 'sales', 'revenue'],
}

export interface SaleRow { date: string; dishId: number; quantity: number; netPence: number }

export const dishIds = async () => new Map((await all('SELECT id, name FROM dishes')).map((dish) => [nameKey(String(dish.name)), Number(dish.id)]))

/** What's already saved for these days, so a row can be compared before it's written. */
export async function savedSales(dates: string[]) {
  const sorted = [...dates].sort()
  const rows = sorted.length ? await all('SELECT date, dish_id, qty, net_p FROM sales WHERE date BETWEEN ? AND ?', sorted[0], sorted.at(-1)) : []
  return new Map(rows.map((row) => [`${row.date}|${row.dish_id}`, { quantity: Number(row.qty), netPence: Number(row.net_p) }]))
}

/**
 * One sale a dish a day, so loading a file twice never counts twice. A row that matches what's saved is skipped,
 * and a row that differs replaces it. Every way into the sales table comes through here.
 */
export async function writeSales(rows: SaleRow[]) {
  const counts = { added: 0, replaced: 0, skipped: 0 }
  await transaction(async () => {
    const saved = await savedSales(rows.map((row) => row.date))
    for (const row of rows) {
      const key = `${row.date}|${row.dishId}`
      const before = saved.get(key)
      if (before && before.quantity === row.quantity && before.netPence === row.netPence) { counts.skipped += 1; continue }
      await run(`INSERT INTO sales (date, dish_id, qty, net_p) VALUES (?, ?, ?, ?)
           ON CONFLICT (date, dish_id) DO UPDATE SET qty = excluded.qty, net_p = excluded.net_p`, row.date, row.dishId, row.quantity, row.netPence)
      saved.set(key, { quantity: row.quantity, netPence: row.netPence })
      counts[before ? 'replaced' : 'added'] += 1
    }
  })
  return counts
}

/** Till exports differ, so columns are matched by name. Each bad row is reported, and good rows still load. */
export async function importSalesCsv(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return { imported: 0, skipped: 0, problems: ['The file has no rows.'] }
  const header = cells(lines[0]).map((name) => name.toLowerCase())
  const find = (names: string[]) => header.findIndex((name) => names.includes(name))
  const column = { date: find(COLUMNS.date), dish: find(COLUMNS.dish), qty: find(COLUMNS.qty), net: find(COLUMNS.net) }
  if (Object.values(column).some((index) => index < 0)) return { imported: 0, skipped: 0, problems: ['The file needs date, dish, quantity and net sales columns.'] }

  const dishes = await dishIds()
  const problems: string[] = []
  const good: SaleRow[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    const row = cells(line)
    const date = parseDate(row[column.date] ?? '')
    const dishId = dishes.get(nameKey(row[column.dish] ?? ''))
    const qty = Number(row[column.qty])
    const net = Number((row[column.net] ?? '').replace(/[£,]/g, ''))
    if (!date) problems.push(`Row ${index + 2}: the date isn't readable.`)
    else if (!dishId) problems.push(`Row ${index + 2}: "${row[column.dish]}" isn't on the menu.`)
    else if (!Number.isInteger(qty) || qty < 0 || !Number.isFinite(net) || net < 0) problems.push(`Row ${index + 2}: check the quantity and net sales.`)
    else good.push({ date, dishId, quantity: qty, netPence: Math.round(net * 100) })
  }
  const { added, replaced, skipped } = await writeSales(good)
  return { imported: added + replaced, skipped, problems: problems.slice(0, 8) }
}
