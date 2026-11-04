import path from 'node:path'
import crypto from 'node:crypto'
import express, { type Request, type Response } from 'express'
import { background } from '../core/background.ts'
import { config } from '../core/config.ts'
import { all, claim, get, insert, nowIso, releaseClaim, run, saveSetting, setting } from '../core/db.ts'
import { inLanguage, lang, t } from '../core/lang.ts'
import { isLang } from '../../shared/lang.ts'
import { localTime } from '../core/clock.ts'
import { sparkJson, transcribeWav } from '../ai/meta.ts'
import { documentPart } from '../setup/documents.ts'
import { localFile, saveFile, uploadDir, writeFile } from '../core/files.ts'
import { findNumbers } from '../money/money.ts'
import { itemFor, listRuns, outOfRange, rangeShown, runView, saveEntry } from './checklists.ts'
import { fileReport } from './reports.ts'
import { checkProof } from '../money/proof.ts'
import { joinByInvite } from './invites.ts'
import { orderWaitingOn, supplierByNumber, supplierSentInvoice, supplierWrote } from './supplierOrders.ts'
import { crisisCard } from './crisisCards.ts'
import { voiceNoteToWav } from '../ai/voicenote.ts'
import { assigneesFor, contactFor, downloadMedia, loadStaff, markDelivery, sendToPerson, signatureValid, team, whatsappReady, type Contact } from '../integrations/whatsapp.ts'
import { teamReplyPrompt, teamReplySchema, thermometerPrompt, thermometerSchema, type ExtractedTeamReply, type ExtractedThermometer } from '../ai/prompts.ts'

/**
 * Team messages. Checklists go out on WhatsApp, and staff answer with a message, a voice note
 * or a photo in any language. Anything a model read is sent back for a yes before it is saved,
 * the same rule as the app. What isn't about a check becomes a staff report, so no words are lost.
 */

export interface Incoming {
  waId: string
  person: Pick<Contact, 'name' | 'number' | 'language'>
  type: 'text' | 'voice' | 'photo' | 'other'
  text?: string
  /** Fetches the media only once the message has passed every check. */
  media?: () => Promise<{ file: string; name?: string }>
}

const PROPOSAL_LIFE_MS = 2 * 60 * 60 * 1000
// Accented and Korean letters don't count as word characters, so these end on a space or punctuation rather than \b.
const END = '(?=$|[\\s.,!])'
const YES = new RegExp(`^(yes|y|yep|ok|okay|save|tak|sí|sì|si|sim|da|bine|oui|evet|có|oo|opo|हो|हुन्छ|네|예|응|저장|はい|是|好|हाँ|हां|হ্যাঁ|جی|ہاں|نعم)${END}`, 'i')
const NO = new RegExp(`^(no|n|nope|non|não|nao|change|cancel|nie|nu|hayır|không|hindi|होइन|छैन|아니|아니요|아니오|いいえ|不|नहीं|না|نہیں|لا)${END}`, 'i')
const DONE = /^(all )?(done|finished|complete|completed|gotowe|zrobione|gata|terminat|hecho|listo|terminado|feito|pronto|fatto|finito|fait|terminé|tamam|bitti|xong|tapos|tapos na|완료|끝|다했어요|完了|終わり|終わりました|完成|做完了|好了|हो गया|हो गई|पूरा|भयो|सकियो|হয়ে গেছে|শেষ|ہو گیا|مکمل|تم|انتهيت)[.!]*$/iu

/** What a person last wrote in, or what the owner set for them, or English. */
const languageFor = async (person: { name: string; language?: string | null }) => await setting(`language:${person.name}`) ?? person.language ?? 'en'

interface OpenCheck { id: number; runId: number; label: string; type: string; unit: string | null; proof: boolean }

async function openChecks(): Promise<OpenCheck[]> {
  return (await Promise.all((await listRuns()).filter((row) => row.state !== 'done').map(async (row) => {
    const view = (await runView(Number(row.id)))!
    return view.items.filter((item) => !item.entry).map((item) => ({
      id: Number(item.id), runId: Number(row.id), label: String(item.label), type: String(item.type), unit: (item.unit as string | null) ?? null, proof: !!item.needsProof,
    }))
  }))).flat()
}

async function openProofChecks() {
  return (await Promise.all((await listRuns()).filter((row) => row.state !== 'done').map(async (row) => (await runView(Number(row.id)))!.items.filter((item) => !item.entry && item.needsProof)
    .map((item) => ({ id: Number(item.id), runId: Number(row.id), label: String(item.label) }))))).flat()
}

