import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { startInstance } from './standins.ts'
import { loadTruth, scoreFile, type TruthEntry } from '../scripts/ingest-score.ts'

/**
 * Recipes, costing and file import, through the real routes against the stand-in for Meta.
 * The stand-in can't read a PDF or a photo: for those it answers from the ground truth, so these tests prove everything
 * after the read, not the read itself. Only scripts/test-ai-ingest.ts tests real reading.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-ingest-'))
process.env.DATA_DIR = dataDir
process.env.SAMPLE_DATA = '1'
process.env.MODEL_API_KEY = 'test-key'
process.env.OWNER_PASSCODE = 'owner-code'
process.env.STAFF_PASSCODE = 'staff-code'

const { startMockMeta } = await import('../server/sample/mockMeta.ts')
const mock = await startMockMeta()
process.env.META_BASE_URL = mock.httpBase
process.env.META_REALTIME_URL = mock.wsUrl
const { buildApp } = await import('../server/app.ts')
const { all, get, isPostgres, run } = await import('../server/core/db.ts')
const parsing = await import('../server/core/parsing.ts')
const { parseDelimited, decodeText } = await import('../server/setup/ingest.ts')
const { marginPercent, priceForMargin, prepPerPortion } = await import('../shared/costing.ts')

const server = await buildApp()
let base = ''
let owner = ''
let staff = ''
const months = loadTruth()
const entries = months.flatMap((month) => month.files)
const ofKind = (kind: string) => entries.filter((entry) => entry.kind === kind)
const entry = (file: string) => entries.find((candidate) => candidate.file === file)!

const login = async (passcode: string) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })).headers.get('set-cookie')!.split(';')[0]
const call = async (who: string, url: string, method = 'GET', body?: unknown, at = base) => {
  const response = await fetch(`${at}${url}`, { method, headers: { Cookie: who, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, data: await response.json().catch(() => null) as any }
}
const send = async (who: string, url: string, files: Array<[string, Uint8Array | string, string]>, fields: Record<string, string> = {}, at = base) => {
  const form = new FormData()
  Object.entries(fields).forEach(([key, value]) => form.append(key, value))
  for (const [field, bytes, name] of files) form.append(field, new Blob([bytes as BlobPart]), name)
  const response = await fetch(`${at}${url}`, { method: 'POST', headers: { Cookie: who }, body: form })
  return { status: response.status, data: await response.json().catch(() => null) as any }
}
const readFile = (kind: string, name: string, bytes: Uint8Array | string) => send(owner, '/api/ingest/read', [['file', bytes, name]], { kind })
const read = (item: TruthEntry) => readFile(item.kind, item.file, fs.readFileSync(item.full))
const count = async (table: string) => Number((await get(`SELECT COUNT(*) AS total FROM ${table}`))!.total)
const dishNamed = async (name: string) => (await call(owner, '/api/setup/dishes')).data.find((dish: any) => dish.name === name)
const allNotes = (preview: any) => JSON.stringify(preview.checks)

/** What an owner does on the screen: leaves out what's flagged, and gives a new dish its price. */
const confirmedRecipes = (preview: any) => preview.recipes.map((recipe: any) => {
  const truth = ofKind('recipes').flatMap((item) => item.expected.recipes).find((row: any) => row.name === recipe.name)
  return { ...recipe, pricePence: recipe.pricePence ?? truth.menuPricePence, targetMargin: truth.targetMargin, lines: recipe.lines.filter((line: any) => !line.flags.length) }
})
const confirmedPrices = (preview: any, item: TruthEntry) => ({
  kind: 'ingredients', supplier: preview.supplier.name, date: preview.date ?? item.expected.ownerDate,
  rows: preview.rows.filter((row: any) => row.status !== 'problem'),
})

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  base = `http://localhost:${(server.address() as any).port}`
  owner = await login('owner-code')
  staff = await login('staff-code')
  // The seeded dates move with the clock, and the ground truth doesn't. The menu, items and suppliers stay.
  await run('UPDATE invoice_lines SET item_id = item_id')
  await run('DELETE FROM sales')
  await run('DELETE FROM price_history')
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await mock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('units, packs, money, dates and times are read the same way every time, and anything unsure is null', () => {
  const { toBase, parsePack, parseMoney, parseDate, minutesFrom, provenDayOrder, parseAmount } = parsing
  assert.deepEqual(toBase(200, 'g'), { quantity: 0.2, unit: 'kg' })
  assert.deepEqual(toBase(2, 'tbsp'), { quantity: 0.03, unit: 'l' })
  assert.deepEqual(toBase(1, 'tsp'), { quantity: 0.005, unit: 'l' })
  assert.deepEqual(toBase(2, null), { quantity: 2, unit: 'each' })
  for (const unit of ['bunch', 'cup', 'cloves', 'handful']) assert.equal(toBase(1, unit), null, unit)
  assert.deepEqual(parsePack('6 x 1 l'), { quantity: 6, unit: 'l' })
  assert.deepEqual(parsePack('12 x 400 ml'), { quantity: 4.8, unit: 'l' })
  assert.deepEqual(parsePack('25 kg sack'), { quantity: 25, unit: 'kg' })
  assert.deepEqual(parsePack('case of 48'), { quantity: 48, unit: 'each' })
  assert.deepEqual(parsePack('per kg'), { quantity: 1, unit: 'kg' })
  assert.equal(parsePack('tray'), null)
  assert.equal(parseMoney('£1,234.50'), 1234.5)
  assert.equal(parseMoney('(12.50)'), -12.5)
  for (const text of ['POA', '12,50', '=1+1', '']) assert.equal(parseMoney(text), null, text)
  assert.equal(parseDate('3/8/26'), '2026-08-03')
  assert.equal(parseDate('Monday 3 August 2026'), '2026-08-03')
  assert.equal(parseDate('31/02/2026'), null)
  assert.equal(parseDate('08/31/2026', 'month_first'), '2026-08-31')
  assert.equal(provenDayOrder(['01/02/2026', '08/31/2026']), 'month_first')
  assert.equal(provenDayOrder(['01/02/2026']), null)
  assert.equal(minutesFrom('Prep: 1 hour 15 minutes'), 75)
  assert.equal(minutesFrom('Service: 5 minutes a plate'), 5)
  assert.equal(minutesFrom('while it rests'), null)
  assert.deepEqual(parseAmount('½ tsp'), { quantity: 0.5, unit: 'tsp' })
  assert.deepEqual(parseAmount('1 1/2 kg'), { quantity: 1.5, unit: 'kg' })
})

