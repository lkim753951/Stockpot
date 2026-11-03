import fs from 'node:fs'
import path from 'node:path'
import { all, claim, get, insert, isoDate, nowIso, run, transaction } from '../core/db.ts'
import { localFile } from '../core/files.ts'
import { samFind, sparkJson, type ContentPart, type SamBox } from '../ai/meta.ts'
import {
  deliveryPrompt, deliverySchema, invoicePrompt, invoiceSchema,
  type ExtractedDelivery, type ExtractedInvoice,
} from '../ai/prompts.ts'
import { nearly } from '../money/money.ts'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf',
}

export const allowedExtension = (name: string) => path.extname(name).toLowerCase() in MIME

/** Stops a printed value from running as a formula when the file opens in a spreadsheet. */
export const safeCell = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text)

export async function documentPart(file: string, originalName: string): Promise<ContentPart> {
  const extension = path.extname(file).toLowerCase()
  const data = `data:${MIME[extension]};base64,${fs.readFileSync(await localFile(file)).toString('base64')}`
  return extension === '.pdf'
    ? { type: 'file', file: { file_data: data, filename: originalName } }
    : { type: 'image_url', image_url: { url: data } }
}

/** Arithmetic on the printed numbers. A wrong read usually breaks at least one of these. */
export function checkInvoiceSums(invoice: ExtractedInvoice) {
  const issues: string[] = []
  const lineIssues = new Map<number, string>()
  invoice.lines.forEach((line, index) => {
    if (!nearly(line.quantity * line.unit_price_pence, line.line_total_pence)) {
      lineIssues.set(index, `${line.quantity} × ${(line.unit_price_pence / 100).toFixed(2)} doesn't equal the line total.`)
    }
  })
  const sum = invoice.lines.reduce((total, line) => total + line.line_total_pence, 0)
  if (invoice.net_total_pence !== null && !nearly(sum, invoice.net_total_pence)) {
    issues.push("The lines don't add up to the net total.")
  }
  if (invoice.net_total_pence !== null && invoice.gross_total_pence !== null
    && !nearly(invoice.net_total_pence + (invoice.vat_total_pence ?? 0), invoice.gross_total_pence)) {
    issues.push("Net plus VAT doesn't equal the total.")
  }
  if (invoice.gross_total_pence === null) issues.push('No total could be read.')
  for (const note of invoice.unreadable) issues.push(`Couldn't read: ${note}`)
  return { issues, lineIssues }
}

async function matchOrder(supplierId: number | null, date: string | null) {
  if (!supplierId) return null
  const on = Date.parse(date ?? isoDate())
  const orders = await all(`SELECT o.id, COALESCE(o.delivery_date, o.created_at) AS day FROM orders o WHERE o.supplier_id = ? AND o.status = 'confirmed'
                            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id) ORDER BY o.id`, supplierId)
  const distance = (row: Record<string, unknown>) => Math.abs(Date.parse(String(row.day)) - on)
  const nearest = orders.reduce<(typeof orders)[number] | null>((best, row) => (!best || distance(row) < distance(best) ? row : best), null)
  return nearest ? Number(nearest.id) : null
}

const regionWords = (region: unknown) => {
  if (!region) return ''
  const box = JSON.parse(String(region)) as SamBox
  return `\nThis photo holds several receipts. Read only the one inside the box from (${box.x1}, ${box.y1}) to (${box.x2}, ${box.y2}) of an image ${box.w} by ${box.h} pixels.`
}

/** One overhead photo of a pile often has several receipts. SAM finds them, and each gets its own row. */
export async function splitReceipts(id: number) {
  const invoice = await get('SELECT * FROM invoices WHERE id = ?', id)
  if (!invoice || path.extname(String(invoice.file)).toLowerCase() === '.pdf') return [id]
  let boxes: SamBox[] = []
  try {
    const part = await documentPart(String(invoice.file), String(invoice.original_name))
    if (part.type === 'image_url') boxes = await samFind(part.image_url.url, 'receipt')
  } catch (error) {
    console.error('sam receipts:', (error as Error).message)
  }
  const area = (box: SamBox) => ((box.x2 - box.x1) * (box.y2 - box.y1)) / (box.w * box.h)
  const clear = boxes.filter((box) => (box.c ?? 1) >= 0.5 && area(box) >= 0.04).slice(0, 12)
  if (clear.length < 2) return [id]
  await run('UPDATE invoices SET region = ? WHERE id = ?', JSON.stringify(clear[0]), id)
  const ids = [id]
  for (const box of clear.slice(1)) {
    ids.push(await insert(`INSERT INTO invoices (file, original_name, status, region, source, created_at) VALUES (?, ?, 'reading', ?, ?, ?)`,
      invoice.file, invoice.original_name, JSON.stringify(box), invoice.source ?? null, nowIso()))
  }
  return ids
}

