import { all, get, insert, nowIso, run, saveSetting, setting } from './db.ts'
import { config } from './config.ts'
import { sparkJson } from './meta.ts'
import { documentPart } from './documents.ts'
import { proofTargetFor } from './proof.ts'
import { EARLIEST_CHASE } from './chase.ts'
import { cleanSchedule, frequencyOf, scheduleFor, type Schedule } from './schedule.ts'
import { menuPrompt, menuSchema, type ExtractedMenu } from './prompts.ts'

/** Everything the owner adds about their own restaurant: suppliers, the menu and their checklists. */

export class SetupError extends Error {}

const text = (value: unknown, limit = 120) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')

export const listSuppliers = () => all('SELECT id, name, contact, email, phone FROM suppliers ORDER BY name')

export async function saveSupplier(input: Record<string, unknown>, id?: number) {
  const name = text(input.name)
  const email = text(input.email)
  if (!name) throw new SetupError('Add the supplier name.')
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SetupError('That email address looks wrong.')
  const clash = await get('SELECT id FROM suppliers WHERE name = ? AND id != ?', name, id ?? 0)
  if (clash) throw new SetupError('You already have a supplier with that name.')
  const values = [name, text(input.contact) || null, email || null, text(input.phone, 30) || null]
  if (id) {
    await run('UPDATE suppliers SET name = ?, contact = ?, email = ?, phone = ? WHERE id = ?', ...values, id)
    return id
  }
  return insert('INSERT INTO suppliers (name, contact, email, phone) VALUES (?, ?, ?, ?)', ...values)
}

export async function deleteSupplier(id: number) {
  const used = await get(`SELECT (SELECT COUNT(*) FROM calls WHERE supplier_id = ?) + (SELECT COUNT(*) FROM orders WHERE supplier_id = ?)
                    + (SELECT COUNT(*) FROM invoices WHERE supplier_id = ?) + (SELECT COUNT(*) FROM price_history WHERE supplier_id = ?) AS total`, id, id, id, id)
  if (Number(used?.total)) throw new SetupError('This supplier has calls or invoices, so it stays on your records.')
  await run('DELETE FROM suppliers WHERE id = ?', id)
}

const TO_BASE: Record<string, { base: string; factor: number }> = {
  g: { base: 'kg', factor: 0.001 }, kg: { base: 'kg', factor: 1 }, ml: { base: 'l', factor: 0.001 }, l: { base: 'l', factor: 1 }, each: { base: 'each', factor: 1 },
}

export async function itemFor(name: string, unit: string) {
  const known = await get('SELECT id, base_unit FROM items WHERE lower(name) = lower(?)', name)
  const { base, factor } = TO_BASE[unit] ?? TO_BASE.each
  if (known && known.base_unit !== base) throw new SetupError(`${known.base_unit === 'each' ? 'Count' : `Weigh or measure`} ${name} the way it is saved, in ${known.base_unit}.`)
  return { id: known ? Number(known.id) : await insert('INSERT INTO items (name, base_unit) VALUES (?, ?)', name, base), factor }
}

const latestPrice = async (itemId: unknown) => (await get('SELECT price_p FROM price_history WHERE item_id = ? ORDER BY date DESC, id DESC LIMIT 1', itemId))?.price_p as number | undefined

export async function listDishes() {
  return await Promise.all((await all('SELECT id, name, price_p AS pricePence, target_margin AS targetMargin, method, photo_file AS photo FROM dishes ORDER BY name')).map(async (dish) => {
    const lines = await all(`SELECT r.item_id, r.qty_base, i.name, i.base_unit FROM recipe_lines r JOIN items i ON i.id = r.item_id WHERE r.dish_id = ? ORDER BY i.name`, dish.id)
    const priced = await Promise.all(lines.map(async (line) => ({ line, price: await latestPrice(line.item_id) })))
    const complete = lines.length > 0 && priced.every(({ price }) => price !== undefined)
    const costPence = complete ? Math.round(priced.reduce((sum, { line, price }) => sum + Number(line.qty_base) * price!, 0)) : null
    return {
      ...dish, costPence, unpriced: priced.filter(({ price }) => price === undefined).map(({ line }) => line.name),
      lines: lines.map((line) => ({ name: line.name, quantity: Number(line.qty_base), unit: line.base_unit })),
    }
  }))
}

