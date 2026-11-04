import { all, get, run } from '../core/db.ts'
import { localTime } from '../core/clock.ts'
import { CATEGORIES, guessCategory, SetupError } from '../setup/setup.ts'
import { stockOnHand } from './stock.ts'

/**
 * The weekly shopping list. Every recipe's ingredients, times how many of each dish sell in a week, plus a little
 * spare, less what a recent stock count says is already there, grouped by the supplier each ingredient comes from. All plain arithmetic on saved data: no model guesses a number.
 */

/** Spare on top of what the recipes use, for trimming, waste and a busy night. */
export const SPARE_PERCENT = 10
const SALES_WEEKS = 4

/** How much to buy: never less than needed, in steps a supplier can sell. A known case size rounds up to whole cases. */
function toOrder(need: number, unit: string, caseQty: number | null) {
  if (need <= 0) return { quantity: 0, cases: null as number | null }
  if (caseQty && caseQty > 0) {
    const cases = Math.ceil(need / caseQty - 1e-9)
    return { quantity: cases * caseQty, cases }
  }
  if (unit === 'each') return { quantity: Math.ceil(need - 1e-9), cases: null }
  // Kilos and litres go up to the next 100 g or 100 ml under 10, and the next half above.
  const step = need < 10 ? 0.1 : 0.5
  return { quantity: Number((Math.ceil(need / step - 1e-9) * step).toFixed(3)), cases: null }
}

const dayNumber = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 86400000
const isoOf = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10)

/**
 * The latest four weeks of sales the restaurant has, not the four weeks before today: an imported till file from
 * last month still counts. A shorter file is divided by the days it covers, so two weeks of sales aren't halved.
 */
async function salesWindow() {
  const span = await get('SELECT MIN(date) AS first, MAX(date) AS last FROM sales')
  if (!span?.last) return null
  const to = dayNumber(String(span.last))
  const from = Math.max(dayNumber(String(span.first)), to - (SALES_WEEKS * 7 - 1))
  return { from: isoOf(from), to: isoOf(to), days: to - from + 1 }
}

export async function shoppingList() {
  const today = localTime().date
  const window = await salesWindow()
  const dishes = await all(`SELECT d.id, d.name, d.weekly_portions,
      (SELECT COALESCE(SUM(s.qty), 0) FROM sales s WHERE s.dish_id = d.id AND s.date >= ? AND s.date <= ?) AS sold,
      (SELECT COUNT(*) FROM recipe_lines r WHERE r.dish_id = d.id) AS lines
    FROM dishes d ORDER BY d.name`, window?.from ?? today, window?.to ?? today)
  const perWeek = new Map<number, { portions: number | null; source: 'set' | 'sales' | null }>()
  for (const dish of dishes) {
    const set = dish.weekly_portions === null || dish.weekly_portions === undefined ? null : Number(dish.weekly_portions)
    const fromSales = window && Number(dish.sold) > 0 ? Math.round((Number(dish.sold) * 7) / window.days) : null
    perWeek.set(Number(dish.id), set !== null ? { portions: set, source: 'set' } : fromSales !== null ? { portions: fromSales, source: 'sales' } : { portions: null, source: null })
  }

  const lines = await all(`SELECT r.dish_id, r.qty_base, i.id AS item_id, i.name, i.base_unit, i.case_qty, i.supplier_id, i.category
    FROM recipe_lines r JOIN items i ON i.id = r.item_id`)
  const fromPurchases = await purchaseEstimate(lines, dishes.filter((dish) => Number(dish.lines) > 0).map((dish) => Number(dish.id)))
  const suppliers = await all('SELECT id, name, contact, email, phone, category FROM suppliers ORDER BY name')
  const byCategory = new Map(suppliers.filter((supplier) => supplier.category).map((supplier) => [String(supplier.category), Number(supplier.id)]))

  const items = new Map<number, any>()
  for (const line of lines) {
    const week = perWeek.get(Number(line.dish_id))
    const dishName = String(dishes.find((dish) => Number(dish.id) === Number(line.dish_id))?.name ?? '')
    const item = items.get(Number(line.item_id)) ?? {
      id: Number(line.item_id), name: String(line.name), unit: String(line.base_unit), caseQty: line.case_qty === null ? null : Number(line.case_qty),
      category: line.category ? String(line.category) : guessCategory(String(line.name)), categorySet: !!line.category,
      supplierId: line.supplier_id === null || line.supplier_id === undefined ? null : Number(line.supplier_id), supplierSource: line.supplier_id ? 'set' : null,
      used: 0, dishes: [] as string[], missing: [] as string[],
    }
    items.set(item.id, item)
    if (!item.dishes.includes(dishName)) item.dishes.push(dishName)
    if (week?.portions === null || week?.portions === undefined) { if (!item.missing.includes(dishName)) item.missing.push(dishName); continue }
    item.used += Number(line.qty_base) * week.portions
  }

  const onHand = await stockOnHand()
  for (const item of items.values()) {
    // Who it comes from: the owner's choice, then whoever sold it last, then the supplier for its kind of thing.
    if (item.supplierId === null) {
      const last = await get('SELECT supplier_id FROM price_history WHERE item_id = ? ORDER BY date DESC, id DESC LIMIT 1', item.id)
      if (last?.supplier_id) { item.supplierId = Number(last.supplier_id); item.supplierSource = 'last' }
      else if (byCategory.has(item.category)) { item.supplierId = byCategory.get(item.category); item.supplierSource = 'category' }
    }
    const price = await get('SELECT price_p FROM price_history WHERE item_id = ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1', item.id, today)
      ?? await get('SELECT price_p FROM price_history WHERE item_id = ? ORDER BY date ASC, id ASC LIMIT 1', item.id)
    const need = item.used * (1 + SPARE_PERCENT / 100)
    const held = onHand.get(item.id)
    item.stock = held?.fresh ? held.stock : null
    const order = toOrder(Math.max(0, need - (item.stock ?? 0)), item.unit, item.caseQty)
    item.need = Number(need.toFixed(3))
    item.order = order.quantity
    item.cases = order.cases
    item.pricePence = price ? Number(price.price_p) : null
    item.costPence = price ? Math.round(order.quantity * Number(price.price_p)) : null
  }

  const list = [...items.values()].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name))
  const toBuy = list.filter((item) => item.order > 0)
  const total = (rows: any[]) => ({ pence: rows.reduce((sum, item) => sum + (item.costPence ?? 0), 0), unpriced: rows.filter((item) => item.costPence === null).length })
  return {
    spare: SPARE_PERCENT, salesWeeks: SALES_WEEKS, sales: window, fromPurchases, categories: CATEGORIES,
    dishes: dishes.map((dish) => ({ id: Number(dish.id), name: String(dish.name), hasRecipe: Number(dish.lines) > 0, ...perWeek.get(Number(dish.id))! })),
    items: list,
    total: total(toBuy),
    suppliers: suppliers.map((supplier) => {
      const rows = toBuy.filter((item) => item.supplierId === Number(supplier.id))
      return { id: Number(supplier.id), name: String(supplier.name), contact: supplier.contact, email: supplier.email, phone: supplier.phone, category: supplier.category, items: rows.map((item) => item.id), total: total(rows) }
    }),
    unassigned: toBuy.filter((item) => item.supplierId === null).map((item) => item.id),
  }
}

