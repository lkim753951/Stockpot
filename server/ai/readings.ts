import path from 'node:path'
import { sparkJson, transcribeWav } from './meta.ts'
import { documentPart } from '../setup/documents.ts'
import { findNumbers } from '../money/money.ts'
import { itemFor, outOfRange, rangeShown, runView } from '../operations/checklists.ts'
import {
  readingPrompt, readingSchema, thermometerPrompt, thermometerSchema,
  type ExtractedReading, type ExtractedThermometer,
} from './prompts.ts'

/** What a model thinks it heard or saw. Nothing is logged until a person confirms it. */
async function proposal(runId: number, itemId: number | null, value: number | null, extra: Record<string, unknown>) {
  const item = itemId === null ? undefined : await itemFor(runId, itemId)
  if (!item || item.check_type === 'tick' || value === null) {
    return { matched: false, itemId: null, label: null, value: null, unit: null, outOfRange: false, range: null, ...extra }
  }
  return {
    matched: true, itemId: Number(item.id), label: String(item.label), value, unit: item.unit,
    outOfRange: outOfRange(item, value), range: rangeShown(item), ...extra,
  }
}

export async function proposeFromVoice(runId: number, wavPath: string) {
  const view = (await runView(runId))!
  const numeric = view.items.filter((item) => item.type !== 'tick')
  const heard = await transcribeWav(wavPath, numeric.map((item) => String(item.label)), { mode: 'PUSH_TO_TALK', languageBias: null })
  const transcript = heard.transcript.trim()
  if (!transcript) return proposal(runId, null, null, { transcript, needsCheck: true })

  const reading = await sparkJson<ExtractedReading>({
    name: 'reading_from_speech',
    schema: readingSchema,
    system: readingPrompt(numeric.map((item) => ({ id: Number(item.id), label: String(item.label), unit: item.unit as string | null }))),
    content: [{ type: 'text', text: transcript }],
    effort: 'low',
    timeoutMs: 30000,
  })
  // The number must be in the words. A mismatch still reaches staff, marked for a closer look.
  const said = reading.value !== null && findNumbers(transcript).includes(Math.abs(reading.value))
  return proposal(runId, reading.item_id, reading.value, { transcript, needsCheck: reading.unclear || !said })
}

export async function proposeFromPhoto(runId: number, itemId: number, file: string, originalName: string) {
  const reading = await sparkJson<ExtractedThermometer>({
    name: 'thermometer_reading',
    schema: thermometerSchema,
    system: thermometerPrompt,
    content: [{ type: 'text', text: `File name: ${path.basename(originalName)}` }, await documentPart(file, originalName)],
    effort: 'low',
    timeoutMs: 30000,
  })
  const celsius = reading.reading !== null && reading.unit === 'F' ? Math.round(((reading.reading - 32) * 50) / 9) / 10 : reading.reading
  return proposal(runId, itemId, reading.unclear ? null : celsius, { transcript: null, needsCheck: reading.unit === null, photoFile: file })
}