const reading = (check: { label: string; unit: string | null }, value: number) => `${t(check.label)}: ${value}${check.unit ?? ''}`

export async function checklistMessage(runId: number) {
  const view = (await runView(runId))!
  const waiting = view.items.filter((item) => !item.entry)
  const readings = waiting.some((item) => item.type !== 'tick')
  return [
    t('Stockpot: {name}, due {time}.', { name: t(String(view.name)), time: String(view.dueAt).slice(11, 16) }),
    '',
    ...waiting.map((item, index) => `${index + 1}. ${t(String(item.label))}${item.unit ? ` (${item.unit})` : ''}`),
    '',
    readings
      ? t('Send a voice note, a photo of the thermometer, or type it, like "fridge two 4". Any language.')
      : t('Reply done when it is all finished, or tell me which ones are.'),
  ].join('\n')
}

/** Sends one checklist to the whole team. Returns what happened, for the owner's screen. */
export async function sendChecklist(runId: number) {
  const view = await runView(runId)
  if (!view) return { ok: false, detail: 'That checklist has gone.' }
  if (!whatsappReady() && config.mode !== 'sample') return { ok: false, detail: 'WhatsApp is not connected yet.' }
  const assigned = view.assignee ? assigneesFor(view.assignee) : []
  const people = !whatsappReady() ? [{ name: String(view.assignee ?? 'Maria') }] : assigned.length ? assigned : team()
  const results = await Promise.all(people.map(async (person) => inLanguage(await languageFor(person), async () => sendToPerson({ to: person, text: await checklistMessage(runId), runId }))))
  const failed = results.find((result) => !result.ok)
  const sent = results.some((result) => result.ok)
  if (sent) await run('UPDATE checklist_runs SET sent_at = COALESCE(sent_at, ?) WHERE id = ?', nowIso(), runId)
  return { ok: !failed, sent, detail: failed?.detail ?? null }
}

const RETRY_AFTER_MS = 15 * 60000

/** Runs on the scheduler: a list goes out an hour before it is due, or up to half an hour late. */
export async function sendDueChecklists() {
  if (!whatsappReady()) return
  const { stamp } = localTime()
  // Plain arithmetic on the restaurant's wall clock, which is how due times are stored.
  const shifted = (minutes: number) => new Date(Date.parse(`${stamp}:00Z`) + minutes * 60000).toISOString().slice(0, 16)
  const due = await all(`SELECT id FROM checklist_runs WHERE sent_at IS NULL AND completed_at IS NULL AND due_at BETWEEN ? AND ?`, shifted(-30), shifted(60))
  const lastTry = new Date(Date.now() - RETRY_AFTER_MS).toISOString()
  for (const row of due) {
    // The timer runs every minute, so a list WhatsApp refused waits before it's tried again.
    if (await get(`SELECT id FROM team_messages WHERE run_id = ? AND status = 'failed' AND created_at >= ? LIMIT 1`, row.id, lastTry)) continue
    // Only the pass that marks the list sends it. If nobody got it, it's unmarked, and the next pass tries again.
    if (!(await run('UPDATE checklist_runs SET sent_at = ? WHERE id = ? AND sent_at IS NULL', nowIso(), row.id)).changes) continue
    const { sent } = await sendChecklist(Number(row.id))
    if (!sent) await run('UPDATE checklist_runs SET sent_at = NULL WHERE id = ?', row.id)
  }
}

async function latestSentRun() {
  const open = (await listRuns()).filter((row) => row.state !== 'done')
  return open.filter((row) => row.sentAt).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))[0] ?? open[0] ?? null
}

async function say(person: Incoming['person'], text: string, buttons?: Array<{ id: string; title: string }>) {
  await sendToPerson({ to: person, text, buttons })
}

async function progressLine(runId: number) {
  const view = await runView(runId)
  if (!view) return ''
  const waiting = view.items.filter((item) => !item.entry)
  const done = view.items.length - waiting.length
  return waiting.length
    ? t('{name}: {done} of {total} done. Next: {next}.', { name: t(String(view.name)), done, total: view.items.length, next: t(String(waiting[0].label)) })
    : t('{name}: all {total} done. Thank you.', { name: t(String(view.name)), total: view.items.length })
}

interface Update { runId: number; itemId: number; value: number | null; proofId?: number }

