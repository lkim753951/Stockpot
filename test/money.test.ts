import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPrices, findQuantities, formatPounds } from '../server/money/money.ts'

const pence = (text: string) => findPrices(text).map((price) => price.pence)

test('reads the ways people say prices on the phone', () => {
  assert.deepEqual(pence("They're six ninety a kilo now."), [690])
  assert.deepEqual(pence('six pounds ninety'), [690])
  assert.deepEqual(pence('£6.90 per kilo'), [690])
  assert.deepEqual(pence('6.90 a kilo'), [690])
  assert.deepEqual(pence('eighty five pence a kilo'), [85])
  assert.deepEqual(pence('eighty-five pence'), [85])
  assert.deepEqual(pence('85p'), [85])
  assert.deepEqual(pence('twelve fifty a box'), [1250])
  assert.deepEqual(pence('six pounds'), [600])
  assert.deepEqual(pence('12 quid'), [1200])
  assert.deepEqual(pence('six forty-five'), [645])
})

test('keeps several prices in order', () => {
  assert.deepEqual(pence('Six ninety? I paid six forty last week'), [690, 640])
})

test('does not mistake quantities for prices', () => {
  assert.deepEqual(pence('Twenty kilos of chicken thighs please'), [])
  assert.deepEqual(pence('ten kilos of brown onions'), [])
  assert.deepEqual(pence('two ten kilo boxes'), [])
  assert.deepEqual(pence('Morning Dave, what can I get you for Thursday?'), [])
})

test('reads quantities', () => {
  assert.deepEqual(findQuantities('Twenty kilos of chicken thighs'), [{ quantity: 20, unit: 'kg' }])
  assert.deepEqual(findQuantities('deliver 10 kg onions on Thursday'), [{ quantity: 10, unit: 'kg' }])
  assert.deepEqual(findQuantities('three cases of cream'), [{ quantity: 3, unit: 'case' }])
})

test('formats money', () => {
  assert.equal(formatPounds(2280), '£22.80')
  assert.equal(formatPounds(85), '£0.85')
  assert.equal(formatPounds(-50), '-£0.50')
})

test('a bare number before a unit price is read as pence, as the real transcriber writes it', async () => {
  const { findPrices } = await import('../server/money/money.ts')
  assert.equal(findPrices("Thighs have gone up they're 690 a kilo now")[0]?.pence, 690)
  assert.equal(findPrices('Go on then 1250 per case for you')[0]?.pence, 1250)
  assert.equal(findPrices('Twenty kilos, and 500 kilos next month').length, 0)
})
