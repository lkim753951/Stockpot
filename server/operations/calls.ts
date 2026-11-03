import fs from 'node:fs'
import path from 'node:path'
import { background } from '../core/background.ts'
import { config } from '../core/config.ts'
import { all, get, insert, isoDate, nowIso, run, transaction } from '../core/db.ts'
import { callDir, localFile, moveFile, removeFile, saveFile, writeFile } from '../core/files.ts'
import { openRealtime, sparkJson, transcribeWav, type TranscriptTurn } from '../ai/meta.ts'
import { buildCard, lastPaid, type PriceCard } from '../money/pricing.ts'
import { itemFor } from '../setup/setup.ts'
import { findItem, loadCatalogue, mentionsTrade, spotInstantPrice, toBaseQuantity, type CatalogueItem } from '../ai/spotter.ts'
import { orderPrompt, orderSchema, quotesPrompt, quotesSchema, type ExtractedOrder, type Quote } from '../ai/prompts.ts'
import { findPrices, findQuantities } from '../money/money.ts'
import { BYTES_PER_SECOND, pcmToWav, splitWav, wavHeader } from '../ai/wav.ts'

export type CallEvent =
  | { type: 'listening'; saved: number }
  | { type: 'saved'; bytes: number }
  | { type: 'partial'; text: string }
  | { type: 'turn'; turn: number; text: string }
  | { type: 'card'; card: PriceCard }
  | { type: 'warning'; message: string }
  | { type: 'status'; status: string }
  | { type: 'done'; orderId: number | null }

const pcmName = (id: number) => `${id}.pcm`
const wavName = (id: number) => `${id}.wav`
const segmentName = (id: number, offset: number) => `${id}-${String(offset).padStart(12, '0')}.seg`

/** Audio is saved this often, because Vercel can cut a socket off with no warning and no close event. */
const SAVE_EVERY_MS = Number(process.env.CALL_SAVE_MS ?? 15000)
/** How long a dropped call waits for the browser to come back before it's written up. */
const COME_BACK_MS = Number(process.env.CALL_GRACE_MS ?? 45000)
const toMs = (bytes: number) => Math.round((bytes / BYTES_PER_SECOND) * 1000)
const toBytes = (ms: number) => Math.round((ms / 1000) * BYTES_PER_SECOND / 2) * 2

/** Words the transcriber should expect: names from the catalogue and from past invoices. */
export async function vocabulary() {
  const items = (await all('SELECT name FROM items')).map((row) => String(row.name))
  const suppliers = (await all('SELECT name FROM suppliers')).map((row) => String(row.name))
  const billed = (await all(`SELECT description FROM invoice_lines GROUP BY description ORDER BY MAX(id) DESC LIMIT 60`)).map((row) => String(row.description))
  return [...new Set([...items, ...suppliers, ...billed])].slice(0, 100)
}

interface LiveTurn {
  no: number
  text: string
  audioMs: number
}

/** How much of a call is safely saved, counting only what runs on with no gap. */
async function savedBytes(callId: number) {
  let reached = 0
  for (const row of await all('SELECT offset_bytes, bytes FROM call_segments WHERE call_id = ? ORDER BY offset_bytes', callId)) {
    if (Number(row.offset_bytes) > reached) break
    reached = Math.max(reached, Number(row.offset_bytes) + Number(row.bytes))
  }
  return reached
}

/**
 * One connection's share of a call. A call can outlast any one connection, so everything needed to
 * carry on is in the database, and a new LiveCall on any instance picks up from there.
 */
export class LiveCall {
  private items: CatalogueItem[] = []
  private waiting: Buffer[] = []
  private waitingBytes = 0
  /** Where in the whole call the waiting audio starts. */
  private offset = 0
  /** Audio earlier than this was transcribed before a drop, so a resend isn't heard twice. */
  private heardTo = 0
  private baseMs = 0
  private wallStart = Date.now()
  private turns: LiveTurn[] = []
  private shown = new Map<number, { pence: number; kind: PriceCard['kind'] }>()
  private quantities = new Map<number, number>()
  private sparkQueue: Promise<void> = Promise.resolve()
  private saving: Promise<void> = Promise.resolve()
  /** One at a time, because a pool of connections could otherwise save turn 5 before turn 4. */
  private line: Promise<void> = Promise.resolve()
  private sparkWarned = false
  private ended = false
  private told = false
  private readyToHear!: () => void
  /** Settles once the transcriber is listening, or has refused. Either way the audio is being kept. */
  readonly listening = new Promise<void>((resolve) => { this.readyToHear = resolve })
  private realtime!: ReturnType<typeof openRealtime>
  private supplierId = 0
  private connection = 0
  private timer: NodeJS.Timeout | undefined