async function propose(person: Incoming['person'], updates: Update[], transcript: string | null, photoFile: string | null, unsure: boolean) {
  await run(`UPDATE team_proposals SET status = 'replaced' WHERE contact = ? AND status = 'pending'`, person.name)
  const id = await insert('INSERT INTO team_proposals (contact, updates, transcript, photo_file, created_at) VALUES (?, ?, ?, ?, ?)', person.name, JSON.stringify(updates), transcript, photoFile, nowIso())
  const lines = await Promise.all(updates.map(async (update) => {
    const item = (await itemFor(update.runId, update.itemId))!
    if (update.value === null) return t('{label}: done', { label: t(String(item.label)) })
    const wrong = outOfRange(item, update.value) ? t(' (should be {range})', { range: rangeShown(item) ?? '' }) : ''
    return `${reading({ label: String(item.label), unit: item.unit as string | null }, update.value)}${wrong}`
  }))
  const heard = transcript ? `${t('I heard: "{words}"', { words: transcript.slice(0, 200) })}\n\n` : ''
  const check = unsure ? `\n\n${t('Check this number before you save it.')}` : ''
  await say(person, `${heard}${lines.join('\n')}${check}\n\n${t('Save this?')}`, [{ id: `save:${id}`, title: t('Save') }, { id: `change:${id}`, title: t('Change') }])
}

async function pendingFor(name: string) {
  const row = await get(`SELECT * FROM team_proposals WHERE contact = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`, name)
  if (!row) return null
  return Date.now() - Date.parse(String(row.created_at)) > PROPOSAL_LIFE_MS ? null : row
}

async function savePending(person: Incoming['person'], proposal: Record<string, any>) {
  // Whichever yes gets here first saves it. Another instance's yes for the same reading finds nothing to do.
  if (!(await run(`UPDATE team_proposals SET status = 'saved' WHERE id = ? AND status = 'pending'`, proposal.id)).changes) return say(person, t('That one has already been dealt with.'))
  const updates = JSON.parse(String(proposal.updates)) as Update[]
  let flagged = false
  for (const update of updates) {
    const saved = await saveEntry(update.runId, update.itemId, {
      value: update.value, source: 'whatsapp', transcript: proposal.transcript, photoFile: proposal.photo_file, reportedBy: person.name, proofId: update.proofId ?? null,
    })
    if ('flagged' in saved && saved.flagged) flagged = true
  }
  const told = flagged ? ` ${t('Out of range, so the owner was told at {time}.', { time: localTime().time })}` : ''
  await say(person, `${t('Saved.')}${told}\n${(await Promise.all([...new Set(updates.map((update) => update.runId))].map(progressLine))).join('\n')}`)
}

async function fileFor(person: Incoming['person'], text: string, extra: { audioFile?: string | null; photoFile?: string | null } = {}) {
  const report = await fileReport({ text, reporter: person.name, ...extra })
  const card = await crisisCard(report.crisisKey)
  const told = t('Owner told at {time}.', { time: localTime().time })
  await say(person, card ? `${told}\n\n${t(card.title)}\n${card.steps.map((step, index) => `${index + 1}. ${t(step.text)}`).join('\n')}` : told)
}

async function understand(person: Incoming['person'], text: string, voice: boolean, audioFile: string | null) {
  const checks = await openChecks()
  let reply: ExtractedTeamReply | null = null
  if (checks.length) {
    try {
      reply = await sparkJson<ExtractedTeamReply>({
        name: 'team_reply', schema: teamReplySchema, system: teamReplyPrompt(checks),
        content: [{ type: 'text', text }], effort: 'low', timeoutMs: 30000,
      })
    } catch (error) {
      console.error('team reply:', (error as Error).message)
    }
  }
  // Whatever they wrote in is what they get back from now on.
  const spoken = isLang(reply?.language) ? reply!.language as string : null
  if (spoken) await saveSetting(`language:${person.name}`, spoken)
  return inLanguage(spoken ?? lang(), () => actOn(person, reply, checks, text, voice, audioFile))
}

