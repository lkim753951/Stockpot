import { all, get } from './db.ts'
import { formatPounds } from './money.ts'

export interface DishImpact {
  name: string
  marginNow: number
  marginNew: number
  target: number
  belowTarget: boolean
}

export interface PriceCard {
  itemId: number
  itemName: string
  unit: string
  kind: 'offer' | 'agreed' | 'reference'
  pricePence: number
  quantityBase: number | null
  lastPaid: { pence: number; date: string; supplier: string } | null
  deltaPence: number | null
  deltaPercent: number | null
  cheaper: { pence: number; date: string; supplier: string } | null
  extraCostPence: number | null
  dishes: DishImpact[]
  sayThis: string | null
  source: 'instant' | 'muse-spark'
  latencyMs: number | null
}

export function lastPaid(itemId: number, supplierId: number) {
  return get(`SELECT p.price_p, p.date, s.name FROM price_history p JOIN suppliers s ON s.id = p.supplier_id
              WHERE p.item_id = ? AND p.supplier_id = ? ORDER BY p.date DESC, p.id DESC LIMIT 1`, itemId, supplierId)
}

/** The lowest recent price from any other supplier, using each supplier's latest price. */
export function cheaperElsewhere(itemId: number, supplierId: number, thanPence: number) {
  return get(`SELECT p.price_p, p.date, s.name FROM price_history p JOIN suppliers s ON s.id = p.supplier_id
              WHERE p.item_id = ? AND p.supplier_id <> ?
                AND p.id = (SELECT p2.id FROM price_history p2 WHERE p2.item_id = p.item_id AND p2.supplier_id = p.supplier_id
                            ORDER BY p2.date DESC, p2.id DESC LIMIT 1)
                AND p.price_p < ?
              ORDER BY p.price_p ASC LIMIT 1`, itemId, supplierId, thanPence)
}

const latestPriceSql = `(SELECT p.price_p FROM price_history p WHERE p.item_id = r.item_id ORDER BY p.date DESC, p.id DESC LIMIT 1)`

/** Margin for each dish that uses the item, now and at the new price. */
export async function dishImpact(itemId: number, newPricePence: number): Promise<DishImpact[]> {
  const dishes = await all(`SELECT d.id, d.name, d.price_p, d.target_margin FROM dishes d
                      JOIN recipe_lines r ON r.dish_id = d.id WHERE r.item_id = ? ORDER BY d.name`, itemId)
  return await Promise.all(dishes.map(async (dish) => {
    const now = (await get(`SELECT SUM(r.qty_base * ${latestPriceSql}) AS cost FROM recipe_lines r WHERE r.dish_id = ?`, dish.id))!
    const usage = (await get('SELECT qty_base FROM recipe_lines WHERE dish_id = ? AND item_id = ?', dish.id, itemId))!
    const current = (await get(`SELECT ${latestPriceSql.replace('r.item_id', '?')} AS price_p`, itemId))!
    const changed = Number(now.cost) + usage.qty_base * (newPricePence - Number(current.price_p))
    const margin = (cost: number) => Math.round((1 - cost / dish.price_p) * 1000) / 10
    const marginNew = margin(changed)
    return {
      name: dish.name, marginNow: margin(Number(now.cost)), marginNew,
      target: dish.target_margin, belowTarget: marginNew < dish.target_margin,
    }
  }))
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  .replace(',', '')

export async function buildCard(input: {
  itemId: number
  supplierId: number
  kind: PriceCard['kind']
  pricePence: number
  quantityBase: number | null
  source: PriceCard['source']
  latencyMs: number | null
}): Promise<PriceCard> {
  const item = (await get('SELECT name, base_unit FROM items WHERE id = ?', input.itemId))!
  const last = await lastPaid(input.itemId, input.supplierId)
  const other = await cheaperElsewhere(input.itemId, input.supplierId, input.pricePence)
  const delta = last ? input.pricePence - Number(last.price_p) : null
  const perUnit = `a ${item.base_unit === 'l' ? 'litre' : item.base_unit === 'kg' ? 'kilo' : 'unit'}`

  let sayThis: string | null = null
  if (input.kind === 'offer' && last && delta !== null && delta > 0) {
    sayThis = other
      ? `I paid ${formatPounds(Number(last.price_p))} on ${shortDate(last.date)}, and ${other.name} is at ${formatPounds(Number(other.price_p))} ${perUnit}. Can you match ${formatPounds(Number(last.price_p))}?`
      : `I paid ${formatPounds(Number(last.price_p))} on ${shortDate(last.date)}. Can you hold that price?`
  }

  return {
    itemId: input.itemId,
    itemName: item.name,
    unit: item.base_unit,
    kind: input.kind,
    pricePence: input.pricePence,
    quantityBase: input.quantityBase,
    lastPaid: last ? { pence: Number(last.price_p), date: String(last.date), supplier: String(last.name) } : null,
    deltaPence: delta,
    deltaPercent: last && delta !== null ? Math.round((delta / Number(last.price_p)) * 1000) / 10 : null,
    cheaper: other ? { pence: Number(other.price_p), date: String(other.date), supplier: String(other.name) } : null,
    extraCostPence: delta !== null && input.quantityBase ? Math.round(delta * input.quantityBase) : null,
    dishes: await dishImpact(input.itemId, input.pricePence),
    sayThis,
    source: input.source,
    latencyMs: input.latencyMs,
  }
}