export async function saveDish(input: Record<string, any>, id?: number) {
  const name = text(input.name)
  const pricePence = Math.round(Number(input.pricePence))
  const targetMargin = Math.round(Number(input.targetMargin ?? 70))
  if (!name) throw new SetupError('Add the dish name.')
  if (!(pricePence > 0)) throw new SetupError('Add the menu price.')
  if (!(targetMargin >= 0 && targetMargin <= 100)) throw new SetupError('The target margin has to be between 0 and 100.')
  const lines = (Array.isArray(input.lines) ? input.lines : []).filter((line: any) => text(line?.name))
  for (const line of lines) if (!(Number(line.quantity) > 0)) throw new SetupError(`Add a quantity for ${text(line.name)}.`)
  // One at a time: two lines can name the same new ingredient, and only the first should add it.
  const resolved: Array<{ item: { id: number; factor: number }; quantity: number }> = []
  for (const line of lines) resolved.push({ item: await itemFor(text(line.name), String(line.unit ?? 'each')), quantity: Number(line.quantity) })
  const method = text(input.method, 4000) || null
  const dishId = id ?? await insert('INSERT INTO dishes (name, price_p, target_margin, method) VALUES (?, ?, ?, ?)', name, pricePence, targetMargin, method)
  if (id) await run('UPDATE dishes SET name = ?, price_p = ?, target_margin = ?, method = ? WHERE id = ?', name, pricePence, targetMargin, method, id)
  await run('DELETE FROM recipe_lines WHERE dish_id = ?', dishId)
  for (const { item, quantity } of resolved) {
    await run(`INSERT INTO recipe_lines (dish_id, item_id, qty_base) VALUES (?, ?, ?)
         ON CONFLICT (dish_id, item_id) DO UPDATE SET qty_base = recipe_lines.qty_base + excluded.qty_base`, dishId, item.id, quantity * item.factor)
  }
  return dishId
}

/** What staff need to cook it: no prices, costs or margins ever leave in here. */
export async function staffRecipes() {
  return await Promise.all((await all('SELECT id, name, method, photo_file AS photo FROM dishes ORDER BY name')).map(async (dish) => ({
    ...dish,
    lines: (await all('SELECT r.qty_base, i.name, i.base_unit FROM recipe_lines r JOIN items i ON i.id = r.item_id WHERE r.dish_id = ? ORDER BY i.name', dish.id))
      .map((line) => ({ name: line.name, quantity: Number(line.qty_base), unit: line.base_unit })),
  })))
}

export async function deleteDish(id: number) {
  if (await get('SELECT 1 AS used FROM sales WHERE dish_id = ? LIMIT 1', id)) throw new SetupError('This dish has sales, so it stays on your records. Change its name or price instead.')
  await run('DELETE FROM recipe_lines WHERE dish_id = ?', id)
  await run('DELETE FROM dishes WHERE id = ?', id)
}

/** Reads a menu or recipe sheet. Nothing is saved until the owner has checked it. */
export async function readMenu(file: string, name: string) {
  const menu = await sparkJson<ExtractedMenu>({
    name: 'menu', schema: menuSchema, system: menuPrompt, effort: 'medium', timeoutMs: 90000,
    content: [{ type: 'text', text: `File name: ${name}` }, await documentPart(file, name)],
  })
  return menu.dishes.slice(0, 80).map((dish) => ({
    name: dish.name.slice(0, 120), pricePence: dish.price_pence,
    lines: dish.ingredients.slice(0, 30).map((line) => ({ name: line.name.slice(0, 120), quantity: line.quantity, unit: line.unit ?? 'g' })),
  }))
}

export async function listChecklists() {
  return await Promise.all((await all('SELECT id, name, frequency, due_time AS dueTime, schedule, assignee, chase_after AS chaseAfter, call_who AS callWho FROM checklist_templates WHERE retired = 0 ORDER BY due_time')).map(async (template) => ({
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
  const fields = [name, frequency, dueTime, JSON.stringify(schedule), assignee, chaseAfter, callWho]
  const templateId = id ?? await insert('INSERT INTO checklist_templates (name, frequency, due_time, schedule, assignee, chase_after, call_who) VALUES (?, ?, ?, ?, ?, ?, ?)', ...fields)
  if (id) await run('UPDATE checklist_templates SET name = ?, frequency = ?, due_time = ?, schedule = ?, assignee = ?, chase_after = ?, call_who = ? WHERE id = ?', ...fields, id)
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

