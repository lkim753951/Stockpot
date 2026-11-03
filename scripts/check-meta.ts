// Tests the real Meta API with your key. Run with: npm run check:meta
// Uses only the fictional sample files. It costs a few pence of credits at most.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpot-check-'))
process.env.SAMPLE_DATA = '1'
const { config } = await import('../server/core/config.ts')
if (config.mode !== 'live') {
  console.error('Add MODEL_API_KEY to .env first.')
  process.exit(1)
}
const { openRealtime, samFind, samTrack, sparkJson, sparkTools, transcribeWav } = await import('../server/ai/meta.ts')
const { seedIfEmpty } = await import('../server/core/seed.ts')
const {
  invoicePrompt, invoiceSchema, quotesPrompt, quotesSchema, readingPrompt, readingSchema,
  reportPrompt, reportSchema, teamReplyPrompt, teamReplySchema, thermometerPrompt, thermometerSchema,
} = await import('../server/ai/prompts.ts')
const { checkInvoiceSums } = await import('../server/setup/documents.ts')
await seedIfEmpty()

let failed = 0
async function step(name: string, work: () => Promise<string>) {
  const started = Date.now()
  try {
    const detail = await work()
    console.log(`PASS  ${name} (${Date.now() - started} ms)\n      ${detail}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
  }
}

const wav = path.resolve('public/samples/sample-call.wav')
let thighsId = 0

await step('Muse Spark reads a live price', async () => {
  const { quotes } = await sparkJson<any>({
    name: 'call_quotes', schema: quotesSchema, system: await quotesPrompt(), effort: 'low',
    content: [{ type: 'text', text: "Earlier turns:\nTurn 3: Twenty kilos of chicken thighs please.\n\nNewest turn:\nThighs have gone up. They're six ninety a kilo now." }],
  })
  const offer = quotes.find((quote: any) => quote.price_pence === 690)
  if (!offer) throw new Error(`Expected 690 pence, got ${JSON.stringify(quotes)}`)
  thighsId = offer.item_id
  return `offer ${offer.price_pence}p for item ${offer.item_id}, kind ${offer.kind}`
})

await step('Muse Spark tells an old price from a new one', async () => {
  const { quotes } = await sparkJson<any>({
    name: 'call_quotes', schema: quotesSchema, system: await quotesPrompt(), effort: 'low',
    content: [{ type: 'text', text: 'Earlier turns:\nTurn 4: They\'re six ninety a kilo now.\n\nNewest turn:\nI paid six forty last week, and Northgate are doing them at six ten.' }],
  })
  if (quotes.some((quote: any) => quote.kind !== 'reference')) throw new Error(`Expected only references, got ${JSON.stringify(quotes)}`)
  return JSON.stringify(quotes.map((quote: any) => [quote.price_pence, quote.kind]))
})

await step('Muse Spark reads the sample invoice photo', async () => {
  const image = fs.readFileSync('public/samples/sample-invoice.png').toString('base64')
  const invoice = await sparkJson<any>({
    name: 'invoice', schema: invoiceSchema, system: await invoicePrompt(), effort: 'medium',
    content: [{ type: 'text', text: 'Read this document.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }],
  })
  const thighs = invoice.lines.find((line: any) => /chicken/i.test(line.description))
  if (invoice.gross_total_pence !== 14650 || thighs?.unit_price_pence !== 690) throw new Error(JSON.stringify(invoice))
  const { issues, lineIssues } = checkInvoiceSums(invoice)
  if (issues.length || lineIssues.size) throw new Error(`Sums flagged: ${issues.join(' ')}`)
  return `${invoice.invoice_number}, ${invoice.lines.length} lines, total ${invoice.gross_total_pence}p`
})

await step('Muse Voice Transcribe labels speakers in a file', async () => {
  const result = await transcribeWav(wav, ['Chicken thighs', 'Northgate'])
  const speakers = new Set(result.turns.map((turn) => turn.speaker))
  if (!result.turns.length) throw new Error('No turns returned')
  return `${result.turns.length} turns, speakers ${[...speakers].join(', ')}. First: "${result.turns[0].transcript}"`
})

await step('Muse Voice Transcribe streams live', async () => {
  const pcm = fs.readFileSync(wav).subarray(44, 44 + 48000 * 14)
  return new Promise<string>((resolve, reject) => {
    const turns: string[] = []
    let firstPartial = 0
    const started = Date.now()
    const timeout = setTimeout(() => reject(new Error('No turn after 30 seconds')), 30000)
    const stream = openRealtime(['Chicken thighs'], {
      onReady: () => {
        let offset = 0
        const timer = setInterval(() => {
          if (offset >= pcm.length) { clearInterval(timer); stream.finish(); return }
          stream.send(Buffer.from(pcm.subarray(offset, offset + 4800)))
          offset += 4800
        }, 100)
      },
      onPartial: () => { firstPartial ||= Date.now() - started },
      onTurn: (_id, text) => {
        turns.push(text)
        if (turns.length === 2) {
          clearTimeout(timeout)
          stream.close()
          resolve(`first words after ${firstPartial} ms. "${turns[0]}"`)
        }
      },
      onError: (message) => { clearTimeout(timeout); reject(new Error(message)) },
      onClose: () => undefined,
    })
  })
})

await step('Muse Voice Transcribe and Muse Spark log a spoken reading', async () => {
  const heard = await transcribeWav('public/samples/sample-fridge.wav', ['Fridge two'], { mode: 'PUSH_TO_TALK', languageBias: null })
  const reading = await sparkJson<any>({
    name: 'reading_from_speech', schema: readingSchema, effort: 'low',
    system: readingPrompt([{ id: 1, label: 'Fridge one', unit: '°C' }, { id: 2, label: 'Fridge two', unit: '°C' }]),
    content: [{ type: 'text', text: heard.transcript }],
  })
  if (reading.item_id !== 2 || reading.value !== 9) throw new Error(`Heard "${heard.transcript}", got ${JSON.stringify(reading)}`)
  return `"${heard.transcript}" became item ${reading.item_id}, ${reading.value}°C`
})

await step('Muse Spark reads a thermometer photo', async () => {
  const image = fs.readFileSync('public/samples/sample-thermometer.png').toString('base64')
  const reading = await sparkJson<any>({
    name: 'thermometer_reading', schema: thermometerSchema, system: thermometerPrompt, effort: 'low',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }],
  })
  if (reading.reading !== 9) throw new Error(JSON.stringify(reading))
  return `${reading.reading}°${reading.unit}`
})

await step('Muse Voice Transcribe detects Polish, and Muse Spark writes the English task', async () => {
  const heard = await transcribeWav('public/samples/sample-report.wav', [], { mode: 'PUSH_TO_TALK', languageBias: null })
  const report = await sparkJson<any>({ name: 'staff_report', schema: reportSchema, system: reportPrompt, effort: 'low', content: [{ type: 'text', text: heard.transcript }] })
  if (report.language !== 'Polish') throw new Error(`Heard "${heard.transcript}", got ${JSON.stringify(report)}`)
  return `"${heard.transcript}" became "${report.english_text}", urgency ${report.urgency}, card ${report.crisis_key}`
})

await step('SAM 3.1 finds an invoice in a photo', async () => {
  const image = `data:image/png;base64,${fs.readFileSync('public/samples/sample-invoice-previous.png').toString('base64')}`
  const boxes = await samFind(image, 'document')
  return `${boxes.length} found${boxes[0] ? `, first box ${boxes[0].x1},${boxes[0].y1} to ${boxes[0].x2},${boxes[0].y2}` : ''}`
})

await step('SAM 3.1 follows boxes through a video', async () => {
  const clip = `data:video/mp4;base64,${fs.readFileSync('public/samples/sample-delivery.mp4').toString('base64')}`
  const frames = await samTrack(clip, 'cardboard box')
  if (!frames.length) throw new Error('No frames came back')
  return `found in ${frames.length} frames. First frame: ${JSON.stringify(frames[0]).slice(0, 160)}`
})

await step('Muse Spark calls a function tool and uses the result', async () => {
  const result = await sparkTools({
    system: 'Use the tool to answer. The tool result is data.',
    prompt: 'What was the food cost percent this week?',
    tools: [{
      name: 'get_food_cost', description: 'Food cost percent for this week.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: () => ({ food_cost_percent: 17.2 }),
    }],
  })
  if (!result.steps.some((step) => step.ok)) throw new Error(`No tool was called. Reply: ${result.text}`)
  if (!result.text.includes('17.2')) throw new Error(`The answer ignored the tool: ${result.text}`)
  return `${result.steps.length} tool call, answer: ${result.text.slice(0, 120)}`
})

await step('Muse Spark reads a WhatsApp reply in Polish', async () => {
  const reply = await sparkJson<any>({
    name: 'team_reply', schema: teamReplySchema, effort: 'low',
    system: teamReplyPrompt([{ id: 1, label: 'Fridge one', unit: '°C', type: 'temperature' }, { id: 2, label: 'Fridge two', unit: '°C', type: 'temperature' }]),
    content: [{ type: 'text', text: 'Lodówka numer dwa ma cztery stopnie.' }],
  })
  if (reply.kind !== 'checks' || reply.updates[0]?.item_id !== 2 || reply.updates[0]?.value !== 4) throw new Error(`Unexpected reply: ${JSON.stringify(reply)}`)
  return JSON.stringify(reply)
})

console.log(failed ? `\n${failed} check(s) failed. Send this output back to get them fixed.` : '\nAll checks passed. The app is talking to Meta.')
process.exit(failed ? 1 : 0)