  private constructor(readonly callId: number, private readonly emit: (event: CallEvent) => void) {}

  static async open(callId: number, emit: (event: CallEvent) => void) {
    const live = new LiveCall(callId, emit)
    await live.start()
    return live
  }

  private async start() {
    const { callId, emit } = this
    const now = nowIso()
    const joined = await run(`UPDATE calls SET status = 'live', started_at = COALESCE(started_at, ?), last_seen_at = ?, connections = connections + 1 WHERE id = ? AND status IN ('ready', 'live')`, now, now, callId)
    if (!joined.changes) throw new Error('This call has already ended.')
    const call = (await get('SELECT supplier_id, connections FROM calls WHERE id = ?', callId))!
    this.supplierId = Number(call.supplier_id)
    this.connection = Number(call.connections)
    this.items = await loadCatalogue()

    // Whatever an earlier connection saved. This is why prices already shown don't show again.
    this.offset = await savedBytes(callId)
    this.baseMs = toMs(this.offset)
    this.wallStart = Date.now() - this.baseMs
    for (const row of await all('SELECT turn_no, end_ms, text FROM call_turns WHERE call_id = ? ORDER BY turn_no', callId)) {
      this.turns.push({ no: Number(row.turn_no), text: String(row.text), audioMs: Number(row.end_ms) })
      this.rememberQuantity(String(row.text))
    }
    this.heardTo = toBytes(this.turns.at(-1)?.audioMs ?? 0)
    for (const row of await all('SELECT item_id, kind, price_p, qty_base FROM live_cards WHERE call_id = ? ORDER BY id', callId)) {
      this.shown.set(Number(row.item_id), { pence: Number(row.price_p), kind: row.kind })
      if (row.qty_base !== null) this.quantities.set(Number(row.item_id), Number(row.qty_base))
    }

    const hear = () => {
      if (this.told) return
      this.told = true
      emit({ type: 'listening', saved: this.offset })
      this.readyToHear()
    }
    this.realtime = openRealtime(await vocabulary(), {
      onReady: hear,
      onPartial: (text, audioMs) => this.inTurn(() => this.onPartial(text, audioMs + this.baseMs)),
      onTurn: (_id, text, audioMs) => this.inTurn(() => this.onTurn(text, audioMs + this.baseMs)),
      onError: (message) => {
        console.error(`call ${callId} realtime:`, message)
        if (!this.ended) emit({ type: 'warning', message: 'Live checks stopped. The recording is safe and will still become an order.' })
        hear()
      },
      onClose: () => undefined,
    }, ['English'], this.baseMs)
    this.timer = setInterval(() => { this.save().catch((error) => console.error(`call ${callId} save:`, (error as Error).message)) }, SAVE_EVERY_MS)
    this.timer.unref()
  }

  private inTurn(work: () => Promise<void>) {
    this.line = this.line.then(work).catch((error) => console.error(`call ${this.callId} live:`, (error as Error).message))
  }

  /** Where the next audio from the browser sits in the whole call. */
  get position() {
    return this.offset + this.waitingBytes
  }

  /** The browser says where its audio starts, after a handover or a resend. */
  async audioFrom(offset: number) {
    await this.save()
    if (Number.isSafeInteger(offset) && offset >= 0 && offset % 2 === 0) this.offset = offset
  }

  audio(pcm: Buffer) {
    if (this.ended) return
    if (this.position / BYTES_PER_SECOND > config.maxCallMinutes * 60) return
    const heardAlready = this.position < this.heardTo
    this.waiting.push(pcm)
    this.waitingBytes += pcm.length
    if (!heardAlready) this.realtime.send(pcm)
  }

