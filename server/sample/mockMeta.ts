import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { findNumbers, findPrices, findQuantities, formatPounds } from '../money/money.ts'

/**
 * A stand-in for the Meta API, matching the documented wire formats.
 * It runs the app with no key, and it lets the tests exercise the real client code.
 * It follows a script. It does not understand speech or read documents.
 */

export interface ScriptTurn {
  turn: number
  speaker: string
  startMs: number
  endMs: number
  text: string
}

const samples = path.resolve('public/samples')
export const sampleScript = (): ScriptTurn[] => JSON.parse(fs.readFileSync(path.join(samples, 'sample-call.json'), 'utf8'))

/** Which words each sample clip contains. The stand-in tells clips apart by their length. */
const clipFor = (bytes: number) => {
  const known: Array<[string, string]> = [
    ['sample-fridge.wav', 'Fridge two is at nine degrees.'],
    ['sample-report.wav', 'Druga lodówka nie chłodzi, temperatura wciąż rośnie i jedzenie może się zepsuć.'],
  ]
  for (const [file, words] of known) {
    const full = path.join(samples, file)
    if (fs.existsSync(full) && fs.statSync(full).size === bytes) return words
  }
  return null
}

const today = () => new Date().toISOString().slice(0, 10)
function nextWeekday(target: number) {
  const date = new Date()
  const ahead = (target - date.getUTCDay() + 7) % 7 || 7
  date.setUTCDate(date.getUTCDate() + ahead)
  return date.toISOString().slice(0, 10)
}

function jsonReply(content: unknown) {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }
}

function itemIdFrom(system: string, name: string) {
  const match = system.match(new RegExp(`^(\\d+): [^\\n]*${name}`, 'im'))
  return match ? Number(match[1]) : null
}

/** What a careful reader would answer for each sample file. The stand-in can't read a PDF or a photo, so it looks the answer up by file name. */
function sampleReads() {
  const reads = new Map<string, any>([['sample-recipe.pdf', JSON.parse(fs.readFileSync(path.join(samples, 'sample-recipe.json'), 'utf8'))]])
  const folder = path.join(samples, 'datasets')
  for (const month of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    const truth = path.join(folder, month, 'ground-truth.json')
    if (fs.existsSync(truth)) for (const entry of JSON.parse(fs.readFileSync(truth, 'utf8')).files) reads.set(entry.file, entry.read)
  }
  return reads
}
/** The browser sends a photo as a JPEG, so a sample PNG is found by its name without the ending too. */
const sampleRead = (text: string) => {
  const name = text.match(/^File name: (.+)$/m)?.[1]?.trim() ?? ''
  const reads = sampleReads()
  const stem = (file: string) => file.replace(/\.(png|jpe?g|webp)$/i, '')
  return reads.get(name) ?? [...reads].find(([file]) => /\.(png|jpe?g|webp)$/i.test(file) && stem(file) === stem(name))?.[1] ?? null
}

const COLUMN_WORDS: Record<string, Array<[string, RegExp]>> = {
  sales: [['date', /date|^day/i], ['dish', /dish|menu item|^item|^product/i], ['quantity', /qty|quantity|sold|portions/i], ['net_sales', /\bnet\b|ex vat|^sales$|revenue/i]],
  ingredients: [['item', /product|description|^item/i], ['pack', /pack|size/i], ['unit', /^unit$|uom/i], ['price', /price|£|gbp/i]],
  recipes: [['dish', /recipe|dish/i], ['portions', /serves|portions/i], ['ingredient', /ingredient/i], ['quantity', /qty|quantity|amount/i], ['unit', /uom|unit/i], ['prep', /prep/i], ['service', /service/i], ['method', /method/i]],
}

