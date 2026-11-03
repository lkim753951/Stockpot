/**
 * Reads the values printed in a file: units, packs, money, dates and times. All of it is plain code, and none of it
 * guesses. Each reader gives null when it isn't sure, and the owner is asked instead.
 */

export type BaseUnit = 'kg' | 'l' | 'each'

/** How much of a kilo, a litre or one thing each word means. A cup, a bunch or a clove has no fixed size, so none of them are here. */
const UNIT_WORDS: Array<[BaseUnit, number, string[]]> = [
  ['kg', 1, ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms']],
  ['kg', 0.001, ['g', 'gm', 'gms', 'gram', 'grams', 'gramme', 'grammes']],
  ['kg', 0.000001, ['mg']],
  ['kg', 0.0283495, ['oz', 'ounce', 'ounces']],
  ['kg', 0.453592, ['lb', 'lbs', 'pound', 'pounds']],
  ['l', 1, ['l', 'lt', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters']],
  ['l', 0.001, ['ml', 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters']],
  ['l', 0.01, ['cl']],
  ['l', 0.1, ['dl']],
  ['l', 0.005, ['tsp', 'tsps', 'teaspoon', 'teaspoons']],
  ['l', 0.015, ['tbsp', 'tbsps', 'tbs', 'tablespoon', 'tablespoons']],
  ['l', 0.56826, ['pint', 'pints', 'pt']],
  ['l', 0.0284131, ['fl oz', 'floz']],
  ['each', 1, ['each', 'ea', 'whole', 'piece', 'pieces', 'pc', 'pcs', 'unit', 'units', 'item', 'items', 'no', 'nr']],
]
const UNITS = new Map(UNIT_WORDS.flatMap(([base, factor, words]) => words.map((word) => [word, { base, factor }] as const)))

const unitKey = (unit: string) => unit.toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim()

export const knownUnit = (unit: string) => UNITS.get(unitKey(unit)) ?? null

/** Converts to kg, l or each. An empty unit is a plain count, like 2 eggs. Null means the unit can't be converted. */
export function toBase(quantity: number, unit: string | null | undefined) {
  const found = unit?.trim() ? knownUnit(unit) : { base: 'each' as BaseUnit, factor: 1 }
  return found ? { quantity: quantity * found.factor, unit: found.base } : null
}

const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 }
const FRACTION_MARKS = Object.keys(FRACTIONS).join('')
const NUMBER = String.raw`\d+(?:[.,]\d+)?`

/** A printed quantity: 2, 1.5, ½, 1/2 or 1 1/2. */
export function parseNumber(text: string): number | null {
  const value = text.trim().replace(/,(?=\d{3}\b)/g, '')
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  const mixed = value.match(new RegExp(`^(?:(\\d+)\\s*)?(?:([${FRACTION_MARKS}])|(\\d+)\\s*/\\s*(\\d+))$`))
  if (!mixed) return null
  const part = mixed[2] ? FRACTIONS[mixed[2]] : Number(mixed[3]) / Number(mixed[4])
  return Number.isFinite(part) ? Number(mixed[1] ?? 0) + part : null
}

/** A cell that holds both, like 200g, 1.5 kg or ½ tsp. */
export function parseAmount(text: string) {
  const match = text.trim().match(new RegExp(`^([\\d.,/\\s${FRACTION_MARKS}]*\\d|[\\d.,/\\s]*[${FRACTION_MARKS}])\\s*([\\p{L} ]*)\\.?$`, 'u'))
  if (!match) return null
  const quantity = parseNumber(match[1])
  return quantity === null ? null : { quantity, unit: match[2].trim() }
}

/**
 * What a price buys, from words like 10kg, 25 kg sack, 6 x 1l, 12x400g, case of 12 or per kg.
 * Words after the size, like sack or box, don't change it. A pack with no size at all can't be converted.
 */
export function parsePack(text: string) {
  const words = text.toLowerCase().replace(/[()]/g, ' ').replace(/\bper\b|\//g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return null
  const times = words.match(new RegExp(`(${NUMBER})\\s*[x×*]\\s*(${NUMBER})\\s*(fl oz|[a-z]+)`))
  if (times) {
    const base = toBase(Number(times[1]) * Number(times[2]), times[3])
    if (base) return base
  }
  const counted = words.match(/\b(?:case|box|tray|pack|bag|crate|sleeve) of (\d+)\b/) ?? words.match(/^(\d+)\s*(?:pack|pk)\b/)
  if (counted) return { quantity: Number(counted[1]), unit: 'each' as BaseUnit }
  const sized = words.match(new RegExp(`(${NUMBER})\\s*(fl oz|[a-z]+)`))
  if (sized) {
    const base = toBase(Number(sized[1].replace(',', '.')), sized[2])
    if (base) return base
  }
  const plain = words.split(' ').find((word) => knownUnit(word))
  return plain ? toBase(1, plain) : null
}

/** A UK money cell in pounds: 95, 1,234.50, £9.50 or 12.50 GBP. Brackets mean minus. Null if it isn't clearly one of those. */
export function parseMoney(text: string): number | null {
  const value = text.trim().replace(/^£\s*|\s*(?:£|GBP)$/gi, '').replace(/^GBP\s*/i, '').trim()
  const bracketed = value.match(/^\((.*)\)$/)
  const body = (bracketed ? bracketed[1] : value).replace(/^£\s*/, '')
  const minus = !!bracketed || body.startsWith('-')
  const digits = body.replace(/^-\s*£?\s*/, '')
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\.\d+$/.test(digits)) return null
  const amount = Number(digits.replace(/,/g, ''))
  return minus ? -amount : amount
}

const realDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const fullYear = (year: string) => Number(year.length === 2 ? `20${year}` : year)

export type DayOrder = 'day_first' | 'month_first'

/** The two numbers of a date like 03/08/2026, when it has that shape. */
const slashed = (text: string) => text.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/)

/** A date in a file. A slashed date with no clue which number is the day reads the UK way. */
export function parseDate(text: string, order: DayOrder = 'day_first'): string | null {
  const value = text.trim()
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const parts = slashed(value)
  if (parts) {
    const [day, month] = order === 'day_first' ? [parts[1], parts[2]] : [parts[2], parts[1]]
    return realDate(fullYear(parts[3]), Number(month), Number(day))
  }
  const named = value.replace(/,/g, ' ').toLowerCase().match(/(?:^|\s)(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?\s+(\d{4}|\d{2})$/)
    ?? value.replace(/,/g, ' ').toLowerCase().replace(/^(?:[a-z]+\s+)?([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/, '0 $2 $1 $3').match(/^0 (\d{1,2}) ([a-z]{3}) (\d{4})$/)
  if (named && MONTHS.includes(named[2])) return realDate(fullYear(named[3]), MONTHS.indexOf(named[2]) + 1, Number(named[1]))
  // Excel's own day count, for a date column saved as plain numbers.
  if (/^\d{5}$/.test(value) && Number(value) > 36000 && Number(value) < 60000) return new Date(Date.UTC(1899, 11, 30) + Number(value) * 86400000).toISOString().slice(0, 10)
  return null
}

/** Only a number over 12 proves which way round a file writes its dates, so every row is checked. Null means no row proves it. */
export function provenDayOrder(cells: string[]): DayOrder | null {
  for (const cell of cells) {
    const parts = slashed(cell)
    if (parts && Number(parts[1]) > 12) return 'day_first'
    if (parts && Number(parts[2]) > 12) return 'month_first'
  }
  return null
}

/** A printed time in minutes: 45, 45 minutes, 1 hour, 1 hr 30, 1h 30m or 1.5 hours. Null if it holds no clear time. */
export function minutesFrom(text: string): number | null {
  const value = text.toLowerCase().trim()
  const hours = value.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/) ?? (value.match(/\ban hour\b/) ? [, '1'] as const : null)
  const after = hours ? value.slice(value.indexOf(hours[0] ?? '') + (hours[0]?.length ?? 0)) : value
  const minutes = after.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)?\b/)
  if (hours) return Math.round(Number(hours[1]) * 60 + (minutes ? Number(minutes[1]) : 0))
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value))
  const labelled = value.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/)
  return labelled ? Math.round(Number(labelled[1])) : null
}

