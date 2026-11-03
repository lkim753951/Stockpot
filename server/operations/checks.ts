import { all, daysAgo, get, nowIso, run } from '../core/db.ts'
import { sparkJson } from '../ai/meta.ts'
import { creditPrompt, creditWordsSchema, type CreditWords } from '../ai/prompts.ts'
import { formatPounds } from '../money/money.ts'
import { addAction, closeAction } from './actions.ts'

/** Photos and clips of a delivery, added by whoever took it in. */
export const deliveryMedia = (orderId: number) =>
  all('SELECT id, file, video_file AS video, added_by AS addedBy, created_at AS addedAt, counted, item_id AS itemId FROM delivery_media WHERE order_id = ? ORDER BY id', orderId)

const inGroups = <T extends Record<string, any>>(rows: T[], key: string) => {
  const groups = new Map<number, T[]>()
  for (const row of rows) groups.set(Number(row[key]), [...(groups.get(Number(row[key])) ?? []), row])
  return groups
}

/**
 * The money check for a set of orders. One query for each kind of thing rather than a set of queries for
 * each order, because Home needs every order several times, and a hosted database is a network hop away.
 */
async function loadChecks(which: string, ...params: unknown[]) {
  const from = `JOIN orders o ON o.id = x.order_id WHERE ${which}`
  const [orders, deliveries, media, issues, lines, turns, unordered, invoices, credits] = await Promise.all([
    all(`SELECT o.*, s.name AS supplier, s.email, s.contact, s.phone FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE ${which} ORDER BY o.id DESC`, ...params),
    all(`SELECT x.* FROM deliveries x ${from}`, ...params),
    all(`SELECT x.order_id, x.id, x.file, x.video_file AS video, x.added_by AS addedBy, x.created_at AS addedAt, x.counted, x.item_id AS itemId FROM delivery_media x ${from} ORDER BY x.id`, ...params),
    all(`SELECT x.order_id, dl.item_id, dl.issue FROM delivery_lines dl JOIN deliveries x ON x.id = dl.delivery_id ${from} AND dl.issue IS NOT NULL`, ...params),
    all(`SELECT x.* FROM v_three_way x ${from} ORDER BY x.order_line_id`, ...params),
    all(`SELECT t.call_id, t.turn_no, t.start_ms, t.end_ms, t.text, t.role FROM call_turns t JOIN orders o ON o.call_id = t.call_id WHERE ${which}`, ...params),
    all(`SELECT x.order_id, il.description, il.line_total_p FROM invoice_lines il JOIN invoices x ON x.id = il.invoice_id ${from}
         AND (il.item_id IS NULL OR il.item_id NOT IN (SELECT item_id FROM order_lines WHERE order_id = x.order_id))`, ...params),
    all(`SELECT x.order_id, x.id, x.file, x.number, x.date, x.gross_p, x.status FROM invoices x ${from} ORDER BY x.id`, ...params),
    all(`SELECT x.* FROM credits x ${from}`, ...params),
  ])
  const deliveryOf = new Map(deliveries.map((row) => [Number(row.order_id), row]))
  const mediaOf = inGroups(media, 'order_id')
  const issuesOf = inGroups(issues, 'order_id')
  const linesOf = inGroups(lines, 'order_id')
  const unorderedOf = inGroups(unordered, 'order_id')
  const invoiceOf = new Map([...invoices].reverse().map(({ order_id: orderId, ...row }) => [Number(orderId), row]))
  const creditOf = new Map(credits.map((row) => [Number(row.order_id), row]))
  const turnOf = new Map(turns.map((row) => [`${row.call_id}:${row.turn_no}`, row]))

  return orders.map((order) => {
    const orderId = Number(order.id)
    const delivery = deliveryOf.get(orderId)
    const found = issuesOf.get(orderId) ?? []
    const lines = (linesOf.get(orderId) ?? []).map((row) => {
      const turn = row.evidence_turn && row.call_id ? turnOf.get(`${row.call_id}:${row.evidence_turn}`) : undefined
      return {
        itemId: row.item_id,
        item: row.item_name,
        unit: row.base_unit,
        ordered: row.ordered_milli / 1000,
        agreedPence: row.agreed_price_p,
        received: row.received_milli === null ? null : row.received_milli / 1000,
        billed: row.billed_milli === null ? null : row.billed_milli / 1000,
        billedPence: row.billed_price_p,
        shortPence: row.short_p ?? 0,
        priceGapPence: row.price_gap_p ?? 0,
        owedPence: (row.short_p ?? 0) + (row.price_gap_p ?? 0),
        evidence: turn ? { turn: turn.turn_no, startMs: turn.start_ms, endMs: turn.end_ms, text: turn.text, role: turn.role } : null,
        issue: found.find((issue) => issue.item_id === row.item_id)?.issue ?? null,
      }
    })
    const extra = (unorderedOf.get(orderId) ?? []).map((row) => ({ description: String(row.description), pence: Number(row.line_total_p) }))
    const invoice = invoiceOf.get(orderId)
    const owedPence = lines.reduce((sum, line) => sum + line.owedPence, 0) + extra.reduce((sum, line) => sum + line.pence, 0)
    const complete = delivery?.status === 'done' && !!invoice
    return {
      orderId,
      callId: order.call_id,
      status: order.status,
      supplier: order.supplier,
      contact: order.contact,
      email: order.email,
      phone: order.phone,
      deliveryDate: order.delivery_date,
      orderedAt: order.created_at,
      orderedOn: order.ordered_on ?? null,
      receivedBy: delivery?.received_by ?? null,
      media: (mediaOf.get(orderId) ?? []).map(({ order_id: _order, ...row }) => row),
      emailedAt: order.emailed_at,
      arrivedAt: delivery?.checked_at ?? null,
      storedAt: delivery?.stored_at ?? null,
      deliveryNote: delivery?.note ?? null,
      issuePhoto: delivery?.issue_photo ?? null,
      problem: lines.some((line) => line.issue),
      summary: order.summary,
      lines,
      unordered: extra,
      owedPence,
      complete,
      deliveryPhoto: delivery?.photo_file ?? null,
      invoice: invoice ?? null,
      credit: creditOf.get(orderId) ?? null,
      state: !complete ? 'waiting' : owedPence > 0 ? 'owed' : 'clear',
    }
  })
}

