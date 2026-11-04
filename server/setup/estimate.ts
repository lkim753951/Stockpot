import { get } from '../core/db.ts'
import { localTime } from '../core/clock.ts'
import { sparkJson } from '../ai/meta.ts'
import { estimatePrompt, estimateSchema, type ExtractedEstimate } from '../ai/prompts.ts'
import { marginPercent, priceForMargin } from '../../shared/costing.ts'
import { itemMatcher, SetupError, TO_BASE } from './setup.ts'

/** The margin the suggested price aims for. Restaurants usually aim for food cost under a fifth of the price. */
export const SUGGESTED_MARGIN = 80

const FORM_UNIT: Record<string, string> = { kg: 'g', l: 'ml', each: 'each' }
const clean = (value: unknown, limit = 120) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, limit)

/** The newest price paid for a saved item, the same price rule the Dashboard uses for today. */
async function paidPrice(itemId: number) {
  const today = localTime().date
  const row = await get(`SELECT COALESCE(
      (SELECT price_p FROM price_history WHERE item_id = ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1),
      (SELECT price_p FROM price_history WHERE item_id = ? ORDER BY date ASC, id ASC LIMIT 1)) AS price_p`, itemId, today, itemId)
  return row?.price_p === null || row?.price_p === undefined ? null : Number(row.price_p)
}

type Line = { name: string; quantity: number; unit: string }

/**
 * Food cost, margin and a price for an 80% margin, for a dish that may not have real prices yet. A price the restaurant
 * has paid is always used first. Muse Spark estimates the rest, and the answer is never saved, so a real receipt replaces it.
 * With no ingredients, Muse Spark suggests a typical one-portion recipe the owner can start from.
 */
export async function estimateDish(input: Record<string, any>) {
  const name = clean(input.name)
  if (!name) throw new SetupError('Add the dish name.')
  const pricePence = Number(input.pricePence) > 0 ? Math.round(Number(input.pricePence)) : null
  const given: Line[] = (Array.isArray(input.lines) ? input.lines : [])
    .map((line: any) => ({ name: clean(line?.name), quantity: Number(line?.quantity), unit: String(line?.unit ?? '') }))
    .filter((line: Line) => line.name && line.quantity > 0 && line.unit in TO_BASE)
    .slice(0, 40)
  const match = await itemMatcher()
  const paid = await Promise.all(given.map(async (line) => {
    const known = match(line.name)
    return known && known.base_unit === TO_BASE[line.unit].base ? await paidPrice(Number(known.id)) : null
  }))
  const needed = given.filter((_line, index) => paid[index] === null)
  let guessed: Array<ExtractedEstimate['ingredients'][number] | null> = []
  if (!given.length || needed.length) {
    const listing = given.length
      ? needed.map((line, index) => {
        const unit = FORM_UNIT[TO_BASE[line.unit].base]
        return `${index + 1}. ${line.name}: ${Number((line.quantity / TO_BASE[unit].factor * TO_BASE[line.unit].factor).toFixed(3))} ${unit}`
      }).join('\n')
      : 'No ingredient list. Suggest a typical one-portion recipe.'
    const answer = await sparkJson<ExtractedEstimate>({
      name: 'dish_estimate', schema: estimateSchema, system: estimatePrompt, effort: 'low', timeoutMs: 60000,
      content: [{ type: 'text', text: `Dish: ${name}\nIngredients for one portion:\n${listing}` }],
    }).catch((error) => {
      console.error('estimate:', (error as Error).message)
      throw new SetupError("Stockpot couldn't make an estimate just now. Try again in a minute.")
    })
    guessed = answer.ingredients.map((line) => (Number.isFinite(line.pence_per_unit) && line.pence_per_unit > 0 && line.pence_per_unit < 1000000 ? line : null))
  }

  // A guess is matched by name, or by its place in the list when the list came back whole, so it can't price the wrong thing.
  const key = (text: string) => text.trim().toLowerCase()
  const lines = given.length
    ? given.map((line, index) => {
      const base = TO_BASE[line.unit]
      const quantityBase = line.quantity * base.factor
      if (paid[index] !== null) return { name: line.name, quantity: line.quantity, unit: line.unit, pencePerUnit: paid[index], priceUnit: base.base, source: 'paid' as const, costPence: quantityBase * paid[index]! }
      const asked = needed.indexOf(line)
      const guess = guessed.find((row) => row && key(row.name) === key(line.name)) ?? (guessed.length === needed.length ? guessed[asked] : null)
      const price = guess?.pence_per_unit ?? null
      return { name: line.name, quantity: line.quantity, unit: line.unit, pencePerUnit: price, priceUnit: base.base, source: price === null ? null : 'estimate' as const, costPence: price === null ? null : quantityBase * price }
    })
    : guessed.flatMap((line) => (line && line.quantity > 0 ? [line] : [])).slice(0, 15).map((line) => {
      const base = TO_BASE[line.unit]
      return { name: clean(line.name), quantity: Number(line.quantity.toFixed(1)), unit: line.unit, pencePerUnit: line.pence_per_unit, priceUnit: base.base, source: 'estimate' as const, costPence: line.quantity * base.factor * line.pence_per_unit }
    })
  if (!lines.length) throw new SetupError("Stockpot couldn't make an estimate just now. Try again in a minute.")
  const priced = lines.filter((line) => line.costPence !== null)
  const cost = priced.reduce((sum, line) => sum + line.costPence!, 0)
  const complete = priced.length === lines.length
  return {
    name, pricePence, suggestedRecipe: !given.length, complete,
    costPence: Math.round(cost),
    marginPercent: complete && pricePence ? marginPercent(pricePence, cost) : null,
    suggestedMargin: SUGGESTED_MARGIN,
    suggestedPricePence: complete ? priceForMargin(cost, SUGGESTED_MARGIN) : null,
    estimated: lines.filter((line) => line.source === 'estimate').length,
    lines: lines.map((line) => ({ ...line, costPence: line.costPence === null ? null : Math.round(line.costPence * 10) / 10 })),
  }
}
