import { all, get, insert, run } from '../core/db.ts'
import { sparkJson } from '../ai/meta.ts'
import { densityPrompt, densitySchema, type ExtractedDensity } from '../ai/prompts.ts'
import { CATEGORIES, guessCategory, SetupError } from '../setup/setup.ts'
import { isDensity, isPack, litresOf, PACKS } from '../../shared/stock.ts'

/**
 * Stock counts. Staff and the owner count in containers, boxes and crates, and code turns that into litres. A kilo figure
 * is litres times the ingredient's density, worked out when it's read, so correcting a density corrects every count.
 */

/** A count older than this says nothing about this week, so the shopping list stops relying on it. */
export const STOCK_FRESH_DAYS = 7
const DAY_MS = 86400000
const MOST_AT_ONCE = 40

const clean = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120)

function reading(row: Record<string, any>) {
  const unit = String(row.base_unit)
  const density = row.density_kg_l === null || row.density_kg_l === undefined ? null : Number(row.density_kg_l)
  if (row.count_id === null || row.count_id === undefined) return { count: null, litres: null, stock: null, kg: null, fresh: false }
  const count = Number(row.count_value)
  const pack = String(row.pack)
  const litres = isPack(pack) ? litresOf(count, pack) : unit === 'l' ? count : null
  const kg = unit === 'kg' && !isPack(pack) ? count : litres !== null && density !== null ? litres * density : null
  const stock = unit === 'each' ? count : unit === 'l' ? litres : kg
  const round = (value: number | null) => (value === null ? null : Number(value.toFixed(3)))
  return {
    count: { value: count, pack, by: String(row.counted_by), at: String(row.counted_at) },
    litres: round(litres), stock: round(stock), kg: unit === 'each' ? null : round(kg),
    fresh: Date.now() - Date.parse(String(row.counted_at)) < STOCK_FRESH_DAYS * DAY_MS,
  }
}

const ITEMS_WITH_LATEST_COUNT = `SELECT i.id, i.name, i.base_unit, i.category, i.density_kg_l, i.density_source,
    c.id AS count_id, c.count_value, c.pack, c.counted_by, c.counted_at
  FROM items i LEFT JOIN stock_counts c ON c.id = (SELECT MAX(s.id) FROM stock_counts s WHERE s.item_id = i.id)`

/** What each ingredient's latest count comes to, in the unit the recipes use. */
export async function stockOnHand() {
  const rows = await all(ITEMS_WITH_LATEST_COUNT)
  return new Map(rows.map((row) => [Number(row.id), reading(row)]))
}

export async function stockView() {
  const rows = await all(`${ITEMS_WITH_LATEST_COUNT} ORDER BY i.name`)
  const items = rows.map((row) => ({
    id: Number(row.id), name: String(row.name), unit: String(row.base_unit),
    category: row.category ? String(row.category) : guessCategory(String(row.name)),
    density: row.density_kg_l === null || row.density_kg_l === undefined ? null : Number(row.density_kg_l),
    densitySource: row.density_source ? String(row.density_source) : null,
    ...reading(row),
  })).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))
  return { packs: PACKS, freshDays: STOCK_FRESH_DAYS, items }
}

export async function saveStockCount(itemId: number, input: Record<string, unknown>, by: string) {
  const item = await get('SELECT id, base_unit FROM items WHERE id = ?', itemId)
  if (!item) throw new SetupError('That ingredient has gone.')
  const raw = input.count
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(count) || count < 0 || count > 100000) throw new SetupError('Enter how many you counted.')
  const pack = input.pack === 'unit' || isPack(input.pack) ? input.pack : null
  if (!pack) throw new SetupError('Tick container, box or crate.')
  if (item.base_unit === 'each' && pack !== 'unit') throw new SetupError('This ingredient is counted one at a time.')
  await insert('INSERT INTO stock_counts (item_id, count_value, pack, counted_by, counted_at) VALUES (?, ?, ?, ?, ?)',
    itemId, count, pack, by, new Date().toISOString())
}

/** The owner's own figure always wins. Clearing it lets Stockpot estimate again. */
export async function setDensity(itemId: number, value: unknown) {
  if (!await get('SELECT id FROM items WHERE id = ?', itemId)) throw new SetupError('That ingredient has gone.')
  if (value === null || value === '') return void await run('UPDATE items SET density_kg_l = NULL, density_source = NULL WHERE id = ?', itemId)
  const density = Number(value)
  if (!isDensity(density)) throw new SetupError('Density has to be between 0.02 and 2 kg a litre.')
  await run(`UPDATE items SET density_kg_l = ?, density_source = 'set' WHERE id = ?`, density, itemId)
}

/**
 * Muse Spark estimates how heavy a litre of each ingredient is, once per ingredient. It's the only guess in this feature:
 * it's marked as an estimate, a figure outside what a food can weigh is thrown away, and it never replaces the owner's.
 */
export async function estimateDensities(itemId?: number) {
  const rows = (await all(`SELECT id, name FROM items WHERE density_kg_l IS NULL AND base_unit <> 'each'${itemId ? ' AND id = ?' : ''} ORDER BY name LIMIT ${MOST_AT_ONCE}`, ...(itemId ? [itemId] : [])))
    .map((row) => ({ id: Number(row.id), name: clean(row.name) }))
  if (!rows.length) return 0
  const answer = await sparkJson<ExtractedDensity>({
    name: 'ingredient_density', schema: densitySchema, system: densityPrompt, effort: 'low', timeoutMs: 60000,
    content: [{ type: 'text', text: `Ingredients:\n${rows.map((row, index) => `${index + 1}. ${row.name}`).join('\n')}` }],
  }).catch((error) => {
    console.error('density:', (error as Error).message)
    throw new SetupError("Stockpot couldn't estimate that just now. The count is still saved in litres.")
  })
  const key = (text: string) => text.trim().toLowerCase()
  let saved = 0
  for (const [index, row] of rows.entries()) {
    const guess = answer.densities.find((line) => key(line.name) === key(row.name)) ?? (answer.densities.length === rows.length ? answer.densities[index] : null)
    if (!isDensity(guess?.kg_per_litre)) continue
    saved += (await run(`UPDATE items SET density_kg_l = ?, density_source = 'ai' WHERE id = ? AND density_kg_l IS NULL`, guess.kg_per_litre, row.id)).changes
  }
  return saved
}