async function actOn(person: Incoming['person'], reply: ExtractedTeamReply | null, checks: OpenCheck[], text: string, voice: boolean, audioFile: string | null) {
  if (!reply || reply.kind === 'report') return fileFor(person, text, { audioFile })
  const needsPicture = reply.updates.map((update) => checks.find((candidate) => candidate.id === update.item_id)).find((check) => check?.proof)
  if (needsPicture) return say(person, t('{label}: send a photo of it, and I can save it.', { label: t(needsPicture.label) }))
  const updates = reply.updates.flatMap((update): Update[] => {
    const check = checks.find((candidate) => candidate.id === update.item_id)
    if (!check) return []
    if (check.type === 'tick') return [{ runId: check.runId, itemId: check.id, value: null }]
    return update.value === null ? [] : [{ runId: check.runId, itemId: check.id, value: update.value }]
  })
  if (reply.kind === 'unclear' || !updates.length) {
    return say(person, t('I couldn\'t match that to a check. Name the check and the reading, like "fridge two 4". If something is wrong, tell me what happened and the owner will get it.'))
  }
  // The number has to be in the words. If it isn't, it still comes back, marked for a closer look.
  const said = findNumbers(text)
  const unsure = updates.some((update) => update.value !== null && !said.includes(Math.abs(update.value)))
  return propose(person, updates, voice ? text : null, null, unsure)
}

/** A photo sent for a check that needs proof. The same suggestion as the app, and the worker still says yes. */
async function handleProof(person: Incoming['person'], file: string, caption: string) {
  const open = await openProofChecks()
  const latest = await latestSentRun()
  // The caption decides. With none, it belongs to the list that just went out, if that list is waiting for a picture.
  const target = open.find((check) => caption.toLowerCase().includes(check.label.toLowerCase())) ?? open.find((check) => check.runId === latest?.id && latest?.sentAt)
  if (!target) return false
  const checked = await checkProof({ runId: target.runId, itemId: target.id, frames: [file], videoFile: null })
  if (!checked) return false
  await run(`UPDATE team_proposals SET status = 'replaced' WHERE contact = ? AND status = 'pending'`, person.name)
  if (checked.type !== 'tick' && checked.reading === null) {
    await say(person, t("I can't read the number in that photo. Send a clearer one."))
    return true
  }
  const updates = [{ runId: target.runId, itemId: target.id, value: checked.type === 'tick' ? null : checked.reading, proofId: Number(checked.proofId) }]
  const id = await insert('INSERT INTO team_proposals (contact, updates, transcript, photo_file, created_at) VALUES (?, ?, ?, ?, ?)', person.name, JSON.stringify(updates), null, file, nowIso())
  const word = checked.verdict === 'ok' ? t('Looks right') : t('Look again')
  await say(person, `${t(target.label)}: ${word}\n${checked.reason}\n\n${t('Save this?')}`, [{ id: `save:${id}`, title: t('Save') }, { id: `change:${id}`, title: t('Change') }])
  return true
}

async function handlePhoto(person: Incoming['person'], file: string, caption: string, name = file) {
  try {
    if (await handleProof(person, file, caption)) return
  } catch (error) {
    console.error('team proof:', (error as Error).message)
  }
  const checks = (await openChecks()).filter((check) => check.type === 'temperature')
  const named = checks.find((check) => caption.toLowerCase().includes(check.label.toLowerCase()))
  const latest = await latestSentRun()
  const target = named ?? checks.find((check) => check.runId === latest?.id) ?? checks[0]
  if (target) {
    try {
      const thermometer = await sparkJson<ExtractedThermometer>({
        name: 'thermometer_reading', schema: thermometerSchema, system: thermometerPrompt,
        content: [{ type: 'text', text: `File name: ${name}` }, await documentPart(file, name)], effort: 'low', timeoutMs: 30000,
      })
      if (thermometer.reading !== null && !thermometer.unclear) {
        const celsius = thermometer.unit === 'F' ? Math.round(((thermometer.reading - 32) * 50) / 9) / 10 : thermometer.reading
        return await propose(person, [{ runId: target.runId, itemId: target.id, value: celsius }], null, file, thermometer.unit === null)
      }
    } catch (error) {
      console.error('team photo:', (error as Error).message)
    }
  }
  return fileFor(person, caption || 'Photo sent on WhatsApp.', { photoFile: file })
}