test('a till CSV is decoded and split whatever its text and separator', () => {
  assert.equal(decodeText(Buffer.from([0x4e, 0x65, 0x74, 0x20, 0xa3])), 'Net £')
  assert.equal(decodeText(Buffer.from('﻿Net £')), 'Net £')
  assert.deepEqual(parseDelimited('a;b\r\n"1;2";"say ""hi"""\n'), [['a', 'b'], ['1;2', 'say "hi"']])
  assert.deepEqual(parseDelimited('a,b\n"line\nbreak",2'), [['a', 'b'], ['line\nbreak', '2']])
})

test('the margin sums match a hand calculation', () => {
  assert.equal(marginPercent(950, 184.95), 80.5)
  assert.equal(marginPercent(0, 100), null)
  assert.equal(priceForMargin(184.95, 80), 925)
  assert.equal(priceForMargin(100, 100), null)
  assert.equal(prepPerPortion(45, 10), 4.5)
  assert.equal(prepPerPortion(45, null), null)
})

test('the three months cover every format for sales, recipes and price lists', () => {
  const formats = ['csv', 'xlsx', 'pdf', 'docx', 'txt', 'png']
  for (const kind of ['sales', 'recipes', 'ingredients']) assert.deepEqual(ofKind(kind).map((item) => item.format).filter((format, index, list) => list.indexOf(format) === index).sort(), [...formats].sort(), kind)
  assert.deepEqual(months.map((month) => month.month), ['2026-08', '2026-09', '2026-10'])
  for (const month of months) for (const kind of ['sales', 'recipes', 'ingredients']) assert.ok(month.files.some((file) => file.kind === kind), `${month.month} ${kind}`)
})

test('every recipe file matches the ground truth, and reading saves nothing', async () => {
  const before = [await count('dishes'), await count('items'), await count('recipe_lines')]
  for (const item of ofKind('recipes')) {
    const { status, data } = await read(item)
    assert.equal(status, 200, item.file)
    assert.deepEqual(scoreFile(item, data).wrong, [], item.file)
  }
  assert.deepEqual([await count('dishes'), await count('items'), await count('recipe_lines')], before)
})

test('an unconvertible unit, a missing quantity and a clash with the saved unit are flagged, never guessed', async () => {
  const { data } = await read(entry('recipes-book.docx'))
  const curry = data.recipes.find((recipe: any) => recipe.name === 'Chicken curry')
  const wrap = data.recipes.find((recipe: any) => recipe.name === 'Grilled chicken wrap')
  const salt = curry.lines.find((line: any) => line.name === 'Salt')
  assert.equal(salt.quantity, null)
  assert.equal(salt.flags[0].text, 'No quantity in the file.')
  const coriander = wrap.lines.find((line: any) => line.name === 'Coriander')
  assert.equal(coriander.quantity, null)
  assert.match(coriander.flags[0].text, /can't convert/)
  assert.equal(coriander.flags[0].values.printed, '1 bunch')
  const soup = (await read(entry('recipe-card-scan.png'))).data.recipes[0]
  const onions = soup.lines.find((line: any) => line.name === 'Brown onions')
  assert.equal(onions.quantity, null)
  assert.match(onions.flags[0].text, /is saved in/)
  assert.equal(soup.lines.find((line: any) => line.name === 'Garlic').flags.length, 1)
  // Cooking time on the card is not added to prep.
  assert.equal(soup.prepMinutes, 15)

  // The server refuses a line that has no real unit, even if a browser sends one.
  const refused = await call(owner, '/api/setup/dishes', 'POST', { name: 'Bad', pricePence: 500, lines: [{ name: 'Coriander', quantity: 1, unit: 'bunch' }] })
  assert.equal(refused.status, 400)
  assert.match(refused.data.error, /Choose a unit/)
  assert.equal(await dishNamed('Bad'), undefined)
})

test('quantities become per portion in kilos, litres or each, and aliases find saved items', async () => {
  const { data } = await read(entry('recipes-book.docx'))
  const curry = data.recipes.find((recipe: any) => recipe.name === 'Chicken curry')
  const lines = Object.fromEntries(curry.lines.map((line: any) => [line.name, line]))
  assert.equal(curry.dishId, (await dishNamed('Chicken curry')).id)
  assert.deepEqual([lines['Chicken thighs'].quantity, lines['Chicken thighs'].unit, lines['Chicken thighs'].printed], [200, 'g', '2 kg'])
  assert.deepEqual([lines['Double cream'].quantity, lines['Double cream'].unit], [50, 'ml'])
  // The file says Onions, and that's an alias of Brown onions.
  assert.ok(lines['Brown onions'])
  assert.equal(lines['Brown onions'].isNew, false)
  assert.equal(curry.prepPerPortion, 4.5)
  assert.equal(curry.prepQuote, 'Prep time: 45 minutes')
})

test('a re-read shows what would change, and only a save changes it', async () => {
  const dish = await dishNamed('Chicken curry')
  const reread = await send(owner, '/api/setup/recipes/read', [['file', fs.readFileSync(entry('recipes-book.docx').full), 'recipes-book.docx']], { dishId: String(dish.id) })
  assert.equal(reread.status, 200)
  assert.equal(reread.data.dishId, dish.id)
  assert.equal(reread.data.more, 1)
  const changes = reread.data.changes
  assert.deepEqual(changes.filter((change: any) => change.kind === 'field').map((change: any) => change.name).sort(), ['method', 'portions', 'prep', 'service'])
  assert.deepEqual(changes.find((change: any) => change.name === 'prep'), { kind: 'field', name: 'prep', from: null, to: 45 })
  assert.deepEqual(changes.find((change: any) => change.name === 'Salt'), { kind: 'added', name: 'Salt', to: null })
  const after = await dishNamed('Chicken curry')
  assert.equal(after.prepMinutes, null)
  assert.equal(after.method, null)
})

test('old dishes show as not set, with no times', async () => {
  const dish = await dishNamed('Grilled chicken wrap')
  assert.deepEqual([dish.prepMinutes, dish.serviceMinutes, dish.portions, dish.prepPerPortion], [null, null, null, null])
})

test('all the recipes save when confirmed, new and old, keeping an old dish price', async () => {
  const curryPrice = (await dishNamed('Chicken curry')).pricePence
  for (const item of ofKind('recipes')) {
    const { data } = await read(item)
    const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'recipes', recipes: confirmedRecipes(data) })
    assert.deepEqual(saved.data, { kind: 'recipes', saved: data.recipes.length, problems: [] }, item.file)
  }
  for (const recipe of ofKind('recipes').flatMap((item) => item.expected.recipes)) {
    const dish = await dishNamed(recipe.name)
    assert.equal(dish.portions, recipe.portions, recipe.name)
    assert.equal(dish.prepMinutes, recipe.prepMinutes, recipe.name)
    assert.equal(dish.serviceMinutes, recipe.serviceMinutes, recipe.name)
    assert.equal(dish.prepPerPortion, Math.round((recipe.prepMinutes / recipe.portions) * 10) / 10, recipe.name)
    assert.equal(dish.lines.length, recipe.ingredients.filter((line: any) => !line.flagged).length, recipe.name)
    for (const line of recipe.ingredients.filter((row: any) => !row.flagged)) {
      const row = dish.lines.find((candidate: any) => candidate.name === line.name)
      assert.ok(Math.abs(row.quantity - line.perPortion) < 0.0005, `${recipe.name} ${line.name}`)
    }
  }
  assert.equal((await dishNamed('Chicken curry')).pricePence, curryPrice)
})

