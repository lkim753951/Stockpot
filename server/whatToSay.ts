import { checkFor } from './checks.ts'
import { formatPounds } from './money.ts'
import { sparkJson } from './meta.ts'
import { callWordsPrompt, callWordsSchema } from './prompts.ts'

type CallWords = { opening: string; ask: string; pushback: string }

const amount = (value: number | null, unit: string) => `${value ?? 0}${unit === 'each' ? '' : ` ${unit}`}`

/** Every number the owner will say comes from the check, so the script can't invent one. */
function factsFor(check: NonNullable<Awaited<ReturnType<typeof checkFor>>>) {
  const facts: string[] = []
  const problem: Record<string, string> = { damaged: 'came damaged', wrong: 'was the wrong item', missing: 'was missing' }
  for (const line of check.lines) {
    if (line.issue === 'short') facts.push(`${line.item}: you ordered ${amount(line.ordered, line.unit)} and ${amount(line.received, line.unit)} arrived.`)
    else if (line.issue) facts.push(`${line.item} ${problem[String(line.issue)] ?? 'had a problem'}.`)
    if (line.priceGapPence > 0) facts.push(`${line.item}: ${formatPounds(line.agreedPence)} agreed on the phone, ${formatPounds(line.billedPence)} on the invoice.`)
    if (line.shortPence > 0 && line.issue !== 'short') facts.push(`${line.item}: billed for ${amount(line.billed, line.unit)}, ${amount(line.received, line.unit)} arrived.`)
    if (line.evidence && line.owedPence > 0) facts.push(`On the call they said: "${line.evidence.text}"`)
  }
  for (const line of check.unordered) facts.push(`${line.description} wasn't on the order, and it was billed at ${formatPounds(line.pence)}.`)
  if (check.owedPence > 0) facts.push(`That comes to ${formatPounds(check.owedPence)}${check.invoice?.number ? ` on invoice ${check.invoice.number}` : ''}.`)
  return facts
}

const fallback = (contact: string, owed: boolean): CallWords => ({
  opening: `Hi ${contact}, it's about our last delivery. Have you got a minute?`,
  ask: owed ? 'Could you put a credit note through for that, please?' : 'Could you send the rest over, or credit it, please?',
  pushback: "That's fine. I can send you the delivery photos and the invoice now, so you can check it your end.",
})

/** What to say on a call about a delivery. Muse Spark writes the words and the check supplies the facts. */
export async function whatToSay(orderId: number) {
  const check = await checkFor(orderId)
  if (!check) return null
  const facts = factsFor(check)
  const contact = String(check.contact ?? 'there')
  let words = fallback(contact, check.owedPence > 0)
  if (facts.length) {
    try {
      const written = await sparkJson<CallWords>({
        name: 'call_script_words', schema: callWordsSchema, system: callWordsPrompt, effort: 'low', timeoutMs: 20000,
        content: [{ type: 'text', text: `Supplier: ${check.supplier}. Contact: ${contact}. Money to claim: ${check.owedPence > 0 ? 'yes' : 'no'}.` }],
      })
      if (![written.opening, written.ask, written.pushback].some((text) => /[\d£]/.test(text))) words = written
    } catch (error) {
      console.error(`call script ${orderId}:`, (error as Error).message)
    }
  }
  return { ...words, facts, contact: check.contact, phone: check.phone, supplier: check.supplier }
}