/** Meta resends messages, and the id is unique, so only one instance ever gets to handle each one. */
async function logIncoming(message: Incoming) {
  const id = await insert('INSERT INTO team_messages (wa_id, direction, contact, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    message.waId, 'in', message.person.name, message.type, message.text?.slice(0, 2000) ?? null, nowIso())
  return id || null
}

async function handle(message: Incoming) {
  const logged = await logIncoming(message)
  if (logged === null) return
  const { person } = message

  if (message.type === 'photo' && message.media) {
    const { file, name } = await message.media()
    await run('UPDATE team_messages SET file = ? WHERE id = ?', file, logged)
    return handlePhoto(person, file, message.text ?? '', name)
  }

  if (message.type === 'voice' && message.media) {
    const { file } = await message.media()
    await run('UPDATE team_messages SET file = ? WHERE id = ?', file, logged)
    const heard = (await transcribeWav(await localFile(file), (await openChecks()).map((check) => check.label), { mode: 'PUSH_TO_TALK', languageBias: null })).transcript.trim()
    await run('UPDATE team_messages SET body = ? WHERE id = ?', heard, logged)
    if (!heard) return say(person, t("I couldn't hear any words. Try again, closer to the phone."))
    return understand(person, heard, true, file)
  }

  const text = (message.text ?? '').trim()
  if (!text) return say(person, t('I can read messages, voice notes and photos.'))

  const pending = await pendingFor(person.name)
  const pressed = text.match(/^(save|change):(\d+)$/)
  const chosen = pressed ? await get(`SELECT * FROM team_proposals WHERE id = ? AND contact = ? AND status = 'pending'`, Number(pressed[2]), person.name) : null
  if (pressed && !chosen) return say(person, t('That one has already been dealt with.'))
  if (chosen ? pressed![1] === 'save' : pending && YES.test(text)) return savePending(person, chosen ?? pending!)
  if (chosen || (pending && NO.test(text))) {
    await run(`UPDATE team_proposals SET status = 'cancelled' WHERE id = ?`, (chosen ?? pending!).id)
    return say(person, t('Not saved. Send it again the right way when you are ready.'))
  }
  if (pending) await run(`UPDATE team_proposals SET status = 'replaced' WHERE id = ?`, pending.id)

  if (DONE.test(text)) {
    const latest = await latestSentRun()
    const view = latest ? await runView(Number(latest.id)) : null
    const ticks = view?.items.filter((item) => !item.entry && item.type === 'tick' && !item.needsProof) ?? []
    if (view && ticks.length) {
      for (const item of ticks) await saveEntry(Number(view.id), Number(item.id), { source: 'whatsapp', reportedBy: person.name })
      return say(person, `${t('Saved.')}\n${await progressLine(Number(view.id))}`)
    }
    if (view) return say(person, `${await progressLine(Number(view.id))} ${t('These need a reading or a photo, so send a voice note or a picture.')}`)
  }
  return understand(person, text, false, null)
}

const queues = new Map<string, Promise<unknown>>()
/** Longer than the slowest voice note takes. If an instance dies holding this, it runs out by itself. */
const TURN_HOLD_MS = 120000
/** Past this a message goes ahead rather than wait for ever. Saving a yes is claimed on its own, so it still can't save twice. */
const LONGEST_WAIT_MS = 45000

/** One person at a time across every instance, so a yes can't overtake the reading it's answering. */
async function inTurn(name: string, work: () => Promise<unknown>) {
  const key = `whatsapp:${name}`
  const giveUpAt = Date.now() + LONGEST_WAIT_MS
  let held = await claim(key, TURN_HOLD_MS)
  while (!held && Date.now() < giveUpAt) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    held = await claim(key, TURN_HOLD_MS)
  }
  try { await work() } finally { if (held) await releaseClaim(key) }
}

/** Messages from one person stay in the order they came, and don't hold up anyone else's. */
export function receive(message: Incoming) {
  const { name } = message.person
  const handled = async () => {
    const language = await languageFor(message.person)
    try {
      await inTurn(name, () => inLanguage(language, () => handle(message)))
    } catch (error) {
      console.error('team message:', (error as Error).message)
      await inLanguage(language, () => say(message.person, t("That didn't work on our side. Try again, or tell the owner directly."))).catch(() => undefined)
    }
  }
  const work = (queues.get(name) ?? Promise.resolve()).then(handled)
  queues.set(name, work)
  return work
}

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }

const mediaFile = (extension: string) => `${crypto.randomUUID()}${extension}`

async function savePhoto(mediaId: string) {
  const { bytes, mime } = await downloadMedia(mediaId)
  const extension = IMAGE_TYPES[mime.split(';')[0]]
  if (!extension) throw new Error('Send the photo as a JPG or PNG.')
  const file = mediaFile(extension)
  await writeFile(file, bytes)
  return { file }
}

async function saveVoice(mediaId: string) {
  const { bytes, mime } = await downloadMedia(mediaId)
  if (!mime.startsWith('audio/ogg')) throw new Error('Send a WhatsApp voice note.')
  const file = mediaFile('.wav')
  await voiceNoteToWav(bytes, path.join(uploadDir(), file))
  await saveFile(file)
  return { file }
}