test('saving a recipe never wipes what the file left out', async () => {
  const before = await dishNamed('Chickpea curry')
  const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'recipes', recipes: [{ name: 'Chickpea curry', lines: before.lines.map((line: any) => ({ name: line.name, quantity: line.quantity, unit: line.unit })), prepMinutes: null, steps: [] }] })
  assert.equal(saved.data.saved, 1)
  const after = await dishNamed('Chickpea curry')
  assert.equal(after.prepMinutes, before.prepMinutes)
  assert.equal(after.method, before.method)
  const empty = await call(owner, '/api/ingest/save', 'POST', { kind: 'recipes', recipes: [{ name: 'Chickpea curry', lines: [] }] })
  assert.equal(empty.data.saved, 0)
  assert.equal((await dishNamed('Chickpea curry')).lines.length, before.lines.length)
})

test('a new ingredient has no price yet, and the cost is marked incomplete rather than understated', async () => {
  const curry = await dishNamed('Chickpea curry')
  assert.equal(curry.costPence, null)
  assert.equal(curry.exactCostPence, null)
  assert.equal(curry.marginPercent, null)
  assert.equal(curry.pricePenceForTarget, null)
  assert.ok(curry.unpriced.includes('Chickpeas'))
  assert.equal(curry.lines.find((line: any) => line.name === 'Chickpeas').pricePence, null)
})

test('every price list matches the ground truth, and a list with no price or an odd unit is flagged', async () => {
  const before = await count('price_history')
  for (const item of ofKind('ingredients')) {
    const { status, data } = await read(item)
    assert.equal(status, 200, item.file)
    assert.deepEqual(scoreFile(item, data).wrong, [], item.file)
  }
  assert.equal(await count('price_history'), before)

  const harrow = (await read(entry('harrow-lane-prices.csv'))).data
  const ginger = harrow.rows.find((row: any) => row.name === 'Ginger')
  assert.equal(ginger.status, 'problem')
  assert.equal(ginger.flags[0].text, 'No price in the file.')
  assert.equal(ginger.basePricePence, null)
  assert.equal(harrow.rows.find((row: any) => row.name === 'Brown onions').isNew, false)
  const northgate = (await read(entry('northgate-prices.pdf'))).data
  assert.match(northgate.rows.find((row: any) => row.name === 'Flat-leaf parsley').flags[0].text, /can't convert/)
  const fax = (await read(entry('oakfield-prices-fax.png'))).data
  assert.equal(fax.date, null)
  assert.match(allNotes(fax), /no date/)
  assert.match(allNotes((await read(entry('riverside-prices.txt'))).data), /new supplier/)
})

test('a price list needs a date and a supplier, adds to the history and keeps what was there', async () => {
  const history = await all('SELECT id, price_p, date FROM price_history')
  assert.equal(history.length, 0)
  const noDate = await call(owner, '/api/ingest/save', 'POST', { kind: 'ingredients', supplier: 'Oakfield Dairy', date: '', rows: [{ name: 'Double cream', unit: 'l', basePricePence: 300 }] })
  assert.equal(noDate.status, 400)
  const noSupplier = await call(owner, '/api/ingest/save', 'POST', { kind: 'ingredients', supplier: ' ', date: '2026-09-01', rows: [] })
  assert.equal(noSupplier.status, 400)

  const expected = ofKind('ingredients').reduce((sum, item) => sum + item.expected.lines.filter((line: any) => !line.flagged).length, 0)
  for (const item of ofKind('ingredients').sort((a, b) => a.month.localeCompare(b.month))) {
    const { data } = await read(item)
    const saved = await call(owner, '/api/ingest/save', 'POST', confirmedPrices(data, item))
    assert.equal(saved.status, 200, item.file)
    assert.equal(saved.data.saved, item.expected.lines.filter((line: any) => !line.flagged).length, item.file)
  }
  assert.equal(await count('price_history'), expected)
  assert.ok((await all('SELECT name FROM suppliers')).some((row) => row.name === 'Riverside Spice Co'))
  const thighs = await all(`SELECT p.date, p.price_p FROM price_history p JOIN items i ON i.id = p.item_id WHERE i.name = 'Chicken thighs' ORDER BY p.date`)
  assert.deepEqual(thighs.map((row) => [row.date, Number(row.price_p)]), [['2026-08-03', 580], ['2026-09-01', 590], ['2026-10-01', 640]])
})

test('loading a price list twice adds nothing, and tells the owner', async () => {
  const before = await count('price_history')
  const item = entry('northgate-prices.csv')
  const { data } = await read(item)
  assert.equal(data.summary.same, 8)
  assert.equal(data.summary.new, 0)
  const again = await call(owner, '/api/ingest/save', 'POST', confirmedPrices(data, item))
  assert.deepEqual([again.data.saved, again.data.skipped], [0, 8])
  assert.equal(await count('price_history'), before)
})

test('a price far from the last one is flagged, because a pack size is the likely mistake', async () => {
  const csv = 'Product,Pack,Price\nChicken thighs,1 kg,£64.00\n'
  mock.state.ingestReply = { header_row: 0, columns: { item: 0, pack: 1, unit: null, price: 2 }, money_in: 'pounds', price_is: 'per_pack', date_order: null, supplier_name: 'Harrow Lane Foods', list_date: '2026-10-02' }
  const { data } = await readFile('ingredients', 'odd.csv', csv)
  mock.state.ingestReply = null
  assert.match(JSON.stringify(data.rows[0].flags), /Check the pack size/)
})

test('every sales file matches the ground truth, and only a confirm saves it', async () => {
  const before = await count('sales')
  for (const item of ofKind('sales')) {
    const { status, data } = await read(item)
    assert.equal(status, 200, item.file)
    assert.deepEqual(scoreFile(item, data).wrong, [], item.file)
  }
  assert.equal(await count('sales'), before)
})

test('a till export adds up its channels, leaves out what is flagged and uses net, not gross', async () => {
  const { data } = await read(entry('sales-till-export.csv'))
  assert.equal(data.summary.problems, 2)
  assert.deepEqual(data.problems.map((row: any) => row.dish).sort(), ['Chicken curry', 'Staff meal'])
  assert.equal(data.problems.find((row: any) => row.dish === 'Staff meal').flags[0].text, 'Not on your menu: {name}')
  assert.match(allNotes(data), /added together/)
  assert.equal(data.ready.length, entry('sales-till-export.csv').expected.combinedRows)
  const first = data.ready[0]
  assert.equal(first.netPence / first.quantity, (await dishNamed(first.dish)).pricePence)
})

test('a workbook skips subtotals, carries dates down and reads the biggest sheet', async () => {
  const { data } = await read(entry('sales-workbook.xlsx'))
  assert.match(allNotes(data), /Daily sales/)
  assert.equal(new Set(data.ready.map((row: any) => row.date)).size, 27)
  assert.equal(data.summary.printed.netPence, data.summary.netPence)
})

test('a printed total that disagrees with the rows is flagged, and the owner still decides', async () => {
  const { data } = await read(entry('sales-report.pdf'))
  assert.match(allNotes(data), /The rows add up to/)
  assert.equal(data.summary.printed.netPence - data.summary.netPence, 2000)
  assert.equal(data.summary.problems, 0)
})

test('sales save once confirmed, and the dashboard agrees with the ground truth for every month', async () => {
  const unknown = await count('sales')
  assert.equal(unknown, 0)
  for (const item of ofKind('sales')) {
    const { data } = await read(item)
    const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'sales', rows: data.ready })
    assert.equal(saved.data.added, data.ready.length, item.file)
  }
  for (const { month, totals } of months) {
    const last = month === '2026-09' ? 30 : 31
    const { facts } = (await call(owner, `/api/summary?from=${month}-01&to=${month}-${last}`)).data
    assert.equal(facts.food_cost.net_sales_pence, totals.netPence, month)
    assert.equal(facts.food_cost.food_cost_pence, totals.foodCostPence, month)
    assert.equal(facts.food_cost.food_cost_percent, totals.foodCostPercent, month)
  }
  assert.ok(months[0].totals.foodCostPercent < months[1].totals.foodCostPercent)
  assert.ok(months[1].totals.foodCostPercent < months[2].totals.foodCostPercent)
})