/**
 * How many of each dish a week the restaurant's own receipts point to. Each ingredient bought per week, less the spare
 * the list adds, is split by the recipes. A dish with an ingredient only it uses is worked out from that first; then
 * what those dishes used comes off the shared ingredients, which settles the next dish, and so on. A dish the receipts
 * can't tell apart from another is left out rather than guessed.
 */
async function purchaseEstimate(lines: Array<Record<string, any>>, dishIds: number[]) {
  const span = await get(`SELECT MIN(date) AS first, MAX(date) AS last FROM invoices WHERE date IS NOT NULL AND status IN ('read', 'needs-review')`)
  if (!span?.last) return null
  const last = dayNumber(String(span.last))
  const first = Math.max(dayNumber(String(span.first)), last - (SALES_WEEKS * 7 - 1))
  // The last delivery feeds the week after it, so the window runs a week past it.
  const days = last - first + 7
  const bought = await all(`SELECT l.item_id, SUM(l.qty_base_milli) AS milli, COUNT(DISTINCT v.id) AS receipts FROM invoice_lines l JOIN invoices v ON v.id = l.invoice_id
    WHERE l.item_id IS NOT NULL AND l.issue IS NULL AND v.date >= ? AND v.date <= ? AND v.status IN ('read', 'needs-review') GROUP BY l.item_id`, isoOf(first), isoOf(last))
  const receipts = Number((await get(`SELECT COUNT(*) AS n FROM invoices WHERE date >= ? AND date <= ? AND status IN ('read', 'needs-review')`, isoOf(first), isoOf(last)))?.n ?? 0)
  const perWeek = new Map(bought.map((row) => [Number(row.item_id), (Number(row.milli) / 1000) * (7 / days) / (1 + SPARE_PERCENT / 100)]))
  const uses = new Map<number, Map<number, number>>()
  for (const line of lines) {
    const item = Number(line.item_id)
    if (!uses.has(item)) uses.set(item, new Map())
    uses.get(item)!.set(Number(line.dish_id), Number(line.qty_base))
  }
  const known = new Map<number, { portions: number; from: string[] }>()
  const names = new Map(lines.map((line) => [Number(line.item_id), String(line.name)]))
  // The first pass uses only ingredients a single dish uses: they are the clearest signal. Later passes share out the rest.
  for (let pass = 0; pass <= dishIds.length; pass += 1) {
    let found = false
    for (const dish of dishIds) {
      if (known.has(dish)) continue
      const guesses: Array<{ value: number; item: number }> = []
      for (const [item, users] of uses) {
        if (!users.has(dish) || !perWeek.has(item)) continue
        if (pass === 0 && users.size !== 1) continue
        const open = [...users.keys()].filter((user) => !known.has(user))
        if (open.length !== 1 || open[0] !== dish) continue
        const left = perWeek.get(item)! - [...users].filter(([user]) => known.has(user)).reduce((sum, [user, qty]) => sum + known.get(user)!.portions * qty, 0)
        guesses.push({ value: Math.max(0, left / users.get(dish)!), item })
      }
      if (!guesses.length) continue
      const sorted = guesses.sort((a, b) => a.value - b.value)
      const middle = sorted[Math.floor((sorted.length - 1) / 2)]
      known.set(dish, { portions: Math.round(middle.value), from: sorted.map((guess) => names.get(guess.item)!).slice(0, 3) })
      found = true
    }
    if (!found && pass > 0) break
  }
  return {
    from: isoOf(first), to: isoOf(last), receipts,
    dishes: dishIds.map((dish) => ({ id: dish, portions: known.get(dish)?.portions ?? null, from: known.get(dish)?.from ?? [] })),
  }
}