/** Matches column names by their words, so any sensible sheet works in the sample. It sees what Muse Spark would: the top of the file. */
function columnReply(kind: string, text: string) {
  const words = COLUMN_WORDS[kind]
  const rows = [...text.matchAll(/^Row (\d+): (.*)$/gm)].map((match) => ({ index: Number(match[1]), cells: match[2].split(' | ').map((cell) => cell.replace(/^\[\d+\] ?/, '')) }))
  const pick = (cells: string[]) => {
    const columns: Record<string, number | null> = Object.fromEntries(words.map(([key]) => [key, null]))
    cells.forEach((cell, index) => {
      const hit = words.find(([key, pattern]) => columns[key] === null && pattern.test(cell))
      if (hit) columns[hit[0]] = index
    })
    return columns
  }
  const header = rows.find(({ cells }) => Object.values(pick(cells)).filter((column) => column !== null).length >= 2)
  const columns = header ? pick(header.cells) : Object.fromEntries(words.map(([key]) => [key, null]))
  const price = kind === 'ingredients' && header && columns.price !== null ? header.cells[columns.price!] : ''
  const known = sampleRead(text)
  return {
    header_row: header?.index ?? null, columns, money_in: /pence/i.test(header?.cells.join(' ') ?? '') ? 'pence' : 'pounds',
    price_is: /per unit|per kg|\/kg/i.test(price) ? 'per_unit' : /case|pack/i.test(price) ? 'per_pack' : null,
    date_order: null, supplier_name: known?.supplier_name ?? null, list_date: known?.list_date ?? null,
  }
}

/** Typical catering prices, so the sample can show an estimate for any dish. Pence a kg, a litre or an item. */
const TYPICAL: Array<[RegExp, number]> = [
  [/lamb/i, 1100], [/beef|steak/i, 1000], [/chicken/i, 650], [/salmon|fish|cod|haddock/i, 1400], [/prawn/i, 1600],
  [/cheese|feta|halloumi|paneer/i, 900], [/butter|ghee/i, 700], [/oil/i, 300], [/cream|yogh?urt|milk/i, 250],
  [/rice/i, 180], [/chickpea|lentil|bean|dal/i, 220], [/flour|pasta|noodle/i, 120], [/onion|potato|carrot/i, 90],
  [/tomato/i, 220], [/garlic|ginger|chilli|herb|coriander|parsley|mint/i, 900], [/spice|cumin|turmeric|garam|paprika/i, 1500],
  [/bread|bun|wrap|flatbread|naan|pitta/i, 35], [/egg/i, 25], [/lemon|lime/i, 30],
]
const typical = (name: string, unit: string) => TYPICAL.find(([pattern]) => pattern.test(name))?.[1] ?? (unit === 'each' ? 40 : 350)

/** Typical bulk densities, kg a litre, so the sample can estimate any ingredient. */
const DENSITIES: Array<[RegExp, number]> = [
  [/oil/i, 0.92], [/cream|milk|yogh?urt|stock|sauce|juice/i, 1.02], [/rice|lentil|sugar|salt/i, 0.85], [/flour/i, 0.55], [/pasta|noodle/i, 0.45],
  [/onion|potato|carrot|tomato/i, 0.6], [/chicken|lamb|beef|pork|mince|fish/i, 0.75], [/butter|ghee|cheese|paneer/i, 0.9], [/herb|coriander|parsley|mint|spinach/i, 0.15], [/spice|cumin|turmeric|paprika/i, 0.5],
]
const densityReply = (text: string) => ({
  densities: [...text.matchAll(/^\d+\. (.+)$/gm)].map(([, name]) => ({ name, kg_per_litre: DENSITIES.find(([pattern]) => pattern.test(name))?.[1] ?? 0.6 })),
})

function estimateReply(text: string) {
  const listed = [...text.matchAll(/^\d+\. (.+): ([\d.]+) (g|ml|each)$/gm)]
  if (listed.length) return { ingredients: listed.map(([, name, quantity, unit]) => ({ name, quantity: Number(quantity), unit, pence_per_unit: typical(name, unit) })) }
  const dish = text.match(/^Dish: (.+)$/m)?.[1] ?? ''
  const main = /lamb/i.test(dish) ? 'Lamb mince' : /chicken/i.test(dish) ? 'Chicken thighs' : /dal|lentil/i.test(dish) ? 'Red lentils' : /chickpea/i.test(dish) ? 'Chickpeas' : /fish|cod/i.test(dish) ? 'Cod fillet' : 'Mixed vegetables'
  const rows: Array<[string, number, string]> = [[main, 160, 'g'], ['Onions', 60, 'g'], ['Chopped tomatoes', 80, 'g'], ['Garlic and ginger', 10, 'g'], ['Spices', 4, 'g'], ['Rapeseed oil', 15, 'ml'], ['Basmati rice', 90, 'g']]
  return { ingredients: rows.map(([name, quantity, unit]) => ({ name, quantity, unit, pence_per_unit: typical(name, unit) })) }
}