/** Every number printed in a text, so code can tell if a model's number really came from the file. */
export function numbersIn(text: string) {
  const found = new Set<number>()
  const add = (value: number | null) => { if (value !== null && Number.isFinite(value)) found.add(Math.round(value * 1000) / 1000) }
  const clean = text.replace(/(\d),(?=\d{3}\b)/g, '$1')
  for (const match of clean.matchAll(new RegExp(`(?:\\d+\\s+)?\\d+\\s*/\\s*\\d+|\\d*\\s*[${FRACTION_MARKS}]`, 'g'))) add(parseNumber(match[0]))
  for (const match of clean.matchAll(/\d+(?:\.\d+)?/g)) add(Number(match[0]))
  return found
}

/** Whether a number is in the file, allowing for rounding in how it's written. */
export function printedIn(value: number, numbers: Set<number>) {
  return numbers.has(Math.round(value * 1000) / 1000)
}

/** A name with case, spacing and punctuation taken out, so the same thing matches however it's written. */
export const nameKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()

/** Whether a price in pence is printed in a file, as pounds or as a figure with a p after it. */
export const pricePrinted = (pence: number, numbers: Set<number>, text: string) => printedIn(pence / 100, numbers) || new RegExp(`\\b${pence}\\s?p\\b`).test(text)

/** The same words however they're spaced or capitalised, for finding a quote in a file. */
export const sameWords = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
