import { sparkJson } from '../ai/meta.ts'
import { documentPart } from './documents.ts'
import { SetupError } from './setup.ts'

/**
 * The owner photographs a station set up for service (or a written prep list) and gets one check per thing in it.
 * Nothing is saved here: the checks land in the form, and the owner reads them before pressing Save.
 */

const MAX_CHECKS = 30

export const checklistPhotoSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_CHECKS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'show'],
        properties: { label: { type: 'string' }, show: { type: 'string' } },
      },
    },
  },
}

export const checklistPhotoPrompt = `A restaurant owner is building a checklist for their kitchen team, such as a mise en place check before service.
The photo is either the station itself, set up the way it should be (containers, trays, bottles, tools), or a written or printed prep list.
List each separate thing a cook should check is there and ready, once, in the order a person would scan it (left to right, top to bottom).
- label is the item in a few words of UK English, such as "Diced onions" or "Chopped coriander". No numbers or bullets.
- show is one short sentence saying what a good photo of that item shows, such as "A full tub of diced onions, lid on, labelled".
- Skip the counter, the walls, people, hands, and anything that is not part of the setup.
- If nothing in the photo can be checked, return an empty list.`

export interface PhotoCheck { label: string; show: string }

export async function checksFromPhoto(file: string, originalName: string): Promise<PhotoCheck[]> {
  const read = await sparkJson<{ items: PhotoCheck[] }>({
    name: 'checklist_photo',
    schema: checklistPhotoSchema,
    system: checklistPhotoPrompt,
    content: [{ type: 'text', text: 'Make the checks from this photo.' }, await documentPart(file, originalName)],
    effort: 'low',
    timeoutMs: 60000,
  })
  const seen = new Set<string>()
  const items = read.items
    .map((item) => ({ label: item.label.trim().replace(/^[-•*\d.)\s]+/, '').slice(0, 120), show: item.show.trim().slice(0, 200) }))
    .filter((item) => item.label && !seen.has(item.label.toLowerCase()) && seen.add(item.label.toLowerCase()))
  if (!items.length) throw new SetupError('Stockpot found nothing to check in that photo. Try one closer to the station.')
  return items
}
