import { background } from '../core/background.ts'
import { all, get, insert, nowIso, run, saveSetting, setting, transaction } from '../core/db.ts'
import { localTime } from '../core/clock.ts'
import { sparkJson } from '../ai/meta.ts'
import { supplierReplyPrompt, supplierReplySchema, type SupplierReply } from '../ai/prompts.ts'
import { formatPounds } from '../money/money.ts'
import { dialable } from '../integrations/phone.ts'
import { assigneesFor, sendToPerson, sendWhatsAppAlert, type Contact } from '../integrations/whatsapp.ts'
import { addInvoice, readInvoices } from '../setup/documents.ts'
import { SetupError } from '../setup/setup.ts'
import { addAction, closeAction } from './actions.ts'
import { shoppingList } from './shopping.ts'

/**
 * Ordering from a supplier on WhatsApp or email, from the shopping list to the delivery. Stockpot sends the order, reads
 * the reply, and asks the owner to accept the invoice. It never accepts anything itself, and staff are told at the ETA.
 */

const digits = (number: unknown) => dialable(String(number ?? '')).replace(/\D/g, '')
const amount = (quantity: number, unit: string) => (unit === 'each' ? `${quantity}` : `${Number(quantity.toFixed(2))} ${unit}`)

async function orderRows(supplierId: number) {
  const list = await shoppingList()
  const supplier = list.suppliers.find((row) => row.id === supplierId)
  if (!supplier) throw new SetupError('That supplier has gone.')
  const rows = supplier.items.map((id) => list.items.find((item) => item.id === id)!)
  if (!rows.length) throw new SetupError("Nothing on this week's list comes from this supplier.")
  return { supplier, rows }
}

/** {owner} stays in the words until the owner's name is known, so the screen can fill it in as they type. */
export async function orderMessage(supplierId: number) {
  const { supplier, rows } = await orderRows(supplierId)
  const restaurant = await setting('restaurant_name')
  const list = rows.map((item, index) => `${index + 1}. ${item.name}: ${item.cases ? `${item.cases} x ${amount(item.caseQty, item.unit)}` : amount(item.order, item.unit)}`)
  return {
    phone: supplier.phone ?? '', ownerName: await setting('owner_name') ?? '',
    body: [`Hi ${supplier.contact ?? supplier.name},`, `This is {owner} from ${restaurant || 'our restaurant'}. I would like to order some items. Here is the list:`, ...list, 'Can I have an invoice for the order as well as the delivery ETA?'].join('\n'),
  }
}

/** Sends first, so a message WhatsApp refused doesn't leave an order that nobody received. */
export async function sendOrder(supplierId: number, input: { body?: unknown; ownerName?: unknown }) {
  const { supplier, rows } = await orderRows(supplierId)
  const ownerName = String(input.ownerName ?? '').trim().slice(0, 80)
  const text = String(input.body ?? '').trim().slice(0, 3000)
  if (!digits(supplier.phone)) throw new SetupError('Add the supplier phone number.')
  if (!text) throw new SetupError('Add the message.')
  const sent = await sendToPerson({ to: { name: supplier.name, number: digits(supplier.phone) }, text, plainOnly: true })
  if (!sent.ok) throw new SetupError(sent.detail ?? "That didn't send.")
  if (ownerName) await saveSetting('owner_name', ownerName)
  return transaction(async () => {
    const id = await insert(`INSERT INTO orders (supplier_id, status, ordered_on, summary, sent_via, sent_at, created_at) VALUES (?, 'confirmed', ?, ?, 'whatsapp', ?, ?)`,
      supplierId, localTime().date, 'Ordered on WhatsApp from the shopping list.', nowIso(), nowIso())
    for (const item of rows) await run('INSERT INTO order_lines (order_id, item_id, qty_milli, agreed_price_p) VALUES (?, ?, ?, ?)', id, item.id, Math.round(item.order * 1000), item.pricePence)
    await run('INSERT INTO deliveries (order_id) VALUES (?) ON CONFLICT DO NOTHING', id)
    return id
  })
}

export const supplierByNumber = async (number: string) => {
  const wanted = digits(`+${number}`)
  return (await all('SELECT id, name, phone, email FROM suppliers WHERE phone IS NOT NULL')).find((row) => digits(row.phone) === wanted) ?? null
}

/** The order a supplier's message is about: the newest one sent that hasn't arrived or been settled. */
export const orderWaitingOn = (supplierId: number) =>
  get(`SELECT o.* FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id WHERE o.supplier_id = ? AND o.sent_at IS NOT NULL AND o.invoice_accepted_at IS NULL
       AND COALESCE(d.status, '') <> 'done' ORDER BY o.id DESC LIMIT 1`, supplierId)

const etaWords = (order: Record<string, any>) => (order.delivery_date ? `${order.delivery_date}${order.eta_time ? ` at ${order.eta_time}` : ''}` : 'no delivery time yet')

/** One card for the owner per order, and it changes as more comes in. */
async function tellOwner(orderId: number, supplier: string) {
  const order = (await get('SELECT * FROM orders WHERE id = ?', orderId))!
  const invoice = await get(`SELECT gross_p, status FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1`, orderId)
  const title = invoice ? `Accept the ${supplier} invoice` : `${supplier} replied about your order`
  const money = invoice?.gross_p ? `${formatPounds(Number(invoice.gross_p))}. ` : ''
  const detail = `${money}Delivery: ${etaWords(order)}.${order.supplier_reply ? ` ${String(order.supplier_reply).slice(0, 200)}` : ''}`
  const id = await addAction({ sourceType: 'supplier', sourceId: orderId, urgency: 'today', title, detail })
  await sendWhatsAppAlert(id, title, detail, !!invoice)
}