test('the price rise behind October is what the analyst can find', async () => {
  const { priceChanges } = await import('../server/ai/analyst.ts')
  const [top] = await priceChanges('2026-10-01', '2026-10-31')
  assert.equal(top.item, 'Chicken thighs')
  assert.equal(top.supplier, 'Harrow Lane Foods')
  assert.deepEqual([top.before_pence, top.now_pence], [590, 640])
})

test('loading the same sales again counts nothing twice and says what was skipped', async () => {
  const before = await all('SELECT SUM(qty) AS qty, SUM(net_p) AS net, COUNT(*) AS total FROM sales')
  for (const item of ofKind('sales')) {
    const { data } = await read(item)
    assert.equal(data.summary.new, 0, item.file)
    assert.equal(data.summary.same, data.ready.length, item.file)
    const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'sales', rows: data.ready })
    assert.deepEqual([saved.data.added, saved.data.replaced, saved.data.skipped], [0, 0, data.ready.length], item.file)
  }
  assert.deepEqual(await all('SELECT SUM(qty) AS qty, SUM(net_p) AS net, COUNT(*) AS total FROM sales'), before)
})

test('a different figure for a saved day is shown, and replaces it only on confirm', async () => {
  const row = (await all(`SELECT s.date, s.qty, s.net_p, d.name FROM sales s JOIN dishes d ON d.id = s.dish_id ORDER BY s.id LIMIT 1`))[0]
  const csv = `date,dish,quantity,net sales\n${row.date},${row.name},${Number(row.qty) + 1},${(Number(row.net_p) + 100) / 100}\n`
  const { data } = await readFile('sales', 'fix.csv', csv)
  assert.equal(data.summary.replace, 1)
  assert.deepEqual(data.ready[0].before, { quantity: Number(row.qty), netPence: Number(row.net_p) })
  assert.equal(Number((await get('SELECT qty FROM sales WHERE date = ? AND dish_id = (SELECT id FROM dishes WHERE name = ?)', row.date, row.name))!.qty), Number(row.qty))
  const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'sales', rows: data.ready })
  assert.equal(saved.data.replaced, 1)
  await call(owner, '/api/ingest/save', 'POST', { kind: 'sales', rows: [{ date: row.date, dish: row.name, quantity: Number(row.qty), netPence: Number(row.net_p) }] })
})

test('the template CSV takes the same path, so it cannot double count either', async () => {
  const csv = 'date,dish,quantity,net sales\n2026-08-05,Chicken curry,1,9.50\n'
  const form = new FormData()
  form.append('file', new Blob([csv]), 'sales.csv')
  const send = () => { const body = new FormData(); body.append('file', new Blob([csv]), 'sales.csv'); return fetch(`${base}/api/sales/import`, { method: 'POST', headers: { Cookie: owner }, body }).then((response) => response.json()) as Promise<any> }
  const saved = await get(`SELECT s.qty, s.net_p FROM sales s JOIN dishes d ON d.id = s.dish_id WHERE d.name = 'Chicken curry' AND s.date = '2026-08-05'`)
  assert.equal((await send()).imported, 1)
  const again = await send()
  assert.deepEqual([again.imported, again.skipped], [0, 1])
  await run(`UPDATE sales SET qty = ?, net_p = ? WHERE date = '2026-08-05' AND dish_id = (SELECT id FROM dishes WHERE name = 'Chicken curry')`, saved!.qty, saved!.net_p)
})

