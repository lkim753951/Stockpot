import { all, get, nowIso, run } from '../core/db.ts'
import { CRISIS_CARDS } from './crisis.ts'

/**
 * The cards staff see: the standard ones, with the owner's changes on top. The standard text stays
 * in the code, so a card can always go back to it. No model writes or changes these.
 */

export interface CardStep { text: string; photo: string | null }
export interface CardView { key: string; title: string; call: { label: string; number: string } | null; steps: CardStep[]; edited: boolean; custom: boolean }

const standard = (key: string) => CRISIS_CARDS.find((card) => card.key === key)

export async function crisisCards(): Promise<CardView[]> {
  const saved = await all('SELECT * FROM crisis_cards ORDER BY added_at IS NOT NULL, added_at, key')
  const fromRow = (row: Record<string, any>, custom: boolean): CardView => ({
    key: String(row.key), title: String(row.title), steps: JSON.parse(String(row.steps)), edited: !custom, custom,
    call: row.call_number ? { label: `Call ${row.call_number}`, number: String(row.call_number).replace(/[^\d+]/g, '') } : null,
  })
  const defaults = CRISIS_CARDS.map((card): CardView => {
    const row = saved.find((candidate) => candidate.key === card.key)
    return row ? fromRow(row, false) : { key: card.key, title: card.title, call: card.call ?? null, steps: card.steps.map((text) => ({ text, photo: null })), edited: false, custom: false }
  })
  return [...defaults, ...saved.filter((row) => !standard(String(row.key))).map((row) => fromRow(row, true))]
}

export const crisisCard = async (key: unknown) => (await crisisCards()).find((card) => card.key === key) ?? null

export async function saveCrisisCard(key: string, input: { title: string; number: string; steps: CardStep[] }) {
  await run(`INSERT INTO crisis_cards (key, title, call_number, steps, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET title = excluded.title, call_number = excluded.call_number, steps = excluded.steps`,
    key, input.title, input.number || null, JSON.stringify(input.steps), nowIso())
}

/** A standard card goes back to its standard text. A card the owner made goes away. */
export const resetCrisisCard = (key: string) => run('DELETE FROM crisis_cards WHERE key = ?', key)

export const isCrisisPhoto = async (name: string) => !!await get(`SELECT 1 AS used FROM crisis_cards WHERE steps LIKE ?`, `%${name}%`)
