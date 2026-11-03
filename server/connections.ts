import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { get } from './db.ts'
import { openRealtime, samFind, samTrack, sparkJson, transcribeWav } from './meta.ts'
import { gmailStatus } from './gmail.ts'
import { lastCall, ownerPhone, phoneReady } from './phone.ts'
import { dataStatus } from './backup.ts'
import { repliesReady, team, whatsappReady } from './whatsapp.ts'

/** A live call needs Meta's streaming session, so this opens one and closes it straight away. */
function liveCallCheck() {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => done('Live call failed: no answer in 10 seconds.'), 10000)
    const done = (words: string) => { clearTimeout(timer); socket.close(); resolve(words) }
    const socket = openRealtime([], {
      onReady: () => done('Live call: connected.'),
      onPartial: () => {}, onTurn: () => {}, onClose: () => {},
      onError: (message) => done(`Live call failed: ${message.slice(0, 120)}`),
    })
  })
}

/** What's connected, for the owner's screen. Only yes or no: no key, token or phone number leaves the server. */
export async function connectionStatus() {
  const last = await get(`SELECT status, detail, created_at AS at FROM message_log WHERE channel = 'whatsapp' ORDER BY id DESC LIMIT 1`)
  const heard = await get(`SELECT created_at AS at FROM team_messages WHERE direction = 'in' ORDER BY id DESC LIMIT 1`)
  const blocked = await get(`SELECT detail, created_at AS at FROM team_messages WHERE status = 'failed' ORDER BY id DESC LIMIT 1`)
  return {
    meta: { connected: config.mode === 'live', spark: config.sparkModel, voice: config.voiceModel, sam: config.samModel },
    gmail: await gmailStatus(),
    phone: { ready: phoneReady(), rings: !!ownerPhone(), last: await lastCall() },
    data: await dataStatus(),
    whatsapp: {
      connected: whatsappReady(), replies: repliesReady(), people: team().map((person) => person.name),
      last: last ?? null, lastHeardAt: heard?.at ?? null, problem: blocked ?? null,
    },
  }
}

export async function testMeta() {
  if (config.mode !== 'live') return { ok: false, detail: 'Add your Meta key first.' }
  try {
    await sparkJson<{ ok: boolean }>({
      name: 'connection_check',
      schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      system: 'Reply with ok set to true.',
      content: [{ type: 'text', text: 'Connection check.' }],
      effort: 'minimal',
      attempts: 1,
      timeoutMs: 30000,
    })
    // One small white image, to prove the account can reach SAM as well.
    const dot = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
    const sam = await samFind(dot, 'receipt').then(() => `${config.samModel} answered.`).catch((error) => `${config.samModel} failed: ${(error as Error).message.slice(0, 120)}`)
    const clip = `data:video/mp4;base64,${fs.readFileSync(path.resolve('public/samples/sample-proof.mp4')).toString('base64')}`
    const video = await samTrack(clip, 'thermometer').then((frames) => `Video: found it in ${frames.length} frames.`).catch((error) => `Video failed: ${(error as Error).message.slice(0, 120)}`)
    const voice = await transcribeWav(path.resolve('public/samples/sample-fridge.wav'), []).then((heard) => `Voice: heard ${heard.turns.length} turns.`).catch((error) => `Voice failed: ${(error as Error).message.slice(0, 120)}`)
    return { ok: true, detail: `${config.sparkModel} answered. ${sam} ${video} ${voice} ${await liveCallCheck()}` }
  } catch (error) {
    return { ok: false, detail: (error as Error).message.slice(0, 200) }
  }
}