async function readReply(text: string) {
  try {
    return await sparkJson<SupplierReply>({
      name: 'supplier_reply', schema: supplierReplySchema, system: supplierReplyPrompt, effort: 'low', attempts: 2, timeoutMs: 30000,
      content: [{ type: 'text', text: `Today is ${localTime().date}.\nTheir message:\n${text}` }],
    })
  } catch (error) {
    console.error('supplier reply:', (error as Error).message)
    return null
  }
}

const validDate = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
const validTime = (value: string | null) => (value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null)

/** Words from a supplier, on WhatsApp or by email. The date and time move the delivery, and the owner hears about it. */
export async function supplierWrote(supplier: Record<string, any>, text: string) {
  const order = await orderWaitingOn(Number(supplier.id))
  if (!order || !text.trim()) return false
  const reply = await readReply(text)
  await run(`UPDATE orders SET replied_at = ?, supplier_reply = ?, delivery_date = COALESCE(?, delivery_date), eta_time = COALESCE(?, eta_time), staff_alerted_at = NULL WHERE id = ?`,
    nowIso(), (reply?.summary ?? text).slice(0, 500), validDate(reply?.delivery_date ?? null), validTime(reply?.delivery_time ?? null), order.id)
  await tellOwner(Number(order.id), String(supplier.name))
  return true
}

/** A bill sent for an order. It's read like any other, and the owner decides whether to accept it. */
export async function supplierSentInvoice(supplier: Record<string, any>, file: string, name: string) {
  const order = await orderWaitingOn(Number(supplier.id))
  if (!order) return false
  const invoiceId = await addInvoice(file, name.slice(0, 200))
  await run('UPDATE invoices SET source = ? WHERE id = ?', 'whatsapp', invoiceId)
  background('supplier invoice', async () => {
    await readInvoices([invoiceId])
    await run('UPDATE invoices SET order_id = ?, supplier_id = COALESCE(supplier_id, ?) WHERE id = ?', order.id, supplier.id, invoiceId)
    await tellOwner(Number(order.id), String(supplier.name))
  })
  return true
}

/** Bills that came in by email for an order sent from Stockpot get the same card. */
export async function invoicesForOrders(ids: number[]) {
  for (const id of ids) {
    const row = await get(`SELECT o.id, s.name FROM invoices i JOIN orders o ON o.id = i.order_id JOIN suppliers s ON s.id = o.supplier_id
      WHERE i.id = ? AND o.sent_at IS NOT NULL AND o.invoice_accepted_at IS NULL`, id)
    if (row) await tellOwner(Number(row.id), String(row.name))
  }
}

export async function acceptInvoice(orderId: number) {
  const order = await get(`SELECT o.*, s.name, s.contact, s.phone FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`, orderId)
  if (!order) throw new SetupError('Order not found.')
  if (!await get('SELECT id FROM invoices WHERE order_id = ?', orderId)) throw new SetupError('There is no invoice on this order yet.')
  if (!(await run('UPDATE orders SET invoice_accepted_at = ? WHERE id = ? AND invoice_accepted_at IS NULL', nowIso(), orderId)).changes) return
  await closeAction('supplier', orderId)
  if (digits(order.phone) && order.sent_via === 'whatsapp') {
    await sendToPerson({ to: { name: String(order.name), number: digits(order.phone) }, text: `Thank you, ${order.contact ?? order.name}. The invoice is accepted. See you ${etaWords(order)}.`, plainOnly: true })
  }
}

/** With a date but no time, staff hear at the start of the day. */
const MORNING = '08:00'

/** Staff get one message when the delivery is due. Nobody on the team means it goes to the owner. */
export async function staffDeliveryAlerts() {
  const { date, time } = localTime()
  const due = await all(`SELECT o.id, o.delivery_date, o.eta_time, s.name FROM orders o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN deliveries d ON d.order_id = o.id
    WHERE o.sent_at IS NOT NULL AND o.staff_alerted_at IS NULL AND o.delivery_date = ? AND COALESCE(d.status, '') <> 'done' AND COALESCE(o.eta_time, ?) <= ?`, date, MORNING, time)
  for (const order of due) {
    // Whichever pass claims it sends it, so two passes can't message staff twice.
    if (!(await run('UPDATE orders SET staff_alerted_at = ? WHERE id = ? AND staff_alerted_at IS NULL', nowIso(), order.id)).changes) continue
    const when = order.eta_time ? ` at ${order.eta_time}` : ' today'
    const text = `The ${order.name} delivery is due${when}. Please take it in and check it in Stockpot.`
    const people: Contact[] = assigneesFor(null)
    if (people.length) await Promise.all(people.map((person) => sendToPerson({ to: person, text })))
    else await sendWhatsAppAlert(await addAction({ sourceType: 'delivery', sourceId: Number(order.id), urgency: 'today', title: `${order.name} delivery is due${when}` }), `${order.name} delivery is due${when}`, null)
  }
}
