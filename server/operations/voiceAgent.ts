import { background } from '../core/background.ts'
import { saveSetting, setting } from '../core/db.ts'
import { localTime } from '../core/clock.ts'
import { inLanguage, languageName, t } from '../core/lang.ts'
import { sparkJson } from '../ai/meta.ts'
import { voiceTurnPrompt, voiceTurnSchema, type VoiceTurn } from '../ai/prompts.ts'
import { agentLink, askScript, goodbyeScript, holdScript, type CallPlan } from '../integrations/phone.ts'
import { runView, saveEntry } from './checklists.ts'
import { fileReport } from './reports.ts'

/**
 * A late checklist as a phone conversation. Twilio says one thing, writes down the answer and posts it here,
 * and Muse Spark decides what to say next. Each turn is its own request, so this runs on Vercel, and a reading
 * is read back and agreed before it is saved: the same rule as the app and WhatsApp.
 */

interface Pending { itemId: number; value: number | null; label: string }
interface CallState { said: Array<{ them: string; us: string }>; pending: Pending[]; silences: number; told: boolean }

/** Twilio's trial follows ten links in a call, so the call winds up before it runs out. */
const MOST_TURNS = 7
/** Twilio gives up on an answer after five seconds, and a slower one is collected on a second link. */
const ANSWER_WITHIN_MS = 3800
const WAITS = 3

const stateKey = (sid: string) => `call:${sid}`
const replyKey = (sid: string) => `call-reply:${sid}`
const readState = async (sid: string): Promise<CallState> => {
  const saved = await setting(stateKey(sid))
  return saved ? JSON.parse(saved) as CallState : { said: [], pending: [], silences: 0, told: false }
}
const endCall = async (sid: string) => { await saveSetting(stateKey(sid), null) }
const askAgain = (plan: CallPlan) => askScript(t("Sorry, I didn't catch that. Please say it again."), plan.language, agentLink('turn', plan))
const goodbye = (plan: CallPlan) => goodbyeScript(t("I'll let you finish it in the app. Goodbye."), plan.language)

export const openCall = (plan: CallPlan) => askScript(plan.opening ?? '', plan.language, agentLink('turn', { ...plan, opening: undefined }))

async function nextStep(plan: CallPlan, sid: string, heard: string) {
  const state = await readState(sid)
  const view = await runView(plan.runId)
  if (!view) return goodbye(plan)
  const open = view.items.filter((item) => !item.entry)
  const lastTurn = state.said.length + 1 >= MOST_TURNS
  let reply: VoiceTurn
  try {
    reply = await sparkJson<VoiceTurn>({
      name: 'voice_turn', schema: voiceTurnSchema, system: voiceTurnPrompt(languageName()), effort: 'minimal', attempts: 1, timeoutMs: 20000,
      content: [{ type: 'text', text: JSON.stringify({
        checklist: t(String(view.name)), caller: plan.name, last_turn: lastTurn, waiting_for_yes: state.pending,
        open_checks: open.map((item) => ({ id: item.id, label: t(String(item.label)), type: item.type, unit: item.unit ?? null, needs_photo: !!item.needsProof })),
        conversation: state.said, newest: heard,
      }) }],
    })
  } catch (error) {
    console.error('voice turn:', (error as Error).message)
    return askAgain(plan)
  }

  let warned = ''
  if (reply.confirmed) {
    for (const { itemId, value } of state.pending) {
      const saved = await saveEntry(plan.runId, itemId, { value, source: 'phone', transcript: heard, reportedBy: plan.name })
      if ('flagged' in saved && saved.flagged) warned = t('Out of range, so the owner was told at {time}.', { time: localTime().time })
    }
    state.pending = []
  }
  if (reply.problem && !state.told) {
    await fileReport({ text: heard, reporter: plan.name })
    state.told = true
  }
  // Only what's on this list, without a photo rule, and with a reading where one is needed, can wait for a yes.
  const fresh = reply.updates.flatMap((update): Pending[] => {
    const item = open.find((candidate) => Number(candidate.id) === update.item_id)
    if (!item || item.needsProof || (item.type !== 'tick' && update.value === null)) return []
    return [{ itemId: Number(item.id), value: item.type === 'tick' ? null : update.value, label: t(String(item.label)) }]
  })
  if (fresh.length) state.pending = fresh
  state.said.push({ them: heard.slice(0, 300), us: reply.say.slice(0, 300) })
  state.silences = 0

  const say = [warned, reply.say.trim()].filter(Boolean).join(' ')
  const left = (await runView(plan.runId))?.items.some((item) => !item.entry)
  if ((reply.finished && !fresh.length) || lastTurn || (!left && !state.pending.length)) {
    await endCall(sid)
    return goodbyeScript(say, plan.language)
  }
  await saveSetting(stateKey(sid), JSON.stringify(state))
  return askScript(say, plan.language, agentLink('turn', plan))
}

/** Answers inside Twilio's five seconds when it can. If not, the work carries on and Twilio comes back for it. */
export function callTurn(plan: CallPlan, sid: string, heard: string) {
  return inLanguage(plan.language, async () => {
    if (!heard.trim()) {
      const state = await readState(sid)
      state.silences += 1
      if (state.silences > 1) {
        await endCall(sid)
        return goodbye(plan)
      }
      await saveSetting(stateKey(sid), JSON.stringify(state))
      return askAgain(plan)
    }
    let late = false
    const work = nextStep(plan, sid, heard).then(async (script) => {
      if (late) await saveSetting(replyKey(sid), script)
      return script
    })
    const quick = await Promise.race([work, new Promise<null>((resolve) => { setTimeout(() => resolve(null), ANSWER_WITHIN_MS) })])
    if (quick) return quick
    late = true
    background('voice turn', () => work)
    return holdScript(agentLink('wait', plan, '&n=1'))
  })
}

export function callWait(plan: CallPlan, sid: string, tries: number) {
  return inLanguage(plan.language, async () => {
    const ready = await setting(replyKey(sid))
    if (ready) {
      await saveSetting(replyKey(sid), null)
      return ready
    }
    if (tries >= WAITS) {
      await endCall(sid)
      return goodbye(plan)
    }
    return holdScript(agentLink('wait', plan, `&n=${tries + 1}`))
  })
}
