import { CALL_LANGUAGES } from '../../shared/lang.ts'
import { all, get, insert, priceOn, run, saveSetting, setting, transaction } from '../core/db.ts'
import { config } from '../core/config.ts'
import { localTime } from '../core/clock.ts'
import { nameKey } from '../core/parsing.ts'
import { proofTargetFor } from '../money/proof.ts'
import { EARLIEST_CHASE } from '../operations/chase.ts'
import { cleanSchedule, frequencyOf, scheduleFor, type Schedule } from '../core/schedule.ts'
import { marginPercent, prepPerPortion, priceForMargin } from '../../shared/costing.ts'

/** Everything the owner adds about their own restaurant: suppliers, the menu and their checklists. */

/** A rule the owner can fix. Values fill the {marks}, so the browser can translate the sentence and still name the ingredient. */
export class SetupError extends Error {
  constructor(readonly sentence: string, readonly values?: Record<string, string | number>) {
    super(Object.entries(values ?? {}).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), sentence))
  }
}

const text = (value: unknown, limit = 120) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')

/** What a supplier sells, and what an ingredient is. The shopping list groups by these. */
export const CATEGORIES = ['Veg and fruit', 'Meat and fish', 'Dairy', 'Spices and dry goods', 'Drinks', 'Other']

/** A first guess at what an ingredient is, from its name. The owner can change it, and their choice is kept. */
const GUESSES: Array<[string, RegExp]> = [
  ['Meat and fish', /chicken|beef|lamb|pork|mince|bacon|sausage|duck|turkey|fish|salmon|cod|haddock|prawn|shrimp|tuna|thigh|breast|steak/i],
  ['Dairy', /milk|cream|butter|cheese|yog(h)?urt|paneer|ghee|egg|feta|halloumi|mozzarella/i],
  ['Spices and dry goods', /spice|cumin|turmeric|coriander seed|garam|masala|paprika|chilli powder|pepper|salt|cinnamon|cardamom|clove|bay lea|rice|lentil|dal|chickpea|bean|flour|pasta|noodle|sugar|oil|vinegar|stock|tinned|tin|coconut milk|sauce|nut|seed/i],
  ['Drinks', /juice|soda|cola|water|beer|wine|tea|coffee|lassi/i],
  ['Veg and fruit', /onion|tomato|potato|carrot|garlic|ginger|chilli|pepper|spinach|lettuce|cabbage|mushroom|aubergine|courgette|leek|celery|coriander|parsley|mint|basil|herb|lemon|lime|apple|mango|banana|berry|veg|fruit|cucumber|pea|kale|squash/i],
]
export const guessCategory = (name: string) => GUESSES.find(([, pattern]) => pattern.test(name))?.[0] ?? 'Other'

export const listSuppliers = () => all('SELECT id, name, contact, email, phone, category FROM suppliers ORDER BY name')

export async function saveSupplier(input: Record<string, unknown>, id?: number) {
  const name = text(input.name)
  const email = text(input.email)
  if (!name) throw new SetupError('Add the supplier name.')
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SetupError('That email address looks wrong.')
  const clash = await get('SELECT id FROM suppliers WHERE name = ? AND id != ?', name, id ?? 0)
  if (clash) throw new SetupError('You already have a supplier with that name.')
  const category = CATEGORIES.includes(String(input.category)) ? String(input.category) : null
  const values = [name, text(input.contact) || null, email || null, text(input.phone, 30) || null, category]
  if (id) {
    await run('UPDATE suppliers SET name = ?, contact = ?, email = ?, phone = ?, category = ? WHERE id = ?', ...values, id)
    return id
  }
  return insert('INSERT INTO suppliers (name, contact, email, phone, category) VALUES (?, ?, ?, ?, ?)', ...values)
}

export async function deleteSupplier(id: number) {
  const used = await get(`SELECT (SELECT COUNT(*) FROM calls WHERE supplier_id = ?) + (SELECT COUNT(*) FROM orders WHERE supplier_id = ?)
                    + (SELECT COUNT(*) FROM invoices WHERE supplier_id = ?) + (SELECT COUNT(*) FROM price_history WHERE supplier_id = ?) AS total`, id, id, id, id)
  if (Number(used?.total)) throw new SetupError('This supplier has calls or invoices, so it stays on your records.')
  await run('DELETE FROM suppliers WHERE id = ?', id)
}