  /** Saves what's waiting and tells the browser, so it can stop holding on to its own copy. */
  private save() {
    this.saving = this.saving.then(async () => {
      if (!this.waitingBytes) return
      const chunk = Buffer.concat(this.waiting)
      const at = this.offset
      this.waiting = []
      this.waitingBytes = 0
      this.offset = at + chunk.length
      try {
        await saveSegment(this.callId, at, chunk)
        this.emit({ type: 'saved', bytes: at + chunk.length })
      } catch (error) {
        // Kept for the next try. The browser hasn't been told it's safe, so it still has its copy too.
        console.error(`call ${this.callId} segment:`, (error as Error).message)
        this.waiting.unshift(chunk)
        this.waitingBytes += chunk.length
        this.offset = at
      }
    })
    return this.saving
  }

  private context() {
    return this.turns.slice(-3).map((turn) => turn.text).join(' ')
  }

  private latency(audioMs: number) {
    return audioMs ? Math.round(Math.max(0, Date.now() - (this.wallStart + audioMs))) : null
  }

  private async show(card: Omit<Parameters<typeof buildCard>[0], 'supplierId'>) {
    const shownHere = () => {
      const previous = this.shown.get(card.itemId)
      return (previous && previous.pence === card.pricePence && previous.kind === card.kind) || previous?.kind === 'agreed' && card.kind === 'offer'
    }
    if (shownHere()) return
    // Around a handover the other connection may have just shown this one.
    const newest = await get('SELECT kind, price_p FROM live_cards WHERE call_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1', this.callId, card.itemId)
    if (newest) this.shown.set(card.itemId, { pence: Number(newest.price_p), kind: newest.kind })
    if (shownHere()) return
    this.shown.set(card.itemId, { pence: card.pricePence, kind: card.kind })
    const built = await buildCard({ ...card, supplierId: this.supplierId })
    await insert(`INSERT INTO live_cards (call_id, item_id, kind, price_p, qty_base, source, latency_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, this.callId, card.itemId, card.kind, card.pricePence, card.quantityBase, card.source, card.latencyMs, nowIso())
    this.emit({ type: 'card', card: built })
  }

  private rememberQuantity(text: string) {
    const item = findItem(text, this.items)
    const quantity = findQuantities(text)[0]
    if (!item || !quantity) return
    const base = toBaseQuantity(quantity.quantity, quantity.unit, item)
    if (base !== null) this.quantities.set(item.id, base)
  }

  private async onPartial(text: string, audioMs: number) {
    this.emit({ type: 'partial', text })
    const spot = spotInstantPrice(text, this.context(), this.items)
    if (!spot) return
    // A price that has only just appeared may still be growing: "six" then "six ninety".
    if (!/[\s.,?!]$/.test(text) && !/\d\.\d{2}/.test(text) && !/\b(kilo|kg|litre|each|box|case)\b/i.test(text)) return
    await this.show({
      itemId: spot.item.id, kind: 'offer', pricePence: spot.pricePence,
      quantityBase: this.quantities.get(spot.item.id) ?? null, source: 'instant', latencyMs: this.latency(audioMs),
    })
  }

  /** The database gives out turn numbers, so a turn finishing on the old connection during a handover can't clash. */
  private async saveTurn(text: string, audioMs: number) {
    const startMs = this.turns.at(-1)?.audioMs ?? this.baseMs
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const saved = await get(`INSERT INTO call_turns (call_id, turn_no, start_ms, end_ms, text)
                               SELECT CAST(? AS INTEGER), COALESCE(MAX(turn_no), 0) + 1, CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS TEXT) FROM call_turns WHERE call_id = ?
                               ON CONFLICT (call_id, turn_no) DO NOTHING RETURNING turn_no`, this.callId, Math.round(startMs), Math.round(audioMs), text, this.callId)
      if (saved) return Number(saved.turn_no)
    }
    throw new Error('A turn could not be saved.')
  }

  private async onTurn(text: string, audioMs: number) {
    const turn = { no: await this.saveTurn(text, audioMs), text, audioMs }
    this.turns.push(turn)
    this.emit({ type: 'turn', turn: turn.no, text })
    this.rememberQuantity(text)
    const spot = spotInstantPrice(text, this.context(), this.items)
    if (spot) {
      await this.show({
        itemId: spot.item.id, kind: 'offer', pricePence: spot.pricePence,
        quantityBase: this.quantities.get(spot.item.id) ?? null, source: 'instant', latencyMs: this.latency(audioMs),
      })
    }
    if (mentionsTrade(text, this.items)) {
      this.sparkQueue = this.sparkQueue.then(() => this.readQuotes(turn)).catch(() => undefined)
    }
  }

  /** Muse Spark settles what the fast check can't: "up forty pence", "go on then", "the usual". */
  private async readQuotes(turn: LiveTurn) {
    const earlier = this.turns.filter((t) => t.no < turn.no).slice(-5).map((t) => `Turn ${t.no}: ${t.text}`).join('\n') || '(none)'
    try {
      const { quotes } = await sparkJson<{ quotes: Quote[] }>({
        name: 'call_quotes',
        schema: quotesSchema,
        system: await quotesPrompt(),
        content: [{ type: 'text', text: `Earlier turns:\n${earlier}\n\nNewest turn:\n${turn.text}` }],
        effort: 'low',
        timeoutMs: 9000,
        attempts: 1,
      })
      for (const quote of quotes) await this.applyQuote(quote, turn)
    } catch (error) {
      console.error(`call ${this.callId} quotes:`, (error as Error).message)
      if (!this.sparkWarned) {
        this.sparkWarned = true
        this.emit({ type: 'warning', message: 'Slower price checks are unavailable. Clear prices will still show.' })
      }
    }
  }

  private async applyQuote(quote: Quote, turn: LiveTurn) {
    const item = this.items.find((candidate) => candidate.id === quote.item_id)
    if (!item) return
    if (quote.quantity !== null && quote.quantity_unit) {
      const base = toBaseQuantity(quote.quantity, quote.quantity_unit, item)
      if (base !== null) this.quantities.set(item.id, base)
    }
    if (quote.kind === 'reference') return
    let pence = quote.price_pence
    if (pence === null && quote.price_change_pence !== null) {
      const last = await lastPaid(item.id, this.supplierId)
      pence = last ? Number(last.price_p) + quote.price_change_pence : null
    }
    if (pence === null) return
    if (quote.per === 'case') {
      if (!item.caseQty) return
      pence = pence / item.caseQty
    }
    await this.show({
      itemId: item.id, kind: quote.kind, pricePence: pence,
      quantityBase: this.quantities.get(item.id) ?? null, source: 'muse-spark', latencyMs: this.latency(turn.audioMs),
    })
  }

  /** Stops hearing and saves everything, leaving the call open for whichever connection comes next. */
  private async wrapUp() {
    this.ended = true
    clearInterval(this.timer)
    this.realtime.finish()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    this.realtime.close()
    await this.line
    await this.sparkQueue
    await this.save()
  }

  /** The owner pressed End. */
  async end() {
    if (this.ended) return
    await this.wrapUp()
    // Something else got there first, so the screen just needs letting go.
    if (!await claimWriteUp(this.callId)) return this.emit({ type: 'done', orderId: null })
    this.emit({ type: 'status', status: 'Writing up the call' })
    const orderId = await finishCall(this.callId, this.turns)
    this.emit({ type: 'done', orderId })
  }

  /** The browser has moved to a new connection, before this one reaches the time limit. */
  async handOver() {
    if (this.ended) return
    await this.wrapUp()
  }

  /** The socket went without a word. If the browser doesn't come back the call is written up anyway. */
  async dropped() {
    if (this.ended) return
    await this.wrapUp()
    const { callId, connection } = this
    background(`call ${callId} ending`, async () => {
      await new Promise((resolve) => setTimeout(resolve, COME_BACK_MS))
      await finishIfAbandoned(callId, connection)
    })
  }
}

async function saveSegment(callId: number, offset: number, pcm: Buffer) {
  const file = segmentName(callId, offset)
  await writeFile(file, pcm, 'calls')
  await run(`INSERT INTO call_segments (call_id, offset_bytes, bytes, file, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (call_id, offset_bytes) DO UPDATE SET bytes = excluded.bytes, file = excluded.file, created_at = excluded.created_at`, callId, offset, pcm.length, file, nowIso())
  await run('UPDATE calls SET last_seen_at = ? WHERE id = ?', nowIso(), callId)
}

/** Only one connection, or one sweep, gets to write a call up. */
async function claimWriteUp(callId: number) {
  return (await run(`UPDATE calls SET status = 'processing', ended_at = ? WHERE id = ? AND status = 'live'`, nowIso(), callId)).changes > 0
}

async function finishIfAbandoned(callId: number, connection: number) {
  const call = await get('SELECT status, connections FROM calls WHERE id = ?', callId)
  if (call?.status !== 'live' || Number(call.connections) !== connection) return
  if (await claimWriteUp(callId)) await finishCall(callId, [])
}

/** For the regular pass. Anything cut off with no chance to tidy up is finished here, so no call stays stuck. */
export async function sweepCalls() {
  const quiet = new Date(Date.now() - 180000).toISOString()
  // One at a time, because a write-up can take minutes and a pass has to end. The next pass takes the next call.
  const call = (await all(`SELECT id, connections FROM calls WHERE status = 'live' AND last_seen_at < ? ORDER BY id LIMIT 1`, quiet))[0]
  if (call) await finishIfAbandoned(Number(call.id), Number(call.connections))
  // Longer than any function can run, so whatever was writing these up has gone. The owner can retry.
  await run(`UPDATE calls SET status = 'failed', error = ? WHERE status = 'processing' AND ended_at < ?`,
    'The recording is saved, but it could not be written up. Try again.', new Date(Date.now() - 400000).toISOString())
}

/** Joins a call's audio into one recording, and fills any gap with silence so turn timings still point at the right place. */
async function joinSegments(callId: number) {
  const list = () => all('SELECT offset_bytes, bytes, file FROM call_segments WHERE call_id = ? ORDER BY offset_bytes', callId)
  let rows = await list()
  if (!rows.length) return false
  // The connection handing over may still be saving its last few seconds.
  const hasGap = () => rows.some((row, index) => index && Number(row.offset_bytes) > Number(rows[index - 1].offset_bytes) + Number(rows[index - 1].bytes))
  for (let attempt = 0; attempt < 8 && hasGap(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    rows = await list()
  }
  const total = Math.max(...rows.map((row) => Number(row.offset_bytes) + Number(row.bytes)))
  const wav = path.join(callDir(), wavName(callId))
  const output = fs.openSync(wav, 'w')
  try {
    fs.writeSync(output, wavHeader(total))
    let written = 0
    for (const row of rows) {
      const offset = Number(row.offset_bytes)
      const pcm = fs.readFileSync(await localFile(String(row.file), 'calls'))
      if (offset > written) fs.writeSync(output, Buffer.alloc(offset - written))
      else if (offset < written) { if (offset + pcm.length <= written) continue }
      written = Math.max(written, offset)
      fs.writeSync(output, pcm.subarray(written - offset))
      written = offset + pcm.length
    }
  } finally {
    fs.closeSync(output)
  }
  await run('UPDATE calls SET duration_ms = ? WHERE id = ?', toMs(total), callId)
  try {
    await saveFile(wavName(callId), 'calls')
    await run('UPDATE calls SET audio_file = ? WHERE id = ?', wavName(callId), callId)
    for (const row of rows) await removeFile(String(row.file), 'calls')
    await run('DELETE FROM call_segments WHERE call_id = ?', callId)
  } catch (error) {
    // The parts stay in Storage and the write-up still goes ahead from the copy on this disk.
    console.error(`call ${callId} recording:`, (error as Error).message)
  }
  return true
}

function weekdayName(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
}

/** A recording made elsewhere joins the same path as a call heard live. The browser has already made it a 24 kHz WAV. */
export async function addRecording(supplierId: number, upload: string) {
  const when = nowIso()
  const id = await insert(`INSERT INTO calls (supplier_id, status, source, consent_at, started_at) VALUES (?, 'processing', 'upload', ?, ?)`, supplierId, when, when)
  await moveFile(upload, 'uploads', wavName(id), 'calls')
  const durationMs = Math.round(((fs.statSync(await localFile(wavName(id), 'calls')).size - 44) / BYTES_PER_SECOND) * 1000)
  await run('UPDATE calls SET audio_file = ?, duration_ms = ?, ended_at = ? WHERE id = ?', wavName(id), durationMs, when, id)
  background(`call ${id} recording`, () => finishCall(id, []).catch(async (error) => {
    console.error(`call ${id} recording:`, (error as Error).message)
    await run('UPDATE calls SET status = ?, error = ? WHERE id = ?', 'failed', 'The recording is saved, but it could not be written up. Try again.', id)
  }))
  return id
}

/** Final pass over the saved recording: who said what, then a draft order the owner can check. */
export async function finishCall(callId: number, liveTurns: LiveTurn[]): Promise<number | null> {
  const call = (await get('SELECT * FROM calls WHERE id = ?', callId))!
  await run('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?', 'processing', nowIso(), callId)
  // A call from before segments, left in the old format.
  const oldPcm = path.join(callDir(), pcmName(callId))
  if (fs.existsSync(oldPcm)) {
    const durationMs = pcmToWav(oldPcm, path.join(callDir(), wavName(callId)))
    fs.rmSync(oldPcm, { force: true })
    await saveFile(wavName(callId), 'calls')
    await run('UPDATE calls SET audio_file = ?, duration_ms = ? WHERE id = ?', wavName(callId), durationMs, callId)
  }
  await joinSegments(callId)

  let turns: TranscriptTurn[] = []
  try {
    const wav = await localFile(wavName(callId), 'calls')
    const chunks = splitWav(wav)
    const words = await vocabulary()
    // All at once, because one after another could outlast a function on a long call.
    const heard = await Promise.all(chunks.map((chunk) => transcribeWav(chunk.file, words)))
    let turnId = 0
    chunks.forEach((chunk, index) => {
      for (const turn of heard[index].turns) {
        turnId += 1
        turns.push({ ...turn, turnId, startMs: Math.round(turn.startMs + chunk.offsetMs), endMs: Math.round(turn.endMs + chunk.offsetMs) })
      }
      if (chunk.file !== wav) fs.rmSync(chunk.file, { force: true })
    })
  } catch (error) {
    console.error(`call ${callId} transcription:`, (error as Error).message)
  }
  if (!turns.length) {
    // Without speaker labels the live turns still give the owner something to check.
    const saved = liveTurns.length ? liveTurns : (await all('SELECT turn_no, end_ms, text FROM call_turns WHERE call_id = ? ORDER BY turn_no', callId))
      .map((row) => ({ no: Number(row.turn_no), text: String(row.text), audioMs: Number(row.end_ms) }))
    let previous = 0
    turns = saved.map((turn, index) => {
      const start = previous
      previous = turn.audioMs
      return { turnId: index + 1, startMs: start, endMs: turn.audioMs, transcript: turn.text }
    })
  }
  if (!turns.length) {
    await run('UPDATE calls SET status = ?, error = ? WHERE id = ?', 'failed', 'No speech was found in this recording.', callId)
    return null
  }

  await transaction(async () => {
    await run('DELETE FROM call_turns WHERE call_id = ?', callId)
    for (const turn of turns) {
      await run('INSERT INTO call_turns (call_id, turn_no, start_ms, end_ms, speaker, text) VALUES (?, ?, ?, ?, ?, ?)',
        callId, turn.turnId, turn.startMs, turn.endMs, turn.speaker ?? null, turn.transcript)
    }
  })

  await run('UPDATE calls SET error = NULL WHERE id = ?', callId)
  const supplier = (await get('SELECT name FROM suppliers WHERE id = ?', call.supplier_id))!
  const today = isoDate()
  try {
    const extracted = await sparkJson<ExtractedOrder>({
      name: 'draft_order',
      schema: orderSchema,
      system: await orderPrompt(today, weekdayName(today), String(supplier.name)),
      content: [{ type: 'text', text: turns.map((turn) => `Turn ${turn.turnId} (speaker ${turn.speaker ?? 'unknown'}): ${turn.transcript}`).join('\n') }],
      effort: 'medium',
    })
    const orderId = await saveDraftOrder(callId, Number(call.supplier_id), extracted, turns, today)
    await run('UPDATE calls SET status = ?, summary = ? WHERE id = ?', 'done', extracted.summary, callId)
    return orderId
  } catch (error) {
    console.error(`call ${callId} order:`, (error as Error).message)
    await run('UPDATE calls SET status = ?, error = ? WHERE id = ?', 'failed', 'The recording is saved, but the order could not be written up. Try again.', callId)
    return null
  }
}

async function saveTasks(callId: number, extracted: ExtractedOrder, fallbackDate: string | null) {
  for (const task of extracted.tasks) {
    const due = task.due_date && /^\d{4}-\d{2}-\d{2}$/.test(task.due_date) ? task.due_date : fallbackDate
    await run('INSERT INTO tasks (call_id, title, due_date, urgency) VALUES (?, ?, ?, ?)', callId, task.title, due, task.priority ?? null)
  }
}

/** A new restaurant has no item list yet, so what was ordered on the call starts one. */
async function addNewItems(extracted: ExtractedOrder) {
  for (const line of extracted.lines) {
    const name = line.new_item_name?.trim().slice(0, 120)
    if (line.item_id !== null || !name || line.quantity_unit === 'case') continue
    line.item_id = await itemFor(name, line.quantity_unit).then((item) => item.id).catch(() => null)
  }
}

export async function saveDraftOrder(callId: number, supplierId: number, extracted: ExtractedOrder, turns: TranscriptTurn[], today: string) {
  await addNewItems(extracted)
  const items = await loadCatalogue()
  const validDate = extracted.delivery_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.delivery_date) && extracted.delivery_date >= today
    ? extracted.delivery_date : null
  // Not every call places an order. A recording can hold only promises, and those still become tasks.
  if (!extracted.lines.some((line) => items.some((item) => item.id === line.item_id))) {
    await saveTasks(callId, extracted, validDate)
    return null
  }
  const orderId = await insert('INSERT INTO orders (call_id, supplier_id, delivery_date, summary, created_at) VALUES (?, ?, ?, ?, ?)',
    callId, supplierId, validDate, extracted.summary, nowIso())

  for (const role of extracted.speaker_roles) {
    await run('UPDATE call_turns SET role = ? WHERE call_id = ? AND speaker = ?', role.role, callId, role.speaker)
  }

  for (const line of extracted.lines) {
    const item = items.find((candidate) => candidate.id === line.item_id)
    if (!item) continue
    const notes: string[] = []
    const quantityBase = toBaseQuantity(line.quantity, line.quantity_unit, item) ?? line.quantity
    let price = line.agreed_price_pence
    if (price !== null && line.per === 'case') price = item.caseQty ? price / item.caseQty : null

    // The model has to point at the words. If they aren't there, the owner checks the line.
    const evidence = turns.find((turn) => turn.turnId === line.evidence_turn)
    if (price === null) notes.push('No price was agreed on the call.')
    else if (!evidence || !findPrices(evidence.transcript).some((p) => p.pence === Math.round(line.per === 'case' ? line.agreed_price_pence! : price!))) {
      notes.push('Check this price against the recording.')
    }
    const said = turns.some((turn) => findQuantities(turn.transcript).some((q) => q.quantity === line.quantity))
    if (!said) notes.push('Check this quantity against the recording.')

    await insert(`INSERT INTO order_lines (order_id, item_id, qty_milli, agreed_price_p, evidence_turn, needs_review, review_note)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, orderId, item.id, Math.round(quantityBase * 1000), price, line.evidence_turn,
      notes.length ? 1 : 0, notes.join(' ') || null)
  }

  await saveTasks(callId, extracted, validDate)
  if (validDate) {
    await run('INSERT INTO tasks (call_id, title, due_date) VALUES (?, ?, ?)', callId, `Check in the ${String((await get('SELECT name FROM suppliers WHERE id = ?', supplierId))!.name)} delivery`, validDate)
  }
  return orderId
}
