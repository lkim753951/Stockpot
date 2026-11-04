import { all, get } from '../core/db.ts'
import { guessCategory } from '../setup/setup.ts'
import { shoppingList } from './shopping.ts'
import { t } from '../core/lang.ts'

/**
 * When staff say something has run out, or a stock check comes in low, the owner shouldn't have to look anything up.
 * This finds the ingredient they meant, who sells it, and about two days' worth, and writes the message to send.
 * Nothing is sent from here: the owner presses the button, and their own WhatsApp or phone does the rest.
 */

const DAYS_TO_COVER = 2
const NOISE = new Set(['of', 'and', 'the', 'a', 'fresh', 'whole', 'ground', 'large', 'small', 'medium'])

const singular = (word: string) =>
  word.length > 4 && /(oes|ches|shes|xes|sses)$/.test(word) ? word.slice(0, -2)
    : word.length > 3 && word.endsWith('ies') ? `${word.slice(0, -3)}y`
      : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
const wordsOf = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map(singular)

/** The saved ingredient a sentence is about. All of its name beats only its last word ("onions" finds Brown onions). */
export async function itemIn(text: string) {
  const said = new Set(wordsOf(text))
  if (!said.size) return null
  let best: { row: Record<string, any>; score: number } | null = null
  for (const row of await all('SELECT id, name, aliases, base_unit, case_qty, supplier_id, category FROM items ORDER BY id')) {
    let aliases: string[] = []
    try { aliases = JSON.parse(String(row.aliases ?? '[]')) } catch { aliases = [] }
    for (const label of [String(row.name), ...aliases]) {
      const name = wordsOf(label).filter((word) => !NOISE.has(word))
      if (!name.length) continue
      const whole = name.every((word) => said.has(word))
      const score = whole ? 100 + name.length : said.has(name[name.length - 1]) ? 10 : 0
      if (score && (!best || score > best.score)) best = { row, score }
    }
  }
  return best?.row ?? null
}

const digits = (phone: unknown) => String(phone ?? '').replace(/[^\d]/g, '').replace(/^0(?=\d{9,10}$)/, '44')
const amount = (quantity: number, unit: string) => (unit === 'each' ? `${quantity}` : `${quantity} ${unit}`)

/** About two days' worth, from the weekly shopping list, so the kitchen gets through to the usual delivery. */
function emergencyQuantity(perWeek: number, unit: string) {
  const need = (perWeek / 7) * DAYS_TO_COVER
  if (need <= 0) return null
  if (unit === 'each') return Math.ceil(need - 1e-9)
  const step = need < 1 ? 0.1 : 0.5
  return Number((Math.ceil(need / step - 1e-9) * step).toFixed(2))
}

export async function emergencyOrder(text: string) {
  const item = await itemIn(text)
  if (!item) return null
  let supplierId = item.supplier_id ? Number(item.supplier_id) : null
  if (!supplierId) supplierId = Number((await get('SELECT supplier_id FROM price_history WHERE item_id = ? ORDER BY date DESC, id DESC LIMIT 1', item.id))?.supplier_id) || null
  if (!supplierId) supplierId = Number((await get('SELECT id FROM suppliers WHERE category = ? ORDER BY id LIMIT 1', item.category ?? guessCategory(String(item.name))))?.id) || null
  const supplier = supplierId ? await get('SELECT id, name, contact, phone, email FROM suppliers WHERE id = ?', supplierId) : null
  const listed = (await shoppingList()).items.find((row: any) => row.id === Number(item.id))
  const quantity = listed ? emergencyQuantity(Number(listed.need), String(item.base_unit)) : null
  const restaurant = (await get(`SELECT value FROM settings WHERE key = 'restaurant_name'`))?.value
  const what = quantity ? `${amount(quantity, String(item.base_unit))} of ${String(item.name).toLowerCase()}` : `some ${String(item.name).toLowerCase()}`
  const message = [
    `Hi ${supplier?.contact ?? supplier?.name ?? 'there'}, it's ${restaurant || 'the restaurant'}.`,
    `We've run out of ${String(item.name).toLowerCase()}. Could you deliver ${what} today, please?`,
    'Let me know when it can get here. Thanks!',
  ].join(' ')
  return {
    item: { id: Number(item.id), name: String(item.name), unit: String(item.base_unit) },
    quantity,
    supplier: supplier ? { id: Number(supplier.id), name: String(supplier.name), phone: supplier.phone ? String(supplier.phone) : null, email: supplier.email ? String(supplier.email) : null } : null,
    message,
  }
}

export interface Response { label: string; href: string; kind: 'whatsapp' | 'call' | 'email' | 'link' }

/**
 * The buttons on a card about a staff report or a low stock check, so a crisis is one press away. Ran out: message or call
 * the supplier with the order written. Staff numbers never reach the browser, so handing a job on goes through the server.
 */
export async function responsesFor(row: Record<string, any>): Promise<{ note: string | null; responses: Response[] } | null> {
  const responses: Response[] = []
  let note: string | null = null
  let text = String(row.title ?? '')
  let stock = row.source_type === 'reading' && /is low:/.test(text)
  if (row.source_type === 'report') {
    const report = await get('SELECT original_text, english_text, category, crisis_key FROM staff_reports WHERE id = ?', Number(row.source_id))
    if (!report) return null
    text = [report.english_text, report.original_text, row.title].filter(Boolean).join(' ')
    stock = !report.crisis_key && (report.category === 'stock' || /\b(ran|run|running) out\b|\bout of\b|\bno more\b|\blow on\b/i.test(text))
  }
  if (row.source_type !== 'report' && !stock) return null

  if (stock) {
    const order = await emergencyOrder(text.replace(/is low:.*$/i, ''))
    if (order?.supplier) {
      note = order.quantity
        ? t('Order {amount} of {item} from {supplier} today', { amount: amount(order.quantity, order.item.unit), item: order.item.name, supplier: order.supplier.name })
        : t('Order {item} from {supplier} today', { item: order.item.name, supplier: order.supplier.name })
      const phone = digits(order.supplier.phone)
      if (phone) responses.push({ kind: 'whatsapp', label: t('WhatsApp {name}', { name: order.supplier.name }), href: `https://wa.me/${phone}?text=${encodeURIComponent(order.message)}` })
      if (phone) responses.push({ kind: 'call', label: t('Call {name}', { name: order.supplier.name }), href: `tel:+${phone}` })
      if (!phone && order.supplier.email) responses.push({ kind: 'email', label: t('Email {name}', { name: order.supplier.name }), href: `mailto:${order.supplier.email}?subject=${encodeURIComponent(`Urgent: ${order.item.name}`)}&body=${encodeURIComponent(order.message)}` })
    } else if (order) {
      note = t('No supplier is set for {item} yet.', { item: order.item.name })
      responses.push({ kind: 'whatsapp', label: t('WhatsApp a supplier'), href: `https://wa.me/?text=${encodeURIComponent(order.message)}` })
      responses.push({ kind: 'link', label: t('Set a supplier'), href: '#/shopping' })
    }
  }

  return responses.length || note ? { note, responses } : null
}