export const TO_BASE: Record<string, { base: string; factor: number }> = {
  g: { base: 'kg', factor: 0.001 }, kg: { base: 'kg', factor: 1 }, ml: { base: 'l', factor: 0.001 }, l: { base: 'l', factor: 1 }, each: { base: 'each', factor: 1 },
}

/** Finds a saved item by its name or an alias, then by the words before a comma, then without a plural s. */
export async function itemMatcher() {
  const items = await all('SELECT id, name, base_unit, case_qty, aliases FROM items')
  const names = new Map(items.flatMap((item) => [item.name, ...JSON.parse(String(item.aliases ?? '[]'))].map((label) => [nameKey(String(label)), item] as const)))
  return (name: string) => {
    const key = nameKey(name)
    return names.get(key) ?? names.get(nameKey(name.split(',')[0])) ?? names.get(key.replace(/e?s$/, '')) ?? names.get(`${key}s`) ?? null
  }
}

/** The units the owner can pick for an ingredient, by how it is saved. */
export const UNITS_FOR: Record<string, string> = { kg: 'g / kg', l: 'ml / l', each: 'each' }

/** Says which unit to pick, instead of naming the saved unit the owner never sees. */
export function unitClash(name: string, saved: string, given: string) {
  const values = { name, units: UNITS_FOR[saved] ?? saved, given, clash: name, to: TO_BASE[given]?.base ?? given }
  if (saved === 'each') return new SetupError('{name} is counted one at a time in your stock, but this recipe gives it in {given}. Change its unit to each.', values)
  if (saved === 'kg') return new SetupError('{name} is weighed in your stock, but this recipe gives it in {given}. Change its unit to {units}.', values)
  return new SetupError('{name} is measured by volume in your stock, but this recipe gives it in {given}. Change its unit to {units}.', values)
}

/**
 * One ingredient is measured one way, so its prices and recipes add up. A unit picked up from a single call or invoice
 * can be wrong, so the owner may change it until the ingredient has a price: after that, prices in the old unit would mislead.
 */
export async function changeItemUnit(name: string, unit: string) {
  const known = (await itemMatcher())(text(name))
  const base = TO_BASE[unit]?.base
  if (!known || !base) throw new SetupError('Choose a unit for {name}.', { name: text(name) })
  if (known.base_unit === base) return
  if (await get('SELECT 1 AS priced FROM price_history WHERE item_id = ? LIMIT 1', known.id)) {
    throw new SetupError('{name} already has prices in {units}, so it stays that way. Change the recipe to {units}.', { name: String(known.name), units: UNITS_FOR[String(known.base_unit)] ?? String(known.base_unit) })
  }
  await run('UPDATE items SET base_unit = ? WHERE id = ?', base, known.id)
}

export async function itemFor(name: string, unit: string) {
  const known = (await itemMatcher())(name)
  const { base, factor } = TO_BASE[unit] ?? TO_BASE.each
  if (known && known.base_unit !== base) throw unitClash(String(known.name), String(known.base_unit), unit)
  return { id: known ? Number(known.id) : await insert('INSERT INTO items (name, base_unit) VALUES (?, ?)', name, base), factor }
}

/** Every dish with its full costing. This uses the Dashboard's price rule for today, so the two screens agree. */
export async function listDishes() {
  const today = localTime().date
  return await Promise.all((await all(`SELECT id, name, price_p AS pricePence, target_margin AS targetMargin, method, photo_file AS photo, portions,
      prep_minutes AS prepMinutes, service_minutes AS serviceMinutes, recipe_file AS recipeFile, recipe_file_name AS recipeFileName FROM dishes ORDER BY name`)).map(async (dish) => {
    const lines = await all(`SELECT r.qty_base, i.name, i.base_unit, ${priceOn('?')} AS price_p, ${priceOn('?', 'date')} AS price_date
      FROM recipe_lines r JOIN items i ON i.id = r.item_id WHERE r.dish_id = ? ORDER BY i.name`, today, today, dish.id)
    const costs = lines.map((line) => (line.price_p === null ? null : Number(line.qty_base) * Number(line.price_p)))
    const known = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
    const complete = lines.length > 0 && costs.every((cost) => cost !== null)
    return {
      ...dish,
      costPence: complete ? Math.round(known) : null,
      /** Unrounded, because the Dashboard's margin isn't worked out from a rounded cost. */
      exactCostPence: complete ? known : null,
      knownCostPence: Math.round(known),
      marginPercent: complete ? marginPercent(Number(dish.pricePence), known) : null,
      pricePenceForTarget: complete ? priceForMargin(known, Number(dish.targetMargin)) : null,
      prepPerPortion: prepPerPortion(dish.prepMinutes, dish.portions),
      unpriced: lines.filter((line) => line.price_p === null).map((line) => line.name),
      lines: lines.map((line, index) => ({
        name: line.name, quantity: Number(line.qty_base), unit: line.base_unit,
        pricePence: line.price_p === null ? null : Number(line.price_p), priceDate: line.price_date ?? null, costPence: costs[index],
        sharePercent: complete && known > 0 ? Math.round((costs[index]! / known) * 1000) / 10 : null,
      })),
    }
  }))
}