export async function readInvoice(invoiceId: number) {
  const invoice = (await get('SELECT * FROM invoices WHERE id = ?', invoiceId))!
  try {
    const extracted = await sparkJson<ExtractedInvoice>({
      name: 'invoice',
      schema: invoiceSchema,
      system: await invoicePrompt(),
      content: [
        { type: 'text', text: `Read this document. File name: ${invoice.original_name}${regionWords(invoice.region)}` },
        await documentPart(String(invoice.file), String(invoice.original_name)),
      ],
      effort: 'medium',
    })
    const known = extracted.supplier_id !== null && await get('SELECT id FROM suppliers WHERE id = ?', extracted.supplier_id)
    const supplierId = known ? extracted.supplier_id : null
    const date = extracted.invoice_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.invoice_date) ? extracted.invoice_date : null
    const { issues, lineIssues } = checkInvoiceSums(extracted)

    if (extracted.invoice_number && supplierId) {
      const duplicate = await get('SELECT id FROM invoices WHERE supplier_id = ? AND number = ? AND id <> ?', supplierId, extracted.invoice_number, invoiceId)
      if (duplicate) issues.push('This invoice number has already been uploaded.')
    }

    const orderId = issues.some((issue) => issue.startsWith('This invoice number')) ? null : await matchOrder(supplierId, date)
    await transaction(async () => {
    await run(`UPDATE invoices SET status = ?, supplier_id = ?, supplier_name = ?, number = ?, date = ?, net_p = ?, vat_p = ?, gross_p = ?,
         order_id = ?, issues = ? WHERE id = ?`,
      issues.length || lineIssues.size ? 'needs-review' : 'read', supplierId, extracted.supplier_name, extracted.invoice_number,
      date, extracted.net_total_pence, extracted.vat_total_pence, extracted.gross_total_pence, orderId, JSON.stringify(issues), invoiceId)

    for (const [index, line] of extracted.lines.entries()) {
      const item = line.item_id !== null ? await get('SELECT id, case_qty FROM items WHERE id = ?', line.item_id) : undefined
      const pack = line.unit === 'case' ? line.pack_quantity ?? (item?.case_qty as number | null) ?? null : null
      const qtyBase = line.unit === 'case' ? (pack ? line.quantity * pack : line.quantity) : line.quantity
      const priceBase = line.unit === 'case' && pack ? line.unit_price_pence / pack : line.unit_price_pence
      const lineId = await insert(`INSERT INTO invoice_lines (invoice_id, item_id, description, qty_billed, unit, pack_qty, unit_price_p, line_total_p,
          vat_rate, qty_base_milli, price_base_p, issue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invoiceId, item ? line.item_id : null, line.description, line.quantity, line.unit, pack, line.unit_price_pence,
        Math.round(line.line_total_pence), line.vat_rate, Math.round(qtyBase * 1000), priceBase, lineIssues.get(index) ?? null)
      // Every clean line improves the next call: this becomes the "last paid" price.
      if (item && supplierId && date && !lineIssues.has(index)) {
        await run('INSERT INTO price_history (item_id, supplier_id, date, price_p, invoice_line_id) VALUES (?, ?, ?, ?, ?)', line.item_id, supplierId, date, priceBase, lineId)
      }
    }
    })
  } catch (error) {
    console.error(`invoice ${invoiceId}:`, (error as Error).message)
    await run('UPDATE invoices SET status = ?, issues = ? WHERE id = ?', 'failed', JSON.stringify(['This document could not be read. Try a sharper photo.']), invoiceId)
  }
}

/** Reads a pile of invoices three at a time, so one bad scan never stops the rest. */
export async function readInvoices(ids: number[]) {
  const queue = (await Promise.all(ids.map(splitReceipts))).flat()
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) await readInvoice(queue.shift()!)
  }))
}

/** For the regular pass. A big pile can outlast a function, and whatever was left must not stay "reading" for ever. */
export async function sweepInvoices() {
  const stuck = await all(`SELECT id FROM invoices WHERE status = 'reading' AND created_at < ? ORDER BY id LIMIT 6`, new Date(Date.now() - 360000).toISOString())
  for (const { id } of stuck) {
    if (await claim(`invoice:${id}`, 86400000)) await readInvoice(Number(id))
    else await run('UPDATE invoices SET status = ?, issues = ? WHERE id = ?', 'failed', JSON.stringify(['This document could not be read. Try a sharper photo.']), id)
  }
}

export function addInvoice(file: string, originalName: string) {
  return insert('INSERT INTO invoices (file, original_name, created_at) VALUES (?, ?, ?)', file, originalName, nowIso())
}

export async function readDeliveryNote(orderId: number, file: string, originalName: string) {
  const lines = await all('SELECT ol.item_id, ol.qty_milli, i.name, i.base_unit FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ?', orderId)
  const extracted = await sparkJson<ExtractedDelivery>({
    name: 'delivery_note',
    schema: deliverySchema,
    system: await deliveryPrompt(),
    content: [
      { type: 'text', text: `File name: ${originalName}\nThis order expected: ${lines.map((l) => `${l.name} ${l.qty_milli / 1000} ${l.base_unit}`).join(', ')}` },
      await documentPart(file, originalName),
    ],
    effort: 'medium',
  })
  return extracted
}

export async function invoiceLinesCsv(range?: { from: string; to: string }) {
  const rows = await all(`SELECT inv.date, inv.supplier_name, inv.number, il.description, il.qty_billed, il.unit, il.pack_qty,
      il.unit_price_p, il.line_total_p, il.vat_rate, il.issue, inv.file
    FROM invoice_lines il JOIN invoices inv ON inv.id = il.invoice_id
    WHERE COALESCE(inv.date, substr(inv.created_at, 1, 10)) BETWEEN ? AND ? ORDER BY inv.date NULLS FIRST, inv.id, il.id`, range?.from ?? '0000', range?.to ?? '9999')
  const header = ['Date', 'Supplier', 'Invoice', 'Item', 'Quantity', 'Unit', 'Pack size', 'Unit price (£)', 'Line total (£)', 'VAT rate', 'Check', 'Photo']
  const cell = (value: unknown) => {
    const text = safeCell(value === null || value === undefined ? '' : String(value))
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const body = rows.map((row) => [
    row.date, row.supplier_name, row.number, row.description, row.qty_billed, row.unit, row.pack_qty,
    (Number(row.unit_price_p) / 100).toFixed(2), (Number(row.line_total_p) / 100).toFixed(2), row.vat_rate, row.issue, row.file,
  ].map(cell).join(','))
  return [header.join(','), ...body].join('\r\n')
}
