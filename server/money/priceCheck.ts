import { all } from '../core/db.ts'

const SAME_WORDS = /[^a-z ]+/g

/**
 * What a pile of old invoices shows without any orders or calls: each time an item cost more than
 * the first price in the period, and any invoice that looks billed twice. All of it is SQL and sums.
 */
export async function priceCheck(range: { from: string; to: string }) {
  const lines = await all(`
    SELECT l.description, l.price_base_p AS price, l.qty_base_milli / 1000.0 AS quantity, l.unit, i.id AS invoice, i.date, i.supplier_name AS supplier, t.name AS item, t.base_unit AS base
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN items t ON t.id = l.item_id
    WHERE i.status NOT IN ('reading', 'failed') AND i.date BETWEEN ? AND ? AND l.price_base_p > 0
    ORDER BY i.date, l.id`, range.from, range.to)
  const groups = new Map<string, typeof lines>()
  for (const line of lines) {
    const name = String(line.item ?? line.description).toLowerCase().replace(SAME_WORDS, '').replace(/\s+/g, ' ').trim()
    const key = `${line.supplier}|${name}|${line.base ?? line.unit}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  const items = [...groups.values()].flatMap((group) => {
    const first = Number(group[0].price)
    const rises = group.filter((line) => Number(line.price) > first)
    if (!rises.length) return []
    return [{
      item: String(group[0].item ?? group[0].description), supplier: String(group[0].supplier ?? ''), unit: String(group[0].base ?? group[0].unit),
      firstPence: first, lastPence: Number(group[group.length - 1].price), times: rises.length,
      extraPence: Math.round(rises.reduce((sum, line) => sum + (Number(line.price) - first) * Number(line.quantity), 0)),
    }]
  }).sort((a, b) => b.extraPence - a.extraPence)

  const twice = await all(`
    SELECT a.supplier_name AS supplier, a.number, a.date, a.gross_p AS pence
    FROM invoices a JOIN invoices b ON b.id < a.id AND b.supplier_name = a.supplier_name AND b.gross_p = a.gross_p
      AND (b.number = a.number OR b.date = a.date)
    WHERE a.date BETWEEN ? AND ? AND a.gross_p > 0 AND a.status NOT IN ('reading', 'failed') AND b.status NOT IN ('reading', 'failed')`, range.from, range.to)

  return {
    invoices: new Set(lines.map((line) => line.invoice)).size,
    extraPence: items.reduce((sum, item) => sum + item.extraPence, 0),
    items: items.slice(0, 8),
    twice,
  }
}