/** A number the owner may leave empty. Null clears it, and missing leaves the saved one alone. */
function optionalWhole(value: unknown, most: number, message: string) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const number = Number(value)
  if (!(Number.isInteger(number) && number > 0 && number <= most)) throw new SetupError(message)
  return number
}

export async function saveDish(input: Record<string, any>, id?: number) {
  const name = text(input.name)
  const pricePence = Math.round(Number(input.pricePence))
  const targetMargin = Math.round(Number(input.targetMargin ?? 70))
  if (!name) throw new SetupError('Add the dish name.')
  if (!(pricePence > 0)) throw new SetupError('Add the menu price.')
  if (!(targetMargin >= 0 && targetMargin <= 100)) throw new SetupError('The target margin has to be between 0 and 100.')
  const portions = optionalWhole(input.portions, 1000, 'Portions has to be a whole number.')
  const prep = optionalWhole(input.prepMinutes, 10080, 'Prep time has to be a whole number of minutes.')
  const service = optionalWhole(input.serviceMinutes, 1440, 'Service time has to be a whole number of minutes.')
  const lines = (Array.isArray(input.lines) ? input.lines : []).filter((line: any) => text(line?.name))
  for (const line of lines) {
    if (!(Number(line.quantity) > 0)) throw new SetupError('Add a quantity for {name}.', { name: text(line.name) })
    if (line.unit !== undefined && line.unit !== null && !(line.unit in TO_BASE)) throw new SetupError('Choose a unit for {name}.', { name: text(line.name) })
  }
  const method = text(input.method, 8000) || null
  return transaction(async () => {
    // One at a time: two lines can name the same new ingredient, and only the first should add it.
    const resolved: Array<{ item: { id: number; factor: number }; quantity: number }> = []
    for (const line of lines) resolved.push({ item: await itemFor(text(line.name), String(line.unit ?? 'each')), quantity: Number(line.quantity) })
    const dishId = id ?? await insert('INSERT INTO dishes (name, price_p, target_margin, method) VALUES (?, ?, ?, ?)', name, pricePence, targetMargin, method)
    if (id) await run('UPDATE dishes SET name = ?, price_p = ?, target_margin = ?, method = ? WHERE id = ?', name, pricePence, targetMargin, method, id)
    if (portions !== undefined) await run('UPDATE dishes SET portions = ? WHERE id = ?', portions, dishId)
    if (prep !== undefined) await run('UPDATE dishes SET prep_minutes = ? WHERE id = ?', prep, dishId)
    if (service !== undefined) await run('UPDATE dishes SET service_minutes = ? WHERE id = ?', service, dishId)
    await run('DELETE FROM recipe_lines WHERE dish_id = ?', dishId)
    for (const { item, quantity } of resolved) {
      await run(`INSERT INTO recipe_lines (dish_id, item_id, qty_base) VALUES (?, ?, ?)
           ON CONFLICT (dish_id, item_id) DO UPDATE SET qty_base = recipe_lines.qty_base + excluded.qty_base`, dishId, item.id, quantity * item.factor)
    }
    return dishId
  })
}

/**
 * Saved amounts are for one portion, so a new number of portions rescales them. A recipe with none
 * set counts as one portion, which turns whole-batch amounts from a file into the amount for one.
 */
export async function setDishPortions(id: number, value: unknown) {
  const portions = optionalWhole(value, 1000, 'Portions has to be a whole number.')
  if (!portions) throw new SetupError('Portions has to be a whole number.')
  await transaction(async () => {
    const dish = await get('SELECT portions FROM dishes WHERE id = ?', id)
    if (!dish) throw new SetupError('That dish has gone.')
    const before = Number(dish.portions) || 1
    await run('UPDATE recipe_lines SET qty_base = qty_base * ? / ? WHERE dish_id = ?', before, portions, id)
    await run('UPDATE dishes SET portions = ? WHERE id = ?', portions, id)
  })
}