function replyFor(name: string, system: string, text: string) {
  if (name.startsWith('ingest_columns_')) return columnReply(name.replace('ingest_columns_', ''), text)
  if (['ingest_sales', 'ingest_prices', 'ingest_recipes'].includes(name)) {
    const known = sampleRead(text)
    if (!known) throw new Error('The sample has no answer for this file.')
    return known
  }
  if (name === 'proof_target') return { target: 'fryer' }
  if (name === 'call_script_words') return { opening: `Hi ${text.match(/Contact: ([^.]+)\./)?.[1] ?? 'there'}, it's about our last delivery. Have you got a minute?`, ask: 'Could you send the rest over, or put a credit note through, please?', pushback: 'No problem, I can send you the photos and the invoice now.' }
  if (name === 'dish_estimate') return estimateReply(text)
  if (name === 'ingredient_density') return densityReply(text)
  if (name === 'menu') {
    return { dishes: [
      { name: 'Lamb kofta', price_pence: 1250, ingredients: [{ name: 'Lamb mince', quantity: 180, unit: 'g' }, { name: 'Flatbread', quantity: 1, unit: 'each' }] },
      { name: 'Soup of the day', price_pence: null, ingredients: [] },
    ] }
  }
  const thighs = itemIdFrom(system, 'chicken thighs')!
  const onions = itemIdFrom(system, 'brown onions')!
  if (name === 'call_quotes') {
    const newest = text.split('Newest turn:\n')[1] ?? text
    const quote = (over: object) => ({ per: 'base', price_pence: null, price_change_pence: null, quantity: null, quantity_unit: null, kind: 'offer', ...over })
    if (/Twenty kilos of chicken thighs/.test(newest)) return { quotes: [quote({ item_id: thighs, new_item_name: null, quantity: 20, quantity_unit: 'kg' })] }
    if (/gone up.*six ninety/i.test(newest)) return { quotes: [quote({ item_id: thighs, price_pence: 690 })] }
    if (/I paid six forty/i.test(newest)) return { quotes: [quote({ item_id: thighs, kind: 'reference', price_pence: 640 })] }
    if (/Go on then, six forty/i.test(newest)) return { quotes: [quote({ item_id: thighs, kind: 'agreed', price_pence: 640 })] }
    if (/ten kilos of brown onions/i.test(newest)) return { quotes: [quote({ item_id: onions, new_item_name: null, quantity: 10, quantity_unit: 'kg' })] }
    if (/Onions are eighty five/i.test(newest)) return { quotes: [quote({ item_id: onions, kind: 'agreed', price_pence: 85 })] }
    return { quotes: [] }
  }
  if (name === 'reminder_call' && /Worded list/.test(text)) return { message: 'This is Stockpot. Worded list was due at noon. The fryer is still not done, so please do it now.' }
  if (name === 'draft_order') {
    if (/chicken thighs/i.test(text)) {
      const turnOf = (pattern: RegExp) => Number(text.match(new RegExp(`Turn (\\d+) [^\\n]*${pattern.source}`, 'i'))?.[1] ?? 0) || null
      return {
        speaker_roles: [{ speaker: 'A', role: 'owner' }, { speaker: 'B', role: 'supplier' }],
        lines: [
          { item_id: thighs, new_item_name: null, quantity: 20, quantity_unit: 'kg', agreed_price_pence: 640, per: 'base', evidence_turn: turnOf(/Go on then/) },
          { item_id: onions, new_item_name: null, quantity: 10, quantity_unit: 'kg', agreed_price_pence: 85, per: 'base', evidence_turn: turnOf(/Onions are/) },
        ],
        delivery_date: nextWeekday(4),
        summary: 'Ordered 20 kg chicken thighs and 10 kg brown onions for Thursday morning. Thighs agreed at £6.40 a kilo.',
        tasks: [],
      }
    }
    const quantity = findQuantities(text)[0]
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].findIndex((day) => text.toLowerCase().includes(day))
    return {
      speaker_roles: [{ speaker: 'A', role: 'owner' }],
      lines: quantity && /onions/i.test(text)
        ? [{ item_id: onions, new_item_name: null, quantity: quantity.quantity, quantity_unit: 'kg', agreed_price_pence: findPrices(text)[0]?.pence ?? null, per: 'base', evidence_turn: 1 }]
        : [],
      delivery_date: weekday >= 0 ? nextWeekday(weekday) : null,
      summary: 'Short call about an order.',
      tasks: [],
    }
  }
  if (name === 'invoice') {
    const supplierId = (supplier: string) => Number(system.match(new RegExp(`^(\\d+): ${supplier}`, 'm'))?.[1])
    if (/sample-receipt-northgate/.test(text)) {
      const rice = itemIdFrom(system, 'basmati rice')!
      const oil = itemIdFrom(system, 'rapeseed oil')!
      return {
        supplier_id: supplierId('Northgate Wholesale'), supplier_name: 'Northgate Wholesale', invoice_number: 'NG-7741', invoice_date: today(),
        lines: [
          { description: 'Basmati rice', item_id: rice, quantity: 5, unit: 'kg', pack_quantity: null, unit_price_pence: 195, line_total_pence: 925, vat_rate: 0 },
          { description: 'Rapeseed oil', item_id: oil, quantity: 4, unit: 'l', pack_quantity: null, unit_price_pence: 160, line_total_pence: 640, vat_rate: 0 },
        ],
        net_total_pence: 1565, vat_total_pence: 0, gross_total_pence: 1565, unreadable: [],
      }
    }
    if (/sample-receipt-oakfield/.test(text)) {
      return {
        supplier_id: supplierId('Oakfield Dairy'), supplier_name: 'Oakfield Dairy', invoice_number: 'OD-1183', invoice_date: today(),
        lines: [{ description: 'Double cream', item_id: itemIdFrom(system, 'double cream')!, quantity: 6, unit: 'l', pack_quantity: null, unit_price_pence: 320, line_total_pence: 1920, vat_rate: 0 }],
        net_total_pence: 1920, vat_total_pence: 0, gross_total_pence: 1920, unreadable: [],
      }
    }
    if (!/sample-invoice/.test(text)) {
      return { supplier_id: null, supplier_name: null, invoice_number: null, invoice_date: null, lines: [], net_total_pence: null, vat_total_pence: null, gross_total_pence: null, unreadable: ['The whole document'] }
    }
    return {
      supplier_id: Number(system.match(/^(\d+): Harrow Lane Foods/m)?.[1]),
      supplier_name: 'Harrow Lane Foods', invoice_number: 'HLF-20418', invoice_date: today(),
      lines: [
        { description: 'Chicken thighs, boneless', item_id: thighs, quantity: 20, unit: 'kg', pack_quantity: null, unit_price_pence: 690, line_total_pence: 13800, vat_rate: 0 },
        { description: 'Brown onions', item_id: onions, quantity: 10, unit: 'kg', pack_quantity: null, unit_price_pence: 85, line_total_pence: 850, vat_rate: 0 },
      ],
      net_total_pence: 14650, vat_total_pence: 0, gross_total_pence: 14650, unreadable: [],
    }
  }
  if (name === 'delivery_note') {
    return { lines: [{ item_id: thighs, quantity_received: 18 }, { item_id: onions, quantity_received: 10 }], handwritten_notes: ['2 kg short, driver says back order'] }
  }
  if (name === 'credit_request_words') {
    return {
      subject: 'Credit request for this week\'s delivery',
      opening: 'Hi Dave, we checked this delivery against our call and found a couple of differences.',
      closing: 'Could you send a credit note for these lines, please? Thanks for sorting this.',
    }
  }
  if (name === 'reading_from_speech') {
    const item = text.match(/fridge (one|two)|freezer|hot water/i)?.[0]
    const id = item ? system.match(new RegExp(`^(\\d+): ${item}`, 'im'))?.[1] : null
    const value = findNumbers(text).at(-1) ?? null
    return { item_id: id ? Number(id) : null, value, unclear: !id || value === null }
  }
  if (name === 'thermometer_reading') {
    return /sample-thermometer/.test(text) ? { reading: 9, unit: 'C', unclear: false } : { reading: null, unit: null, unclear: true }
  }
  if (name === 'staff_report') {
    if (/lodówka/i.test(text)) {
      return {
        language: 'Polish', english_text: 'The second fridge is not cooling. The temperature keeps rising and the food could spoil.',
        title: 'Fridge two is not cooling', category: 'equipment', urgency: 'now', safety: true, crisis_key: 'fridge',
      }
    }
    if (/burn|cut my|allergy|exposed wire/i.test(text)) return { language: 'English', english_text: text, title: 'Someone could get hurt', category: 'staff', urgency: 'now', safety: true, crisis_key: null }
    if (/undercooked|off smell|cross contamination/i.test(text)) return { language: 'English', english_text: text, title: 'Food safety problem', category: 'food-safety', urgency: 'now', safety: false, crisis_key: null }
    return { language: 'English', english_text: text, title: 'Staff report', category: 'other', urgency: 'soon', safety: false, crisis_key: null }
  }
  if (name === 'team_reply') {
    const checks = [...system.matchAll(/^(\d+): (.+?)(?: \(.*\))?, (tick|reading)$/gm)].map((match) => ({ id: Number(match[1]), label: match[2], type: match[3] }))
    const found = checks.filter((check) => text.toLowerCase().includes(check.label.toLowerCase()))
    const language = /nie chłodzi|lodówka|lodówki|stopni/i.test(text) ? 'pl' : 'en'
    if (/broken|not cooling|leak|smell|nie chłodzi|lodówka/i.test(text)) return { kind: 'report', language, updates: [] }
    if (!found.length) return { kind: /\?|please|need/i.test(text) ? 'report' : 'unclear', language, updates: [] }
    const value = findNumbers(text).at(-1) ?? null
    return { kind: 'checks', language, updates: found.map((check) => ({ item_id: check.id, value: check.type === 'tick' ? null : value })) }
  }
  if (name === 'voice_turn') {
    const facts = JSON.parse(text)
    const newest = String(facts.newest)
    if (/^yes/i.test(newest)) return { say: 'Saved. Goodbye.', updates: [], confirmed: true, problem: false, finished: true }
    if (/broken|leak/i.test(newest)) return { say: 'I will tell the owner.', updates: [], confirmed: false, problem: true, finished: false }
    const found = facts.open_checks.filter((check: any) => newest.toLowerCase().includes(check.label.toLowerCase()))
    return { say: found.length ? 'Is that right?' : 'Which check?', updates: found.map((check: any) => ({ item_id: check.id, value: check.type === 'tick' ? null : findNumbers(newest).at(-1) ?? null })), confirmed: false, problem: false, finished: false }
  }
  if (name === 'connection_check') return { ok: true }
  if (name === 'analyst_answer') {
    const question = text.match(/^Question: (.*)$/m)?.[1] ?? ''
    if (/trend|week by week|over time|going/i.test(question)) {
      return { answer: 'Food cost moved up in the latest week, after staying level before that.', views: [{ result: 0, kind: 'line', title: 'Food cost by week' }] }
    }
    if (/price|supplier|went up/i.test(question)) {
      return { answer: 'Chicken thighs from Harrow Lane Foods had the biggest price change this week.', views: [{ result: 0, kind: 'table', title: 'Price changes this week' }] }
    }
    return { answer: 'Chicken curry brings in the most sales this week.', views: [{ result: 0, kind: 'bar', title: 'Net sales by dish' }, { result: 0, kind: 'table', title: 'Dish margins' }] }
  }
  if (name === 'weekly_summary') {
    const facts = JSON.parse(text.split('Facts:\n')[1].split('\n\nInvestigation results')[0])
    const pounds = formatPounds
    const top = facts.price_changes[0]
    const list = text.split('Source ids you can use: ')[1] ?? ''
    const ids = [...list.matchAll(/(invoice|call):\d+(?::\d+)?/g)].map((match) => match[0])
    const proof = [ids.find((id) => id.startsWith('invoice')), ids.filter((id) => id.startsWith('call')).at(-1)].filter(Boolean)
    return {
      headline: `Food cost rose ${facts.food_cost_change_points.toFixed(1)} points to ${facts.food_cost.food_cost_percent}%`,
      summary: `Sales held at ${pounds(facts.food_cost.net_sales_pence)}, but recipe food cost went from ${pounds(facts.previous_food_cost.food_cost_pence)} to ${pounds(facts.food_cost.food_cost_pence)}.`,
      cause: `${top.supplier} raised ${top.item} from ${pounds(top.before_pence)} to ${pounds(top.now_pence)} a kilo, which cost ${pounds(top.extra_cost_on_sales_pence)} on this week's sales.`,
      actions: [
        { title: `Ask ${top.supplier} to hold the ${top.item} price`, why: 'It is the largest cost change this week.' },
        { title: `Get a quote for ${top.item} from another supplier`, why: 'A rival price gives you something to ask for on the next call.' },
        { title: 'Review the price of your best-selling dish', why: 'A small change protects the margin on most of your sales.' },
      ],
      source_ids: proof,
    }
  }
  throw new Error(`Unknown request ${name}`)
}

