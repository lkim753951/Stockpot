import { all, get, run } from './db.ts'

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null)

/** Food cost for a date range, from the same SQL view the app shows. */
export async function foodCost(from: string, to: string) {
  const row = (await get('SELECT COALESCE(SUM(net_p), 0) AS net_p, COALESCE(SUM(cost_p), 0) AS cost_p, COUNT(*) AS days FROM v_food_cost WHERE date BETWEEN ? AND ?', from, to))!
  const net = Number(row.net_p)
  const cost = Math.round(Number(row.cost_p))
  return { from, to, days: Number(row.days), net_sales_pence: net, food_cost_pence: cost, food_cost_percent: percent(cost, net) }
}

export async function dishMargins(from: string, to: string) {
  return (await all(`SELECT dish_name, target_margin, SUM(qty) AS qty, SUM(net_p) AS net_p, SUM(cost_p) AS cost_p
              FROM v_dish_margin WHERE date BETWEEN ? AND ? GROUP BY dish_id, dish_name, target_margin ORDER BY dish_name`, from, to))
    .map((row) => {
      const net = Number(row.net_p)
      const cost = Math.round(Number(row.cost_p))
      return {
        dish: row.dish_name, sold: Number(row.qty), net_sales_pence: net, food_cost_pence: cost,
        margin_percent: percent(net - cost, net), target_margin_percent: Number(row.target_margin),
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

function isoFrom(text: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const uk = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  return uk ? `${uk[3]}-${uk[2].padStart(2, '0')}-${uk[1].padStart(2, '0')}` : null
}

const COLUMNS = {
  date: ['date', 'day', 'sale date'],
  dish: ['dish', 'item', 'name', 'product', 'menu item'],
  qty: ['quantity', 'qty', 'sold', 'count'],
  net: ['net sales', 'net', 'net_sales', 'sales', 'revenue'],
}

/** Till exports differ, so columns are matched by name. Each bad row is reported, and good rows still load. */
export async function importSalesCsv(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return { imported: 0, problems: ['The file has no rows.'] }
  const header = cells(lines[0]).map((name) => name.toLowerCase())
  const find = (names: string[]) => header.findIndex((name) => names.includes(name))
  const column = { date: find(COLUMNS.date), dish: find(COLUMNS.dish), qty: find(COLUMNS.qty), net: find(COLUMNS.net) }
  if (Object.values(column).some((index) => index < 0)) return { imported: 0, problems: ['The file needs date, dish, quantity and net sales columns.'] }

  const dishes = new Map((await all('SELECT id, name FROM dishes')).map((dish) => [String(dish.name).toLowerCase(), Number(dish.id)]))
  const problems: string[] = []
  let imported = 0
  for (const [index, line] of lines.slice(1).entries()) {
    const row = cells(line)
    const date = isoFrom(row[column.date] ?? '')
    const dishId = dishes.get((row[column.dish] ?? '').toLowerCase())
    const qty = Number(row[column.qty])
    const net = Number((row[column.net] ?? '').replace(/[£,]/g, ''))
    if (!date) problems.push(`Row ${index + 2}: the date isn't readable.`)
    else if (!dishId) problems.push(`Row ${index + 2}: "${row[column.dish]}" isn't on the menu.`)
    else if (!Number.isInteger(qty) || qty < 0 || !Number.isFinite(net) || net < 0) problems.push(`Row ${index + 2}: check the quantity and net sales.`)
    else {
      await run(`INSERT INTO sales (date, dish_id, qty, net_p) VALUES (?, ?, ?, ?)
           ON CONFLICT (date, dish_id) DO UPDATE SET qty = excluded.qty, net_p = excluded.net_p`, date, dishId, qty, Math.round(net * 100))
      imported += 1
    }
  }
  return { imported, problems: problems.slice(0, 8) }
}