/** A recipe sheet can print its costing beside the method, so anything about money is taken out before staff see it. */
const ABOUT_MONEY = /£|\bGBP\b|\b\d+(?:\.\d+)?\s?p\b|\b(?:cost|costs|costing|costed|price|prices|priced|margin|margins|gp|sell(?:s|ing)? (?:at|for))\b/i

export const stepsOf = (method: unknown) => String(method ?? '').split(/\r?\n/).map((line) => line.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean)

/** What staff need to cook it: no prices, costs or margins ever leave in here. */
export async function staffRecipes() {
  return await Promise.all((await all('SELECT id, name, method, photo_file AS photo, portions, prep_minutes AS prepMinutes, service_minutes AS serviceMinutes FROM dishes ORDER BY name')).map(async (dish) => {
    const steps = stepsOf(dish.method).filter((step) => !ABOUT_MONEY.test(step))
    return {
      ...dish, method: steps.join('\n') || null, steps, prepPerPortion: prepPerPortion(dish.prepMinutes, dish.portions),
      lines: (await all('SELECT r.qty_base, i.name, i.base_unit FROM recipe_lines r JOIN items i ON i.id = r.item_id WHERE r.dish_id = ? ORDER BY i.name', dish.id))
        .map((line) => ({ name: String(line.name).replace(/\s*[(,]?\s*£[\d.,]+[^,)]*\)?/g, '').trim(), quantity: Number(line.qty_base), unit: line.base_unit })),
    }
  }))
}

export async function deleteDish(id: number) {
  if (await get('SELECT 1 AS used FROM sales WHERE dish_id = ? LIMIT 1', id)) throw new SetupError('This dish has sales, so it stays on your records. Change its name or price instead.')
  await run('DELETE FROM recipe_lines WHERE dish_id = ?', id)
  await run('DELETE FROM dishes WHERE id = ?', id)
}

export async function listChecklists() {
  return await Promise.all((await all('SELECT id, name, frequency, due_time AS dueTime, schedule, assignee, chase_after AS chaseAfter, call_who AS callWho, language FROM checklist_templates WHERE retired = 0 ORDER BY due_time')).map(async (template) => ({
    ...template, schedule: scheduleFor(template) ?? fromFrequency(String(template.frequency)),
    items: (await all(`SELECT id, label, check_type AS type, unit, min_value AS min, max_value AS max, proof, proof_hint AS proofHint
                FROM checklist_items WHERE template_id = ? AND retired = 0 ORDER BY position`, template.id)).map((item) => ({ ...item, proof: !!item.proof })),
  })))
}

/** Lists from before schedules existed. */
function fromFrequency(frequency: string): Schedule {
  if (frequency === 'daily') return { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6] }
  return frequency === 'weekly' ? { kind: 'days', days: [5] } : { kind: 'monthly', rules: [{ week: 4, day: 5 }] }
}

const UNITS: Record<string, string | null> = { tick: null, temperature: '°C', stock: 'kg' }
const reading = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value))