/** Follows a fixed investigation, so sample mode exercises the real tool loop. */
function toolTurn(payload: any) {
  const prompt = String(payload.messages[1].content)
  if (prompt.includes("The owner's question")) {
    const rounds = payload.messages.filter((message: any) => message.role === 'assistant').length
    if (rounds) return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Found it.' } }] }
    const question = prompt.split('\n').at(-1) ?? ''
    const [from, to, start] = prompt.match(/The owner is looking at (\S+) to (\S+)\..*The last 8 weeks start (\S+)\./)!.slice(1)
    const tool = /trend|week by week|over time|going/i.test(question) ? ['get_food_cost_trend', start, to] : /price|supplier|went up/i.test(question) ? ['get_price_changes', from, to] : ['get_sales', from, to]
    return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'ask_1', type: 'function', function: { name: tool[0], arguments: JSON.stringify({ from: tool[1], to: tool[2] }) } }] } }] }
  }
  const [from, to] = prompt.match(/\d{4}-\d{2}-\d{2}/g) ?? []
  const [lastFrom, lastTo] = (prompt.match(/\d{4}-\d{2}-\d{2}/g) ?? []).slice(2)
  const rounds = payload.messages.filter((message: any) => message.role === 'assistant').length
  const call = (name: string, args: object, index: number) => ({ id: `call_${rounds}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const plan = [
    [call('get_food_cost', { from, to }, 0), call('get_food_cost', { from: lastFrom, to: lastTo }, 1)],
    [call('get_sales', { from, to }, 0)],
    [call('get_price_changes', { from, to }, 0)],
    [call('get_source', { item: 'Chicken thighs', from, to }, 0)],
  ]
  const calls = plan.at(rounds)
  return calls
    ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] }
    : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Chicken thighs caused the rise.' } }] }
}

export interface MockOptions {
  script?: ScriptTurn[]
  delayMs?: number
  failRealtime?: boolean
  failSpark?: boolean
}

export async function startMockMeta(options: MockOptions = {}) {
  const state = {
    script: options.script ?? sampleScript(), realtimeStarts: [] as number[], videoUrls: [] as string[], requests: [] as string[], handshakes: [] as any[], failSpark: options.failSpark ?? false,
    calls: [] as any[], samBoxes: null as any[] | null, callError: null as any, samVideoFrames: null as number[] | null, samPhrases: [] as string[], proofVerdict: 'ok' as 'ok' | 'recheck', whatsapp: [] as any[], failWhatsapp: false, whatsappError: null as number | null, thermometerAlways: false, selfBase: '', media: null as Buffer | null, mediaType: 'image/png', clipSettings: [] as any[], clipWords: null as string | null, toolReplies: null as any[] | null, summaryOverride: null as any, ingestReply: null as any, ingestTexts: [] as string[],
  }

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    const answer = async () => {
      const body = Buffer.concat(chunks)
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (!/^(Bearer|Basic) /.test(request.headers.authorization ?? '')) return send(401, { error: 'missing key' })

      if (request.url?.startsWith('/chat/completions')) {
        const payload = JSON.parse(body.toString())
        const name = payload.response_format?.json_schema?.name ?? (payload.tools ? 'tool_loop' : undefined)
        state.requests.push(name)
        if (state.failSpark) return send(500, { error: 'mock failure' })
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        if (payload.tools) {
          if (state.toolReplies) return send(200, { choices: [{ message: state.toolReplies.shift() ?? { role: 'assistant', content: 'Done.' } }] })
          return send(200, toolTurn(payload))
        }
        if (name === 'weekly_summary' && state.summaryOverride) return send(200, jsonReply(state.summaryOverride))
        const system = payload.messages[0].content
        const text = payload.messages[1].content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        if (/^ingest_/.test(name)) {
          state.ingestTexts.push(text)
          if (state.ingestReply) return send(200, jsonReply(state.ingestReply))
        }
        if (name === 'proof_check') return send(200, jsonReply({ verdict: state.proofVerdict, reason: state.proofVerdict === 'ok' ? 'The picture shows what the check asks for.' : 'The picture is too dark to be sure.', reading: /temperature|Fridge|Freezer|water/i.test(text) ? 4 : null }))
        if (name === 'thermometer_reading' && state.thermometerAlways) return send(200, jsonReply({ reading: 9, unit: 'C', unclear: false }))
        // The script is written for the sample week. Anything else gets an error, and the app's plain version takes over.
        try { return send(200, jsonReply(replyFor(name, system, text))) } catch { return send(422, { error: 'the sample script has no answer for this' }) }
      }

      if (request.url?.startsWith('/responses')) {
        const payload = JSON.parse(body.toString())
        state.requests.push(payload.model)
        if (payload.model !== 'sam-3.1' || !/"input_(image|video)"/.test(body.toString())) return send(404, { error: { code: 'model_not_found' } })
        const phrase = payload.input[0].content.find((part: any) => part.type === 'input_text').text
        const boxes = state.samBoxes ?? [{ x1: 120, y1: 90, x2: 860, y2: 700, c: 0.91 }]
        const isVideo = /"input_video"/.test(body.toString())
        if (isVideo) state.videoUrls.push(String(payload.input[0].content.find((part: any) => part.type === 'input_video').video_url))
        // The sample delivery clip pans past four boxes, so the stand-in answers with what's on screen.
        const sack = (frame: number) => [60, 270, 480, 700].flatMap((left, id) => {
          const camera = (frame / 59) * 480
          const [x1, x2] = [Math.round(Math.max(0, left - camera)), Math.round(Math.min(480, left + 170 - camera))]
          return x2 - x1 >= 70 ? [`${id}<|box;x1=${x1};y1=120;x2=${x2};y2=305;w=480;h=360;c=0.9|><|mask;x=0;y=0;data=1,!AA|>`] : []
        })
        const pan = phrase === 'cardboard box' ? [...Array(60).keys()].map((frame) => `<${frame}f>${sack(frame).join(',')}`).join('\n') : null
        const clip = pan ?? (state.samVideoFrames ?? [...Array(26).keys()].slice(6)).map((frame: number) => `<${frame}f>0<|box;x1=${100 + frame};y1=90;x2=${500 + frame};y2=600;w=1000;h=800;c=0.9|><|mask;x=0;y=0;data=1,!AA|>`).join('\n')
        const text = isVideo ? clip : `<0f>${boxes.map((box: any, index: number) => `${index ? ',' : ''}${index}<|box;x1=${box.x1};y1=${box.y1};x2=${box.x2};y2=${box.y2};w=1000;h=800;c=${box.c}|><|mask;x=0;y=0;data=46,101,!abc|>`).join('')}`
        state.samPhrases.push(phrase)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text.slice(0, 40) })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text.slice(40) })}\n\n`)
        return response.end(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
      }

      if (/\?fields=display_phone_number$/.test(request.url ?? '')) return send(200, { display_phone_number: '+44 7700 900111' })
      if (/\/Calls\.json$/.test(request.url ?? '')) {
        state.calls.push({ url: request.url, body: body.toString() })
        if (state.callError) return send(400, state.callError)
        return send(201, { sid: 'CA123' })
      }

      if (/^\/media-/.test(request.url ?? '')) return send(200, { url: `${state.selfBase}/download${request.url}`, mime_type: state.mediaType, file_size: state.media?.length ?? 0 })
      if (/^\/download\//.test(request.url ?? '')) {
        response.writeHead(200, { 'Content-Type': state.mediaType })
        return response.end(state.media)
      }

      if (/^\/[^/]+\/messages$/.test(request.url ?? '')) {
        state.whatsapp.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(body.toString()) })
        if (state.failWhatsapp) return send(401, { error: { message: 'Bad token', code: state.whatsappError ?? undefined } })
        return send(200, { messages: [{ id: `wamid.mock.${state.whatsapp.length}` }] })
      }

      if (request.url?.startsWith('/asr/transcribe')) {
        state.requests.push('transcribe')
        const text = body.toString('latin1')
        if (!/"audioEncoding":"WAV"/.test(text)) return send(400, { error: 'bad settings' })
        const riff = body.indexOf('RIFF')
        if (/"mode":"PUSH_TO_TALK"/.test(text)) {
          state.clipSettings.push(JSON.parse(text.slice(text.indexOf('{"mode"'), text.indexOf('}', text.indexOf('{"mode"')) + 1)))
          const words = state.clipWords ?? clipFor(body.readUInt32LE(riff + 4) + 8) ?? 'Fridge two is at nine degrees.'
          return send(200, { sessionId: 'mock', transcript: words, audioDurationMs: 3000, turns: [] })
        }
        if (!/"mode":"DIARIZATION"/.test(text)) return send(400, { error: 'bad settings' })
        if (riff < 0 || body.subarray(riff + 8, riff + 12).toString() !== 'WAVE') return send(400, { error: 'Unsupported WAV' })
        if (body.readUInt16LE(riff + 22) !== 1 || body.readUInt32LE(riff + 24) !== 24000 || body.readUInt16LE(riff + 34) !== 16) return send(400, { error: 'Unsupported WAV' })
        return send(200, {
          sessionId: 'mock', transcript: state.script.map((turn) => turn.text).join(' '),
          audioDurationMs: state.script.at(-1)?.endMs ?? 0,
          turns: state.script.map((turn) => ({ turnId: turn.turn, startMs: turn.startMs, endMs: turn.endMs, transcript: turn.text, speaker: turn.speaker })),
        })
      }
      send(404, { error: 'not found' })
    }
    request.on('end', () => {
      answer().catch((error) => {
        console.error('mock:', (error as Error).message)
        response.destroy()
      })
    })
  })

  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket, request) => {
    let accepted = false
    // A second connection for one call is a new session. It carries on the script and counts its own time, as Meta's would.
    const startMs = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('startMs') ?? 0)
    const relative = (ms: number) => Math.max(0, Math.round(ms - startMs))
    state.realtimeStarts.push(startMs)
    let bytes = 0
    let cursor = state.script.findIndex((turn) => turn.endMs > startMs)
    if (cursor < 0) cursor = state.script.length
    let partial = 0
    const advance = (flush = false) => {
      const ms = startMs + (bytes / 48000) * 1000
      while (cursor < state.script.length) {
        const turn = state.script[cursor]
        if (ms < turn.startMs && !flush) return
        const words = turn.text.split(' ')
        const spoken = flush ? 1 : Math.min(1, (ms - turn.startMs) / (turn.endMs - turn.startMs))
        const count = Math.ceil(words.length * spoken)
        if (count > partial && spoken < 1) {
          partial = count
          socket.send(JSON.stringify({ type: 'transcript', transcript: `${words.slice(0, count).join(' ')} `, final: false, audioProcessedMs: relative(ms) }))
        }
        if (spoken < 1) return
        socket.send(JSON.stringify({ type: 'speechEnd', turnId: turn.turn, audioProcessedMs: relative(turn.endMs) }))
        socket.send(JSON.stringify({ type: 'speechComplete', turnId: turn.turn, transcript: turn.text, audioProcessedMs: relative(turn.endMs) }))
        cursor += 1
        partial = 0
      }
    }
    socket.on('message', (data, isBinary) => {
      if (!accepted) {
        const handshake = JSON.parse(data.toString())
        state.handshakes.push(handshake)
        if (!handshake.authorization?.accessToken?.startsWith('Bearer ') || handshake.audioEncoding !== 'PCM_24KHZ' || options.failRealtime) {
          socket.send(JSON.stringify({ type: 'error', message: 'Session refused.', sessionId: '' }))
          return socket.close()
        }
        accepted = true
        return socket.send(JSON.stringify({ sessionId: 'mock-session' }))
      }
      if (isBinary) {
        bytes += (data as Buffer).length
        advance()
      } else if (JSON.parse(data.toString()).type === 'endStream') {
        advance()
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  state.selfBase = `http://127.0.0.1:${port}`
  return {
    state,
    httpBase: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/asr/realtime`,
    close: () => new Promise((resolve) => { sockets.close(); server.closeAllConnections(); server.close(resolve) }),
  }
}