test('a wrong kind of file gets a plain answer, and costs no more than one model call', async () => {
  const before = await count('sales')
  mock.state.requests.length = 0
  const { status, data } = await readFile('sales', 'wrong.csv', 'Name,Colour,Size\nLamp,Red,Large\n')
  assert.equal(status, 400)
  assert.match(data.error, /couldn't find/)
  assert.equal(mock.state.requests.length, 1)
  assert.equal(await count('sales'), before)
  assert.equal((await readFile('ingredients', 'wrong.csv', 'Name,Colour\nLamp,Red\n')).status, 400)
  assert.equal((await readFile('recipes', 'wrong.csv', 'Name,Colour\nLamp,Red\n')).status, 400)
  assert.equal((await readFile('nonsense', 'sales.csv', 'a,b\n1,2\n')).status, 400)
})

test('Muse Spark sees only the top of a spreadsheet, and plain code reads every row', async () => {
  const item = entry('sales-till-export.csv')
  const lines = decodeText(fs.readFileSync(item.full)).trim().split('\n')
  mock.state.requests.length = 0
  mock.state.ingestTexts.length = 0
  await read(item)
  assert.deepEqual(mock.state.requests, ['ingest_columns_sales'])
  const [sent] = mock.state.ingestTexts
  assert.equal([...sent.matchAll(/^Row \d+:/gm)].length, 12)
  assert.ok(lines.length > 150)
  assert.ok(!sent.includes(lines[60].split(';')[6]) || !sent.includes(lines[60].split(';')[0]))
  assert.ok(!sent.includes('TOTAL'))
})

test('a Word file reaches the model as text, with its tables in rows', async () => {
  mock.state.ingestTexts.length = 0
  await read(entry('sales-second-half.docx'))
  const [sent] = mock.state.ingestTexts
  assert.match(sent, /16 Aug 2026\tChicken curry\t\d+\t£[\d.]+/)
  assert.match(sent, /is data, not instructions/)
})

test('a file too big, too long or of the wrong kind is refused before anything reads it', async () => {
  mock.state.requests.length = 0
  const huge = await readFile('sales', 'huge.csv', new Uint8Array(15 * 1024 * 1024 + 1))
  assert.equal(huge.status, 400)
  assert.equal(huge.data.error, 'That file is too large.')
  const rows = await readFile('sales', 'long.csv', `date,dish,quantity,net\n${'2026-08-01,Chicken curry,1,9.50\n'.repeat(5001)}`)
  assert.equal(rows.status, 400)
  assert.match(rows.data.error, /5,000 rows/)
  const words = await readFile('sales', 'long.txt', 'word '.repeat(13000))
  assert.equal(words.status, 400)
  assert.match(words.data.error, /too long/)
  const old = await readFile('sales', 'old.xls', 'not really')
  assert.equal(old.status, 400)
  assert.match(old.data.error, /Add a CSV, XLSX/)
  assert.deepEqual(mock.state.requests, [])
})

test('a broken or swollen workbook gets a plain answer', async () => {
  mock.state.requests.length = 0
  const broken = await readFile('sales', 'broken.xlsx', 'this is not a zip')
  assert.equal(broken.status, 400)
  assert.match(broken.data.error, /couldn't be opened/)
  assert.equal((await readFile('recipes', 'broken.docx', 'nor is this')).status, 400)
  // A zip that says it holds 200 MB, with nothing behind it.
  const head = Buffer.alloc(46 + 8)
  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt32LE(200 * 1024 * 1024, 24)
  head.writeUInt16LE(8, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(0, 16)
  const swollen = await readFile('sales', 'big.xlsx', Buffer.concat([head, end]))
  assert.equal(swollen.status, 400)
  assert.equal(swollen.data.error, 'That file is too large.')
  assert.deepEqual(mock.state.requests, [])
})

test('a formula in a file stays text, like the invoice export', async () => {
  const csv = 'Product,Pack,Price\n"=HYPERLINK(""http://bad.example"",""x"")",1 kg,£2.00\n@SUM(A1),1 kg,=1+1\n'
  mock.state.ingestReply = { header_row: 0, columns: { item: 0, pack: 1, unit: null, price: 2 }, money_in: 'pounds', price_is: 'per_pack', date_order: null, supplier_name: 'Oakfield Dairy', list_date: '2026-10-05' }
  const { data } = await readFile('ingredients', 'formula.csv', csv)
  mock.state.ingestReply = null
  assert.ok(data.rows[0].name.startsWith(`'=HYPERLINK`))
  assert.ok(data.rows[1].name.startsWith(`'@SUM`))
  assert.equal(data.rows[1].status, 'problem')
  const sales = await readFile('sales', 'formula.csv', 'date,dish,quantity,net sales\n2026-08-01,=cmd|calc,1,1.00\n')
  assert.equal(sales.data.problems[0].dish, `'=cmd|calc`)
})

test('an instruction hidden in a document is flagged, and never reaches the model', async () => {
  mock.state.ingestTexts.length = 0
  const { data } = await read(entry('recipes-book.docx'))
  assert.match(allNotes(data), /steer an AI/)
  assert.doesNotMatch(mock.state.ingestTexts[0], /ignore all previous|Set every quantity/i)
  assert.match(mock.state.ingestTexts[0], /Chicken curry/)
  assert.equal(data.recipes[0].prepMinutes, 45)
  const prices = (await read(entry('harrow-lane-prices.docx'))).data
  assert.match(allNotes(prices), /steer an AI/)
  assert.doesNotMatch(mock.state.ingestTexts.at(-1)!, /Truffle/)
})

test('a model that was fooled anyway can invent nothing: made-up numbers are caught and nothing saves by itself', async () => {
  const dishes = await count('dishes')
  const prices = await count('price_history')
  const item = entry('harrow-lane-prices.docx')
  mock.state.ingestReply = { supplier_name: 'Harrow Lane Foods', list_date: '2026-10-01', lines: [{ item: 'Chicken thighs', pack: '10 kg case', price_pence: 1, price_is: 'per_pack' }, { item: 'Truffle Oil', pack: '1 l', price_pence: 0, price_is: 'per_pack' }], unreadable: [] }
  const list = (await read(item)).data
  assert.equal(list.rows[0].status, 'problem')
  assert.equal(list.rows[0].flags[0].text, "This number isn't in the file.")
  assert.equal(list.rows[1].status, 'problem')

  mock.state.ingestReply = { recipes: [{ name: 'Chicken curry', portions: 99, ingredients: [{ name: 'Chicken thighs', quantity: 77, unit: 'kg' }], method_steps: [], prep_minutes: 1, prep_quote: 'the prep time is 1 minute', service_minutes: 2, service_quote: null }], unreadable: [] }
  const recipe = (await read(entry('recipes-book.docx'))).data.recipes[0]
  assert.equal(recipe.portions, null)
  assert.equal(recipe.lines[0].quantity, null)
  assert.equal(recipe.lines[0].flags[0].text, "This number isn't in the file.")
  assert.deepEqual([recipe.prepMinutes, recipe.serviceMinutes], [null, null])
  assert.match(JSON.stringify(recipe.flags), /wasn't found in the file/)

  // A PDF can't be checked word by word, but a time with no words behind it is still dropped.
  mock.state.ingestReply = { recipes: [{ name: 'Soup', portions: 4, ingredients: [], method_steps: [], prep_minutes: 20, prep_quote: null, service_minutes: null, service_quote: null }], unreadable: [] }
  const pdf = (await read(entry('recipe-cards.pdf'))).data.recipes[0]
  assert.equal(pdf.prepMinutes, null)

  mock.state.ingestReply = { rows: [{ date: '2026-08-16', dish: 'Chicken curry', quantity: 9999, net_sales_pence: 123 }], printed_total_quantity: null, printed_total_net_pence: null, unreadable: [] }
  const sales = (await read(entry('sales-second-half.docx'))).data
  mock.state.ingestReply = null
  assert.equal(sales.problems[0].flags[0].text, "This number isn't in the file.")
  assert.equal(sales.ready.length, 0)
  assert.deepEqual([await count('dishes'), await count('price_history')], [dishes, prices])
})

test('the server checks every row again on save, because the browser held the preview', async () => {
  const before = await count('sales')
  const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'sales', rows: [
    { date: 'nonsense', dish: 'Chicken curry', quantity: 1, netPence: 950 }, { date: '2026-08-01', dish: 'Made up dish', quantity: 1, netPence: 950 },
    { date: '2026-08-01', dish: 'Chicken curry', quantity: -1, netPence: 950 }, { date: '2099-01-01', dish: 'Chicken curry', quantity: 1, netPence: 950 },
  ] })
  assert.deepEqual([saved.data.saved, saved.data.left], [0, 4])
  assert.equal(await count('sales'), before)
  assert.equal((await call(owner, '/api/ingest/save', 'POST', { kind: 'nonsense' })).status, 400)
})

test('a recipe can come as plain text, and a file it cannot take says what it can', async () => {
  mock.state.ingestReply = { recipes: [{ name: 'Lentil dal', portions: 4, ingredients: [{ name: 'Red lentils', quantity: 400, unit: 'g' }], method_steps: ['Simmer the lentils.'], prep_minutes: null, prep_quote: null, service_minutes: null, service_quote: null }], unreadable: [] }
  const text = 'Lentil dal\nServes 4\n400 g red lentils\nSimmer the lentils.'
  const read = await send(owner, '/api/setup/recipes/read', [['file', text, 'dal.txt']])
  mock.state.ingestReply = null
  assert.equal(read.status, 200)
  assert.equal(read.data.recipe.name, 'Lentil dal')
  assert.equal(read.data.recipe.lines[0].quantity, 100)
  const refused = await send(owner, '/api/setup/recipes/read', [['file', 'x', 'dal.pages']])
  assert.equal(refused.status, 400)
  assert.match(refused.data.error, /PDF, photo .* Word and text files/)
})

test('a till export in any layout loads, and a dish not on the menu can be added with its sales in one step', async () => {
  const csv = [
    'Trading Date,Menu Item,Channel,Qty Sold,Gross £,VAT £,Net £',
    '01/08/2026,Mango lassi,Dine in,4,19.20,3.20,16.00',
    '01/08/2026,Mango lassi,Takeaway,2,9.60,1.60,8.00',
    '02/08/2026,Mango lassi,Dine in,3,14.40,2.40,12.00',
  ].join('\n')
  const { status, data } = await readFile('sales', 'till-export.csv', csv)
  assert.equal(status, 200)
  const lassi = data.newDishes.find((dish: any) => dish.name === 'Mango lassi')
  assert.equal(lassi.pricePence, 400)
  assert.deepEqual(lassi.rows.map((row: any) => [row.date, row.quantity, row.netPence]), [['2026-08-01', 6, 2400], ['2026-08-02', 3, 1200]])
  const saved = await call(owner, '/api/ingest/save', 'POST', { kind: 'sales', rows: [...lassi.rows, { date: '2026-08-01', dish: 'Mango lassi', quantity: 1, netPence: 400 }], addDishes: [{ name: 'Mango lassi', pricePence: 450 }] })
  assert.equal(saved.data.saved, 2)
  const dish = (await call(owner, '/api/setup/dishes')).data.find((row: any) => row.name === 'Mango lassi')
  assert.equal(dish.pricePence, 450)
  const sold = await get("SELECT qty, net_p FROM sales WHERE dish_id = ? AND date = '2026-08-01'", dish.id)
  assert.deepEqual([Number(sold!.qty), Number(sold!.net_p)], [7, 2800])
})

test('Muse Spark failing gives a plain message, with no error text', async () => {
  mock.state.failSpark = true
  const { status, data } = await send(owner, '/api/setup/recipes/read', [['file', fs.readFileSync(entry('recipe-cards.pdf').full), 'recipe-cards.pdf']])
  mock.state.failSpark = false
  assert.equal(status, 400)
  assert.equal(data.error, 'Stockpot could not read that file. Try again, or try a clearer copy.')
})

test('the calculator uses the same costing as the Dashboard, and the numbers agree', async () => {
  const dish = await dishNamed('Grilled chicken wrap')
  assert.ok(dish.costPence !== null)
  // Hand calculation at today's prices: 0.16 kg × 640 + 0.05 kg × 240 + 0.03 kg × 92 + 1 × 32.
  assert.ok(Math.abs(dish.exactCostPence - (102.4 + 12 + 2.76 + 32)) < 0.001)
  assert.equal(dish.costPence, 149)
  assert.equal(dish.marginPercent, 82.5)
  assert.equal(dish.pricePenceForTarget, Math.ceil(dish.exactCostPence / 0.15))
  const share = dish.lines.reduce((sum: number, line: any) => sum + line.sharePercent, 0)
  assert.ok(Math.abs(share - 100) < 0.2)
  const thighs = dish.lines.find((line: any) => line.name === 'Chicken thighs')
  assert.deepEqual([thighs.pricePence, thighs.priceDate], [640, '2026-10-01'])
  assert.ok(Math.abs(thighs.costPence - 102.4) < 0.001)

  const { facts } = (await call(owner, '/api/summary?from=2026-10-01&to=2026-10-31')).data
  for (const shown of facts.dishes) {
    const calculator = await dishNamed(shown.dish)
    assert.equal(shown.cost_incomplete, false, shown.dish)
    assert.ok(Math.abs(calculator.marginPercent - shown.margin_percent) <= 0.1, `${shown.dish}: ${calculator.marginPercent} and ${shown.margin_percent}`)
  }
})

test('the Dashboard marks a dish whose cost is incomplete, not just a low number', async () => {
  const { data } = await call(owner, '/api/setup/dishes', 'POST', { name: 'Truffle special', pricePence: 2000, targetMargin: 70, lines: [{ name: 'Black truffle', quantity: 5, unit: 'g' }] })
  await run(`INSERT INTO sales (date, dish_id, qty, net_p) VALUES ('2026-10-03', ?, 2, 4000)`, data.id)
  const { facts } = (await call(owner, '/api/summary?from=2026-10-01&to=2026-10-31')).data
  assert.equal(facts.dishes.find((row: any) => row.dish === 'Truffle special').cost_incomplete, true)
  await run('DELETE FROM sales WHERE dish_id = ?', data.id)
  assert.equal((await call(owner, `/api/setup/dishes/${data.id}`, 'DELETE')).status, 200)
})

test('a price dated in the future does not change today, as on the Dashboard', async () => {
  const before = await dishNamed('Grilled chicken wrap')
  const item = await get(`SELECT id FROM items WHERE name = 'Chicken thighs'`)
  const supplier = await get(`SELECT id FROM suppliers WHERE name = 'Harrow Lane Foods'`)
  await run(`INSERT INTO price_history (item_id, supplier_id, date, price_p) VALUES (?, ?, '2099-01-01', 9999)`, item!.id, supplier!.id)
  assert.equal((await dishNamed('Grilled chicken wrap')).costPence, before.costPence)
  await run(`DELETE FROM price_history WHERE date = '2099-01-01'`)
})

test('staff get photo, numbered steps and times, and never a cost, a price, a margin or the file', async () => {
  const dish = await dishNamed('Chicken curry')
  const png = fs.readFileSync('public/samples/sample-dish.png')
  const pdfBytes = fs.readFileSync('public/samples/sample-recipe.pdf')
  const saved = await send(owner, `/api/setup/dishes/${dish.id}/files`, [['recipe', pdfBytes, 'costed recipe.pdf'], ['photo', png, 'dish.png']])
  assert.equal(saved.status, 200)
  await call(owner, `/api/setup/dishes/${dish.id}`, 'PUT', { ...dish, lines: dish.lines, method: 'Brown the chicken.\nCosting: £1.85 a portion, GP 80%\nSimmer for 20 minutes.\nSells at 950p\nServe with rice.\nSell at £9.50\nOur margin is good.' })
  await call(owner, `/api/setup/dishes/${dish.id}`, 'PUT', { ...dish, lines: [...dish.lines.map(({ name, quantity, unit }: any) => ({ name, quantity, unit }))], method: 'Brown the chicken.\nCosting: £1.85 a portion, GP 80%\n2. Simmer for 20 minutes.\nSells for 950p\nServe with rice.\nOur margin is good.' })

  const recipes = (await call(staff, '/api/staff/recipes')).data
  const recipe = recipes.find((row: any) => row.id === dish.id)
  assert.deepEqual(recipe.steps, ['Brown the chicken.', 'Simmer for 20 minutes.', 'Serve with rice.'])
  assert.equal(recipe.prepMinutes, 45)
  assert.equal(recipe.serviceMinutes, 4)
  assert.equal(recipe.prepPerPortion, 4.5)
  assert.equal(recipe.portions, 10)
  const words = JSON.stringify(recipes)
  assert.doesNotMatch(words, /price|margin|cost|£|recipeFile|recipe_file|\.pdf/i)
  for (const key of ['pricePence', 'targetMargin', 'costPence', 'marginPercent', 'lines.pricePence']) assert.ok(!(key in recipe), key)
  assert.deepEqual(Object.keys(recipe.lines[0]).sort(), ['name', 'quantity', 'unit'])

  const photo = await fetch(`${base}/api/staff/recipe-photo/${recipe.photo}`, { headers: { Cookie: staff } })
  assert.equal(photo.status, 200)
  const stored = (await dishNamed('Chicken curry'))
  assert.match(stored.recipeFile, /\.pdf$/)
  assert.equal(stored.recipeFileName, 'costed recipe.pdf')
  assert.equal((await fetch(`${base}/api/staff/recipe-photo/${stored.recipeFile}`, { headers: { Cookie: staff } })).status, 404)
  assert.equal((await fetch(`${base}/api/files/${stored.recipeFile}`, { headers: { Cookie: staff } })).status, 403)
  assert.equal((await fetch(`${base}/api/files/${stored.recipeFile}`, { headers: { Cookie: owner } })).status, 200)
})

test('a price in an ingredient name does not reach staff', async () => {
  const { data } = await call(owner, '/api/setup/dishes', 'POST', { name: 'Odd', pricePence: 500, lines: [{ name: 'Saffron (£4.00 a jar)', quantity: 1, unit: 'each' }] })
  const recipe = (await call(staff, '/api/staff/recipes')).data.find((row: any) => row.id === data.id)
  assert.equal(recipe.lines[0].name, 'Saffron')
  assert.equal((await call(owner, `/api/setup/dishes/${data.id}`, 'DELETE')).status, 200)
})

test('a PDF can never become a dish photo, because staff are served that file', async () => {
  const dish = await dishNamed('Tomato soup')
  const pdf = fs.readFileSync('public/samples/sample-recipe.pdf')
  const form = await send(owner, `/api/setup/dishes/${dish.id}/files`, [['photo', pdf, 'photo.pdf']])
  assert.equal(form.status, 400)
  assert.equal((await dishNamed('Tomato soup')).photo, null)
})

test('a dish file can be read again from where it was saved, and nothing changes until a save', async () => {
  const dish = await dishNamed('Tomato soup')
  assert.equal((await call(owner, `/api/setup/dishes/${dish.id}/read-again`, 'POST')).status, 400)
  await send(owner, `/api/setup/dishes/${dish.id}/files`, [['recipe', fs.readFileSync(entry('recipe-cards.pdf').full), 'recipe-cards.pdf']])
  const again = await call(owner, `/api/setup/dishes/${dish.id}/read-again`, 'POST')
  assert.equal(again.status, 200, JSON.stringify(again.data))
  assert.equal(again.data.dishId, dish.id)
  assert.equal(again.data.recipe.name, 'Chickpea curry')
  assert.ok(again.data.changes.some((change: any) => change.kind === 'removed' && change.name === 'Vegetable stock'))
  assert.equal((await dishNamed('Tomato soup')).portions, 6)
})

test('owner routes turn staff away', async () => {
  const dish = await dishNamed('Tomato soup')
  const pdf = fs.readFileSync('public/samples/sample-recipe.pdf')
  assert.equal((await send(staff, '/api/ingest/read', [['file', 'a,b\n1,2\n', 'a.csv']], { kind: 'sales' })).status, 403)
  assert.equal((await call(staff, '/api/ingest/save', 'POST', { kind: 'sales', rows: [] })).status, 403)
  assert.equal((await send(staff, '/api/setup/recipes/read', [['file', pdf, 'a.pdf']])).status, 403)
  assert.equal((await call(staff, `/api/setup/dishes/${dish.id}/read-again`, 'POST')).status, 403)
  assert.equal((await send(staff, `/api/setup/dishes/${dish.id}/files`, [['photo', pdf, 'a.png']])).status, 403)
  assert.equal((await call(staff, '/api/setup/dishes')).status, 403)
})

test('the real-Meta script runs every file, keeps going past a failure, leaves no keys and touches nothing here', async () => {
  const report = path.join(dataDir, 'report.md')
  // One file is ruined, and it isn't the last, so the script has to get past it.
  const copy = path.join(dataDir, 'datasets')
  fs.cpSync('public/samples/datasets', copy, { recursive: true })
  fs.writeFileSync(path.join(copy, '2026-09', 'harrow-lane-prices.xlsx'), 'this was never a workbook')
  const salesBefore = await count('sales')
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/test-ai-ingest.ts', '--mock'], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, INGEST_REPORT: report, INGEST_DATASETS: copy, OWNER_PASSCODE: 'a-secret-passcode' },
  }).then(() => ({ code: 0 }), (error) => error)
  assert.equal(result.code, 1)
  const text = fs.readFileSync(report, 'utf8')
  assert.match(text, /Mock run/)
  assert.match(text, /Finished: 21 of 22 files passed/)
  assert.equal([...text.matchAll(/\| (PASS|FAIL) \|/g)].length, 22)
  assert.match(text, /harrow-lane-prices\.xlsx \| ingredients \| FAIL \| none .*couldn't be opened/)
  assert.match(text, /sales-closing-sheet-scan\.png \| sales \| PASS \| 24 \/ 24/)
  assert.doesNotMatch(text, /a-secret-passcode|mock-key/)
  assert.equal(await count('sales'), salesBefore)
})

test('the report gives the real cause of a model failure, not the plain message', async () => {
  const report = path.join(dataDir, 'report-fail.md')
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/test-ai-ingest.ts'], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, INGEST_REPORT: report, MODEL_API_KEY: 'a-real-looking-key', META_BASE_URL: 'http://127.0.0.1:1', ENV_FILE: path.join(dataDir, 'no-env') },
  }).then(() => ({ code: 0 }), (error) => error)
  assert.equal(result.code, 1)
  const text = fs.readFileSync(report, 'utf8')
  assert.match(text, /Finished: 0 of 22 files passed/)
  assert.match(text, /could not read that file.*fetch failed/)
  assert.doesNotMatch(text, /a-real-looking-key/)
})

