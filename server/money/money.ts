/** Reads prices and quantities out of spoken or typed text. Everything is plain code, no model. */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

const NUMBER_WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(TENS)].join('|')})`
const COMPOUND = `(?:${Object.keys(TENS).join('|')})[ -](?:${Object.keys(UNITS).filter((w) => UNITS[w] > 0 && UNITS[w] < 10).join('|')})`
const WORD_NUMBER = `(?:${COMPOUND}|${NUMBER_WORD})`

export function wordsToNumber(words: string): number | null {
  const text = words.toLowerCase().replace('-', ' ').trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(/\s+/)
  if (parts.length === 2 && TENS[parts[0]] !== undefined && UNITS[parts[1]] !== undefined) {
    return TENS[parts[0]] + UNITS[parts[1]]
  }
  if (parts.length === 1) return TENS[parts[0]] ?? UNITS[parts[0]] ?? null
  return null
}

const MEASURE = /^\s*(?:kilo|kilos|kg|kgs|kilogram|kilograms|litre|litres|liter|liters|l|box|boxes|case|cases|tray|trays|bag|bags|dozen|sack|sacks|pack|packs|tub|tubs)\b/i

export interface SpokenPrice {
  pence: number
  index: number
  text: string
}

/** Finds every price in a sentence, in order. "Twenty kilos" is a quantity, so it is left out. */
export function findPrices(input: string): SpokenPrice[] {
  const text = input.toLowerCase().replace(/[’']/g, "'").replace(/,(?=\d{2}\b)/g, '.')
  const found: SpokenPrice[] = []
  const taken: Array<[number, number]> = []
  const add = (index: number, length: number, pence: number) => {
    if (pence <= 0 || pence > 100000) return
    if (taken.some(([a, b]) => index < b && index + length > a)) return
    taken.push([index, index + length])
    found.push({ pence, index, text: input.slice(index, index + length) })
  }
  const run = (pattern: RegExp, handler: (m: RegExpExecArray) => number | null) => {
    for (const match of text.matchAll(pattern)) {
      const pence = handler(match as RegExpExecArray)
      if (pence !== null) add(match.index, match[0].length, pence)
    }
  }

  run(/£\s?(\d+)(?:\.(\d{1,2}))?/g, (m) => Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')))
  run(/\b(\d+)\s?(?:pounds?|quid)(?:\s+(?:and\s+)?(\d{1,2}))?\b/g, (m) => Number(m[1]) * 100 + Number(m[2] ?? 0))
  run(new RegExp(`\\b(${WORD_NUMBER})\\s+(?:pounds?|quid)(?:\\s+(?:and\\s+)?(${WORD_NUMBER}))?(?:\\s+pence)?\\b`, 'g'), (m) => {
    const pounds = wordsToNumber(m[1])
    const pence = m[2] ? wordsToNumber(m[2]) : 0
    return pounds === null || pence === null ? null : pounds * 100 + pence
  })
  run(/\b(\d{1,3})\s?(?:p|pence)\b/g, (m) => Number(m[1]))
  run(new RegExp(`\\b(${WORD_NUMBER})\\s+(?:p|pence)\\b`, 'g'), (m) => wordsToNumber(m[1]))
  run(/(?<![\d.])(\d{1,3})\.(\d{2})(?!\d)/g, (m) => Number(m[1]) * 100 + Number(m[2]))
  // "six ninety", "twelve fifty". The second word must be a tens value or a teen to read as pence.
  run(new RegExp(`\\b(${NUMBER_WORD})[ -](ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](one|two|three|four|five|six|seven|eight|nine))?\\b`, 'g'), (m) => {
    const after = text.slice(m.index + m[0].length)
    if (MEASURE.test(after)) return null
    const pounds = wordsToNumber(m[1])
    const pence = wordsToNumber(m[3] ? `${m[2]} ${m[3]}` : m[2])
    return pounds === null || pence === null ? null : pounds * 100 + pence
  })

  return found.sort((a, b) => a.index - b.index)
}

export interface SpokenQuantity {
  quantity: number
  unit: string
}

const QTY = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${WORD_NUMBER})\\s*(kilos?|kgs?|kilograms?|litres?|liters?|l|boxes|box|cases?|trays?|bags?|dozen|sacks?)\\b`, 'gi')

export function findQuantities(input: string): SpokenQuantity[] {
  const quantities: SpokenQuantity[] = []
  for (const match of input.matchAll(QTY)) {
    const quantity = wordsToNumber(match[1])
    if (quantity !== null) quantities.push({ quantity, unit: normaliseUnit(match[2]) })
  }
  return quantities
}

/** Every number said in a sentence, in digits or in words. Used to check a model's reading against the words. */
export function findNumbers(input: string): number[] {
  const numbers: number[] = []
  for (const match of input.toLowerCase().matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)|(${WORD_NUMBER})`, 'g'))) {
    const value = match[1] ? Number(match[1]) : wordsToNumber(match[2])
    if (value !== null) numbers.push(value)
  }
  return numbers
}

export function normaliseUnit(unit: string): string {
  const u = unit.toLowerCase()
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(u)) return 'kg'
  if (/^(l|litre|litres|liter|liters)$/.test(u)) return 'l'
  if (/^(box|boxes|case|cases|tray|trays|sack|sacks|bag|bags)$/.test(u)) return 'case'
  if (u === 'dozen') return 'dozen'
  return 'each'
}

export function formatPounds(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return 'not known'
  const rounded = Math.round(pence)
  const sign = rounded < 0 ? '-' : ''
  return `${sign}£${(Math.abs(rounded) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function nearly(a: number, b: number, tolerancePence = 2) {
  return Math.abs(a - b) <= tolerancePence
}
