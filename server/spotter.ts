import { catalogue } from './prompts.ts'
import { findPrices, findQuantities } from './money.ts'

export interface CatalogueItem {
  id: number
  name: string
  baseUnit: string
  caseQty: number | null
  aliases: string[]
}

export async function loadCatalogue(): Promise<CatalogueItem[]> {
  return (await catalogue()).map((row) => ({
    id: row.id, name: row.name, baseUnit: row.base_unit, caseQty: row.case_qty, aliases: JSON.parse(row.aliases),
  }))
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The most recently named item, so "they're six ninety" can follow "chicken thighs". */
export function findItem(text: string, items: CatalogueItem[]): CatalogueItem | null {
  let best: { item: CatalogueItem; index: number } | null = null
  for (const item of items) {
    for (const alias of [...item.aliases].sort((a, b) => b.length - a.length)) {
      const match = new RegExp(`\\b${escape(alias)}\\b`, 'i').exec(text)
      if (match && (!best || match.index > best.index)) best = { item, index: match.index }
    }
  }
  return best?.item ?? null
}

/** Words that mean a price is a memory or a rival's, so it must not be read as today's offer. */
const REFERENCE = /\b(paid|last (week|time|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|was|were|doing (them|it|those)|usually|normally|used to)\b/i
const QUESTION = /\b(can you|could you|will you|would you|how about|what about)\b.*\?$/i

export interface InstantSpot {
  item: CatalogueItem
  pricePence: number
}

/**
 * Runs on every partial transcript, so a card appears before the speaker has finished.
 * It only fires when it is confident. Anything else waits for Muse Spark at the end of the turn.
 */
export function spotInstantPrice(partial: string, recentContext: string, items: CatalogueItem[]): InstantSpot | null {
  if (REFERENCE.test(partial) || QUESTION.test(partial.trim())) return null
  const prices = findPrices(partial)
  if (prices.length !== 1) return null
  const item = findItem(partial, items) ?? findItem(recentContext, items)
  return item ? { item, pricePence: prices[0].pence } : null
}

export function mentionsTrade(text: string, items: CatalogueItem[]) {
  return findPrices(text).length > 0 || findQuantities(text).length > 0 || findItem(text, items) !== null
    || /\b(up|down|same|deal|done|go on|agreed|pence|quid|pounds?)\b/i.test(text)
}

export function toBaseQuantity(quantity: number, unit: string, item: CatalogueItem) {
  if (unit === 'case') return item.caseQty ? quantity * item.caseQty : null
  return quantity
}