export const checkFor = async (orderId: number) => (await loadChecks('o.id = ?', orderId))[0] ?? null

/** Short, damaged or wrong goes straight to the owner, with the supplier one tap away. */
export async function reportDeliveryProblems(orderId: number) {
  const check = await checkFor(orderId)
  if (!check) return false
  const words: Record<string, string> = { short: 'short', damaged: 'damaged', wrong: 'wrong item', missing: 'missing' }
  const lines = check.lines.filter((line) => line.issue).map((line) => `${line.item}: ${words[String(line.issue)] ?? line.issue}, ${line.received ?? 0} of ${line.ordered} ${line.unit === 'each' ? '' : line.unit}`.trim())
  if (!lines.length) {
    await closeAction('problem', orderId)
    return false
  }
  await addAction({ sourceType: 'problem', sourceId: orderId, urgency: 'now', title: `Problem with the ${check.supplier} delivery`, detail: [lines.join('. '), check.deliveryNote].filter(Boolean).join('. ') })
  return true
}

export const listChecks = () => loadChecks(`o.status = 'confirmed'`)

function itemisedLines(check: NonNullable<Awaited<ReturnType<typeof checkFor>>>) {
  const out: string[] = []
  for (const line of check.lines) {
    if (line.shortPence > 0) {
      out.push(`${line.item}: billed for ${line.billed} ${line.unit}, ${line.received} ${line.unit} delivered. Credit ${formatPounds(line.shortPence)}.`)
    }
    if (line.priceGapPence > 0) {
      out.push(`${line.item}: agreed ${formatPounds(line.agreedPence)} per ${line.unit} on the phone, billed ${formatPounds(line.billedPence)}. Credit ${formatPounds(line.priceGapPence)}.`)
    }
  }
  for (const line of check.unordered) out.push(`${line.description}: not on the order. Credit ${formatPounds(line.pence)}.`)
  return out
}

const fallbackWords = (supplier: string, contact: string | null): CreditWords => ({
  subject: `Credit request for our ${supplier} delivery`,
  opening: `Hi ${contact ?? 'there'}, we checked this delivery against our order and found a few differences.`,
  closing: 'Could you send a credit note for these lines, please? Thanks for your help.',
})