export async function saveChecklist(input: Record<string, any>, id?: number) {
  const name = text(input.name)
  const schedule = cleanSchedule(input.schedule)
  const dueTime = String(input.dueTime ?? '')
  if (!name) throw new SetupError('Give the checklist a name.')
  if (!schedule) throw new SetupError('Choose when it runs.')
  const frequency = frequencyOf(schedule)
  const assignee = text(input.assignee) || null
  const chaseAfter = input.chaseAfter === null || input.chaseAfter === undefined || input.chaseAfter === '' ? null : Number(input.chaseAfter)
  if (chaseAfter !== null && !(chaseAfter >= EARLIEST_CHASE && chaseAfter <= 720)) throw new SetupError('Choose when to chase.')
  const callWho = chaseAfter !== null && ['assignee', 'owner'].includes(input.callWho) ? String(input.callWho) : null
  const language = CALL_LANGUAGES.includes(input.language) ? String(input.language) : null
  if (!/^\d{2}:\d{2}$/.test(dueTime)) throw new SetupError('Choose a due time.')
  const items = (Array.isArray(input.items) ? input.items : []).filter((item: any) => text(item?.label))
  if (!items.length) throw new SetupError('Add at least one check.')
  for (const item of items) {
    if (!(String(item.type) in UNITS)) throw new SetupError('Choose a kind of check.')
    if ([reading(item.min), reading(item.max)].some((value) => value !== null && !Number.isFinite(value))) throw new SetupError(`The range for ${text(item.label)} has to be a number.`)
  }
  // A retired list keeps its old records and its old name stays free.
  await run(`UPDATE checklist_templates SET name = name || ' (old ' || id || ')' WHERE name = ? AND retired = 1`, name)
  if (await get('SELECT id FROM checklist_templates WHERE name = ? AND id != ?', name, id ?? 0)) throw new SetupError('You already have a checklist with that name.')
  const fields = [name, frequency, dueTime, JSON.stringify(schedule), assignee, chaseAfter, callWho, language]
  const templateId = id ?? await insert('INSERT INTO checklist_templates (name, frequency, due_time, schedule, assignee, chase_after, call_who, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...fields)
  if (id) await run('UPDATE checklist_templates SET name = ?, frequency = ?, due_time = ?, schedule = ?, assignee = ?, chase_after = ?, call_who = ?, language = ? WHERE id = ?', ...fields, id)
  const kept = new Set<number>()
  for (const [position, item] of items.entries()) {
    const label = text(item.label)
    const proof = item.proof ? 1 : 0
    const hint = text(item.proofHint, 200) || null
    const existing = item.id ? await get('SELECT * FROM checklist_items WHERE id = ? AND template_id = ?', Number(item.id), templateId) : undefined
    const sameProof = existing && existing.label === label && existing.proof_hint === hint
    const target = sameProof ? ((existing.proof_target as string | null) ?? null) : proof ? await proofTargetFor(label, hint) : null
    const unit = item.type === 'tick' ? null : text(item.unit, 10) || UNITS[item.type]
    const values = [position, label, item.type, unit, reading(item.min), reading(item.max), proof, hint, target]
    if (existing) {
      await run('UPDATE checklist_items SET position = ?, label = ?, check_type = ?, unit = ?, min_value = ?, max_value = ?, proof = ?, proof_hint = ?, proof_target = ? WHERE id = ?', ...values, existing.id)
      kept.add(Number(existing.id))
    } else {
      kept.add(await insert('INSERT INTO checklist_items (template_id, position, label, check_type, unit, min_value, max_value, proof, proof_hint, proof_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', templateId, ...values))
    }
  }
  // Past readings are food safety records, so a removed check is hidden rather than deleted.
  for (const row of await all('SELECT id FROM checklist_items WHERE template_id = ? AND retired = 0', templateId)) {
    if (!kept.has(Number(row.id))) await run('UPDATE checklist_items SET retired = 1 WHERE id = ?', row.id)
  }
  return templateId
}

export async function retireChecklist(id: number) {
  await run('UPDATE checklist_templates SET retired = 1 WHERE id = ?', id)
}

export const restaurantName = async () => await setting('restaurant_name') ?? ''

export async function saveRestaurant(name: unknown) {
  await saveSetting('restaurant_name', text(name) || null)
}

/** The fictional sample restaurant uses .example email addresses, so real suppliers never match. */
export const hasSampleData = async () => !!await get(`SELECT id FROM suppliers WHERE email LIKE '%.example' LIMIT 1`)

/** What a new owner has left to do. It disappears from Home once it's all done. */
export async function setupSteps() {
  const count = async (sql: string) => Number((await get(sql))?.total ?? 0)
  return [
    { key: 'suppliers', label: 'Add your suppliers', href: '#/settings/suppliers', done: await count('SELECT COUNT(*) AS total FROM suppliers') > 0 },
    { key: 'menu', label: 'Add your menu', href: '#/settings/menu', done: await count('SELECT COUNT(*) AS total FROM recipe_lines') > 0 },
    { key: 'checklists', label: 'Check your checklists', href: '#/settings/checklists', done: !!await setting('checklists_seen') || await count('SELECT COUNT(*) AS total FROM checklist_templates WHERE retired = 0') > 5 },
    { key: 'sales', label: 'Import your sales', href: '#/settings/sales', done: await count('SELECT COUNT(*) AS total FROM sales') > 0 },
    { key: 'team', label: 'Invite your team', href: '#/settings/team', done: config.whatsapp.staff.length > 0 },
    { key: 'gmail', label: 'Sign in with Google', href: '#/connections', done: !!await setting('google_email') },
  ]
}

