import { get, insert, nowIso, run } from '../core/db.ts'
import { sparkJson, transcribeWav } from '../ai/meta.ts'
import { addAction } from './actions.ts'
import { localTime } from '../core/clock.ts'
import { CRISIS_KEYS, reportPrompt, reportSchema, type ExtractedReport } from '../ai/prompts.ts'

/** The original words are always kept, even if the model is down, so nothing a worker said is lost. */
export async function fileReport(input: { text: string; audioFile?: string | null; photoFile?: string | null; reporter?: string | null }) {
  let extracted: ExtractedReport | null = null
  try {
    extracted = await sparkJson<ExtractedReport>({
      name: 'staff_report',
      schema: reportSchema,
      system: reportPrompt,
      content: [{ type: 'text', text: input.text }],
      effort: 'low',
      timeoutMs: 45000,
    })
  } catch (error) {
    console.error('staff report:', (error as Error).message)
  }

  const crisisKey = extracted?.crisis_key && CRISIS_KEYS.includes(extracted.crisis_key) ? extracted.crisis_key : null
  const urgency = crisisKey ? 'now' : extracted?.urgency ?? 'today'
  const title = extracted?.title.replace(/\.$/, '') ?? 'New staff report'
  const id = await insert(`INSERT INTO staff_reports (language, original_text, english_text, title, category, urgency, crisis_key, audio_file, photo_file, reporter, translated, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    extracted?.language ?? null, input.text, extracted?.english_text ?? null, title, extracted?.category ?? null, urgency, crisisKey,
    input.audioFile ?? null, input.photoFile ?? null, input.reporter ?? null, extracted ? 1 : 0, nowIso())
  // A report nobody could read might be about anything, so it isn't held back on a guess that it's safe.
  const safety = !!crisisKey || !extracted || (urgency === 'now' && (extracted.safety || extracted.category === 'food-safety'))
  const actionId = await addAction({ sourceType: 'report', sourceId: id, urgency, safety, title, detail: extracted?.english_text ?? "This one couldn't be translated, so open it to read the original." })
  await run('UPDATE staff_reports SET action_id = ? WHERE id = ?', actionId, id)
  return { id, title, urgency, crisisKey, translated: !!extracted, toldAt: localTime().time }
}

const QUICK: Record<string, { title: string; crisisKey: string }> = {
  power: { title: 'The power is off', crisisKey: 'power' },
  water: { title: 'The water is off', crisisKey: 'water' },
  gas: { title: 'Gas smell or leak', crisisKey: 'gas' },
}

export async function quickReport(kind: string) {
  const quick = QUICK[kind]
  if (!quick) return null
  const id = await insert(`INSERT INTO staff_reports (language, original_text, english_text, title, category, urgency, crisis_key, translated, created_at)
                     VALUES ('English', ?, ?, ?, 'equipment', 'now', ?, 1, ?)`, quick.title, quick.title, quick.title, quick.crisisKey, nowIso())
  const actionId = await addAction({ sourceType: 'report', sourceId: id, urgency: 'now', safety: true, title: quick.title, detail: 'Reported from the staff app.' })
  await run('UPDATE staff_reports SET action_id = ? WHERE id = ?', actionId, id)
  return { id, title: quick.title, urgency: 'now', crisisKey: quick.crisisKey, toldAt: localTime().time }
}

export async function reportView(id: number) {
  const report = await get('SELECT * FROM staff_reports WHERE id = ?', id)
  if (!report) return null
  const action = report.action_id ? await get('SELECT id, status FROM actions WHERE id = ?', report.action_id) : undefined
  return {
    id: report.id, title: report.title, language: report.language, original: report.original_text, english: report.english_text,
    category: report.category, urgency: report.urgency, crisisKey: report.crisis_key, audio: report.audio_file, photo: report.photo_file, video: report.video_file, reporter: report.reporter, translated: !!report.translated,
    createdAt: report.created_at, actionId: action?.id ?? null, open: action?.status === 'open',
  }
}

export const transcribeReport = async (wavPath: string) =>
  (await transcribeWav(wavPath, [], { mode: 'PUSH_TO_TALK', languageBias: null })).transcript.trim()