/** Muse Spark writes the words. Every number comes from the SQL check, and a reply with digits is refused. */
export async function draftCredit(orderId: number) {
  const check = await checkFor(orderId)
  if (!check || check.state !== 'owed') return null
  const existing = await get('SELECT * FROM credits WHERE order_id = ?', orderId)
  if (existing) return existing

  let words = fallbackWords(check.supplier, check.contact)
  try {
    const written = await sparkJson<CreditWords>({
      name: 'credit_request_words',
      schema: creditWordsSchema,
      system: creditPrompt,
      content: [{ type: 'text', text: `Supplier: ${check.supplier}. Contact: ${check.contact ?? 'unknown'}. Reasons: ${check.lines.filter((l) => l.owedPence > 0).map((l) => l.item).join(', ')}.` }],
      effort: 'low',
    })
    if (![written.subject, written.opening, written.closing].some((text) => /[\d£]/.test(text))) words = written
  } catch (error) {
    console.error(`credit ${orderId}:`, (error as Error).message)
  }

  const body = [
    words.opening, '',
    ...itemisedLines(check), '',
    `Total credit requested: ${formatPounds(check.owedPence)}.`,
    ...(check.invoice?.number ? [`Invoice ${check.invoice.number}.`] : []), '',
    words.closing,
  ].join('\n')
  await run('INSERT INTO credits (order_id, subject, body, total_p) VALUES (?, ?, ?, ?)', orderId, words.subject, body, check.owedPence)
  return get('SELECT * FROM credits WHERE order_id = ?', orderId)
}

export async function approveCredit(orderId: number, subject: string, body: string) {
  await run(`UPDATE credits SET status = 'approved', subject = ?, body = ?, approved_at = ? WHERE order_id = ?`, subject, body, nowIso(), orderId)
}

export async function markSettled(orderId: number) {
  await run(`UPDATE credits SET status = 'settled', settled_at = ? WHERE order_id = ?`, nowIso(), orderId)
}

/** The weekly numbers. All of it is SQL, so it can be checked by hand. */
export async function weekSummary(range?: { from: string; to: string }) {
  const since = range?.from ?? daysAgo(7)
  const until = range ? `${range.to}T23:59:59` : '9999'
  const inRange = (date: unknown) => !range || (String(date ?? '').slice(0, 10) >= range.from && String(date ?? '').slice(0, 10) <= range.to)
  const checks = await listChecks()
  const owed = checks.filter((check) => check.state === 'owed' && inRange((check as any).invoice?.date ?? (check as any).deliveryDate))
  const found = owed.reduce((sum, check) => sum + check.owedPence, 0)
  const settled = owed.filter((check) => check.credit?.status === 'settled').reduce((sum, check) => sum + check.owedPence, 0)
  const talkedDown = (await all(`
    SELECT i.name, first.price_p AS offered, agreed.price_p AS agreed, agreed.qty_base, s.name AS supplier
    FROM live_cards agreed
    JOIN live_cards first ON first.call_id = agreed.call_id AND first.item_id = agreed.item_id AND first.kind = 'offer'
      AND first.id = (SELECT MIN(c.id) FROM live_cards c WHERE c.call_id = agreed.call_id AND c.item_id = agreed.item_id AND c.kind = 'offer')
    JOIN items i ON i.id = agreed.item_id
    JOIN calls c ON c.id = agreed.call_id
    JOIN suppliers s ON s.id = c.supplier_id
    WHERE agreed.kind = 'agreed' AND agreed.price_p < first.price_p AND agreed.created_at >= ? AND agreed.created_at <= ?
      AND agreed.id = (SELECT MAX(c2.id) FROM live_cards c2 WHERE c2.call_id = agreed.call_id AND c2.item_id = agreed.item_id AND c2.kind = 'agreed')`, since, until))
    .map((row) => ({
      item: row.name, supplier: row.supplier, offeredPence: row.offered, agreedPence: row.agreed,
      savedPence: row.qty_base ? Math.round((row.offered - row.agreed) * row.qty_base) : null,
    }))
  const priceRises = (await all(`
    SELECT i.name, s.name AS supplier, p.price_p AS now_p, prev.price_p AS before_p
    FROM price_history p
    JOIN items i ON i.id = p.item_id
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN price_history prev ON prev.id = (SELECT p2.id FROM price_history p2 WHERE p2.item_id = p.item_id AND p2.supplier_id = p.supplier_id
       AND (p2.date < p.date OR (p2.date = p.date AND p2.id < p.id)) ORDER BY p2.date DESC, p2.id DESC LIMIT 1)
    WHERE p.date >= ? AND p.price_p > prev.price_p ORDER BY (p.price_p - prev.price_p) * 1.0 / prev.price_p DESC`, since))
    .map((row) => ({ item: row.name, supplier: row.supplier, nowPence: row.now_p, beforePence: row.before_p }))
  return {
    foundPence: found,
    settledPence: settled,
    openPence: found - settled,
    talkedDownPence: talkedDown.reduce((sum, row) => sum + (row.savedPence ?? 0), 0),
    talkedDown,
    priceRises,
    openChecks: owed.filter((check) => check.credit?.status !== 'settled').length,
  }
}