/** Every estimate at once, for the button under the list. Dishes the receipts can't settle keep what they have. */
export async function usePurchaseEstimate() {
  const list = await shoppingList()
  for (const dish of list.fromPurchases?.dishes ?? []) {
    if (dish.portions !== null) await run('UPDATE dishes SET weekly_portions = ? WHERE id = ?', dish.portions, dish.id)
  }
  return shoppingList()
}

export async function setWeeklyPortions(dishId: number, value: unknown) {
  const portions = value === null || value === '' ? null : Number(value)
  if (portions !== null && !(Number.isInteger(portions) && portions >= 0 && portions <= 100000)) throw new SetupError('Portions a week has to be a whole number.')
  if (!await get('SELECT id FROM dishes WHERE id = ?', dishId)) throw new SetupError('That dish has gone.')
  await run('UPDATE dishes SET weekly_portions = ? WHERE id = ?', portions, dishId)
}

/** The owner says who sells an ingredient, or what kind of thing it is. Null goes back to the automatic choice. */
export async function setItemSource(itemId: number, input: Record<string, unknown>) {
  if (!await get('SELECT id FROM items WHERE id = ?', itemId)) throw new SetupError('That ingredient has gone.')
  if ('supplierId' in input) {
    const supplierId = input.supplierId === null || input.supplierId === '' ? null : Number(input.supplierId)
    if (supplierId !== null && !await get('SELECT id FROM suppliers WHERE id = ?', supplierId)) throw new SetupError('Choose a supplier.')
    await run('UPDATE items SET supplier_id = ? WHERE id = ?', supplierId, itemId)
  }
  if ('category' in input) {
    const category = input.category === null || input.category === '' ? null : String(input.category)
    if (category !== null && !CATEGORIES.includes(category)) throw new SetupError('Choose what kind of thing it is.')
    await run('UPDATE items SET category = ? WHERE id = ?', category, itemId)
  }
}

const amount = (quantity: number, unit: string) => (unit === 'each' ? `${quantity}` : `${Number(quantity.toFixed(2))} ${unit}`)

/** The order for one supplier as words, ready to email or send. Prices are left out: the supplier sets those. */
export async function orderText(supplierId: number) {
  const list = await shoppingList()
  const supplier = list.suppliers.find((row) => row.id === supplierId)
  if (!supplier) throw new SetupError('That supplier has gone.')
  const restaurant = (await get(`SELECT value FROM settings WHERE key = 'restaurant_name'`))?.value
  const rows = supplier.items.map((id) => list.items.find((item) => item.id === id)!)
  if (!rows.length) throw new SetupError('Nothing on this week\'s list comes from this supplier.')
  const lines = rows.map((item) => `- ${item.name}: ${item.cases ? `${item.cases} x ${amount(item.caseQty, item.unit)} (${amount(item.order, item.unit)})` : amount(item.order, item.unit)}`)
  return {
    to: supplier.email ?? '', subject: `Order${restaurant ? ` from ${restaurant}` : ''}`,
    body: [`Hi ${supplier.contact ?? supplier.name},`, '', 'Could we order the following for this week, please?', '', ...lines, '', 'Please confirm the delivery day and let me know if anything is short.', '', 'Thanks,', restaurant || 'Stockpot'].join('\n'),
  }
}