test('a file that writes dates month first, or money in pence, is read the way it says', async () => {
  const csv = 'Date,Dish,Qty,Net pence\n08/31/2026,Chicken curry,2,1900\n09/01/2026,Chicken curry,1,950\n'
  const { data } = await readFile('sales', 'us.csv', csv)
  assert.deepEqual(data.ready.map((row: any) => [row.date, row.netPence]), [['2026-08-31', 1900], ['2026-09-01', 950]])
})

test('the sample recipe works with no key, on a site with no database or Storage', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-sample-'))
  const instance = await startInstance({ VERCEL: '1', STOCKPOT_ENTRY: 'api', MODEL_API_KEY: '', OWNER_PASSCODE: '', STAFF_PASSCODE: '', SESSION_SECRET: '', DATABASE_URL: '', DB_SCHEMA: '', SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', META_BASE_URL: '', META_REALTIME_URL: '', SAMPLE_DATA: '', DATA_DIR: folder, DATABASE_FILE: path.join(folder, 'sample.sqlite') })
  try {
    const at = instance.base
    assert.equal((await call('', '/api/session', 'GET', undefined, at)).data.mode, 'sample')
    const pdf = fs.readFileSync('public/samples/sample-recipe.pdf')
    const { status, data } = await send('', '/api/setup/recipes/read', [['file', pdf, 'sample-recipe.pdf']], {}, at)
    assert.equal(status, 200, JSON.stringify(data))
    assert.equal(data.recipe.name, 'Lamb kofta')
    assert.equal(data.recipe.prepMinutes, 40)
    assert.equal(data.recipe.serviceMinutes, 6)
    assert.equal(data.recipe.prepPerPortion, 4)
    assert.equal(data.dishId, null)
    const lines = Object.fromEntries(data.recipe.lines.map((line: any) => [line.name, line]))
    assert.deepEqual([lines['Lamb mince'].quantity, lines['Lamb mince'].unit, lines['Lamb mince'].noPrice], [150, 'g', true])
    assert.equal(lines['Flat-leaf parsley'].flags.length, 1)
    assert.equal(lines['Rapeseed oil'].unit, 'ml')
    assert.equal(data.recipe.incomplete, true)

    const saved = await call('', '/api/setup/dishes', 'POST', { name: data.recipe.name, pricePence: 1250, targetMargin: 70, portions: 10, prepMinutes: 40, serviceMinutes: 6, method: data.recipe.steps.join('\n'), lines: data.recipe.lines.filter((line: any) => !line.flags.length) }, at)
    assert.equal(saved.status, 201)
    const files = await send('', `/api/setup/dishes/${saved.data.id}/files`, [['recipe', pdf, 'sample-recipe.pdf'], ['photo', fs.readFileSync('public/samples/sample-dish.png'), 'sample-dish.png']], {}, at)
    assert.equal(files.status, 200)
    const dish = (await call('', '/api/setup/dishes', 'GET', undefined, at)).data.find((row: any) => row.id === saved.data.id)
    assert.equal(dish.costPence, null)
    assert.ok(dish.unpriced.includes('Lamb mince'))

    const csv = await send('', '/api/ingest/read', [['file', fs.readFileSync(entry('harrow-lane-prices.csv').full), 'harrow-lane-prices.csv']], { kind: 'ingredients' }, at)
    assert.equal(csv.status, 200)
    assert.equal(csv.data.supplier.known, true)
    const unknown = await send('', '/api/ingest/read', [['file', 'Hello, this is not a sample file.', 'mine.txt']], { kind: 'recipes' }, at)
    assert.equal(unknown.status, 400)
    assert.match(unknown.data.error, /In the sample/)
    const dataset = await send('', '/api/ingest/read', [['file', fs.readFileSync(entry('sales-report.pdf').full), 'sales-report.pdf']], { kind: 'sales' }, at)
    assert.equal(dataset.status, 200)
  } finally {
    instance.child.removeAllListeners('exit')
    instance.kill()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('a database on the last version gains the recipe columns on the next start', { skip: !isPostgres() }, async () => {
  const pg = (await import('pg')).default
  const schema = `old_${process.pid}`
  const start = `const { all } = await import('./server/core/db.ts'); console.log(JSON.stringify(await all("SELECT id, portions, recipe_file FROM dishes")))`
  const boot = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', start], { env: { ...process.env, DB_SCHEMA: schema, NODE_TEST_CONTEXT: undefined } })
  await boot()
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  // Puts the schema back to how the last release left it.
  await client.query(`ALTER TABLE "${schema}".dishes DROP COLUMN portions, DROP COLUMN prep_minutes, DROP COLUMN service_minutes, DROP COLUMN recipe_file, DROP COLUMN recipe_file_name`)
  await client.query(`UPDATE "${schema}".settings SET value = '1' WHERE key = 'schema_version'`)
  await client.query(`INSERT INTO "${schema}".dishes (name, price_p, target_margin) VALUES ('Kept', 500, 70)`)
  const { stdout } = await boot()
  const version = await client.query(`SELECT value FROM "${schema}".settings WHERE key = 'schema_version'`)
  await client.query(`DROP SCHEMA "${schema}" CASCADE`)
  await client.end()
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)!).map((row: any) => [row.portions, row.recipe_file]), [[null, null]])
  assert.notEqual(version.rows[0].value, '1')
})

test('a recipe name in capitals becomes a normal dish name', async () => {
  const { plainName } = await import('../server/setup/ingest.ts')
  assert.equal(plainName('CHICKEN BIRYANI'), 'Chicken biryani')
  assert.equal(plainName('Chicken Biryani'), 'Chicken Biryani')
})