/** Turns one message from Meta's webhook into an Incoming, or null if it can't be used. */
export function fromWebhook(message: Record<string, any>): Incoming | null {
  const contact = contactFor(String(message.from ?? ''))
  // A stranger who finds the number can't fill in a checklist, reach the owner or spend model credits.
  if (!contact) return null
  const base = { waId: String(message.id), person: contact }
  switch (message.type) {
    case 'text': return { ...base, type: 'text', text: String(message.text?.body ?? '') }
    case 'interactive': return { ...base, type: 'text', text: String(message.interactive?.button_reply?.id ?? '') }
    case 'button': return { ...base, type: 'text', text: String(message.button?.text ?? '') }
    case 'image': return { ...base, type: 'photo', text: String(message.image?.caption ?? ''), media: () => savePhoto(String(message.image?.id)) }
    case 'audio': return { ...base, type: 'voice', media: () => saveVoice(String(message.audio?.id)) }
    default: return { ...base, type: 'other' }
  }
}

const DOCUMENT_TYPES: Record<string, string> = { ...IMAGE_TYPES, 'application/pdf': '.pdf' }

/**
 * A supplier replying to an order. Their number can also be on the team, as it is when the owner tries this on their
 * own phone, so an order waiting on them comes first. With no order waiting, a team member carries on as usual.
 */
async function fromSupplier(raw: Record<string, any>) {
  const supplier = await supplierByNumber(String(raw.from ?? ''))
  if (!supplier) return false
  const waiting = await orderWaitingOn(Number(supplier.id))
  if (!waiting && contactFor(String(raw.from ?? ''))) return false
  const caption = String(raw.text?.body ?? raw.image?.caption ?? raw.document?.caption ?? '')
  await run(`INSERT INTO team_messages (wa_id, direction, contact, kind, body, status, created_at) VALUES (?, 'in', ?, ?, ?, 'received', ?) ON CONFLICT DO NOTHING`, String(raw.id), supplier.name, raw.type === 'text' ? 'text' : 'photo', caption || null, nowIso())
  if (!waiting) return true
  const media = raw.document ?? raw.image
  if (media?.id) {
    const { bytes, mime } = await downloadMedia(String(media.id))
    const extension = DOCUMENT_TYPES[mime.split(';')[0]]
    if (extension) {
      const file = mediaFile(extension)
      await writeFile(file, bytes)
      await supplierSentInvoice(supplier, file, String(raw.document?.filename ?? `invoice${extension}`))
    }
  }
  if (caption) await supplierWrote(supplier, caption)
  return true
}

async function deliver(payload: Record<string, any>) {
  await loadStaff()
  const receiving: Array<Promise<unknown>> = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {}
      if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== config.whatsapp.phoneNumberId) continue
      for (const status of value.statuses ?? []) await markDelivery(String(status.id), status.status === 'failed', status.errors?.[0]?.code)
      for (const raw of value.messages ?? []) {
        if (await fromSupplier(raw)) continue
        const message = fromWebhook(raw)
        if (message) receiving.push(receive(message))
        else if (!await joinByInvite(raw)) console.log('Ignored a WhatsApp message from a number that is not on the team.')
      }
    }
  }
  await Promise.all(receiving)
}

/** Meta's webhook. It has no sign-in, so the signature is the lock, and it reaches nothing else. */
export function whatsappWebhook() {
  const router = express.Router()
  router.get('/whatsapp/webhook', (request: Request, response: Response) => {
    const verified = config.whatsapp.verifyToken && request.query['hub.mode'] === 'subscribe' && request.query['hub.verify_token'] === config.whatsapp.verifyToken
    if (!verified) return void response.status(403).end()
    response.type('text/plain').send(String(request.query['hub.challenge'] ?? ''))
  })
  router.post('/whatsapp/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (request: Request, response: Response) => {
    if (!signatureValid(request.body as Buffer, request.header('x-hub-signature-256'))) return void response.status(401).end()
    // Meta resends anything not answered quickly, so the reply goes first and the work follows.
    response.status(200).end()
    background('webhook', () => deliver(JSON.parse((request.body as Buffer).toString('utf8'))))
  })
  return router
}

export async function teamView() {
  return {
    people: team().map((person) => person.name),
    messages: await all('SELECT id, direction, contact, kind, body, file, status, detail, created_at AS at FROM team_messages ORDER BY id DESC LIMIT 40'),
  }
}
