import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Duplex } from 'node:stream'
import { background } from './background.ts'
import { config, setSampleEndpoints } from './config.ts'
import { all, claim, get, insert, isoDate, locked, nowIso, run, saveSetting, setting, transaction } from './db.ts'
import { passcodesInUse, requireOwner, requireStaff, roleForPasscode, roleOf, sessionCookie } from './auth.ts'
import { addRecording, finishCall, LiveCall, type CallEvent } from './calls.ts'
import { addInvoice, allowedExtension, invoiceLinesCsv, readDeliveryNote, readInvoices } from './documents.ts'
import { fileExists, localFile, removeFile, saveFile, sendStored, uploadDir } from './files.ts'
import { approveCredit, checkFor, deliveryMedia, draftCredit, listChecks, markSettled, reportDeliveryProblems, weekSummary } from './checks.ts'
import { saveSupplier } from './setup.ts'
import { priceCheck } from './priceCheck.ts'
import { whatToSay } from './whatToSay.ts'
import { RefusedWipe, refreshStaleSample, resetSample, seedIfEmpty } from './seed.ts'
import { addOwnAction, assignAction, confirmAction, dismissAction, finishAction, listActions, listDoneToday, reopenAction, setUrgency, snoozeAction } from './actions.ts'
import { connectionStatus, testMeta } from './connections.ts'
import { testCall } from './phone.ts'
import { loadStaff, sendToPerson, sendWhatsAppTest, team, whatsappReady } from './whatsapp.ts'
import { receive, sendChecklist, teamView, whatsappWebhook } from './team.ts'
import { homeView } from './home.ts'
import { inLanguage } from './lang.ts'
import { gmailConnected } from './gmail.ts'
import { setupRoutes } from './setupRoutes.ts'
import { itemFor, staffRecipes } from './setup.ts'
import { addSuggestion, analystProgress, analystRunning, askAnalyst, investigate, latestReport, listReports, reportById, runWeeklySummary, startAnalyst, weeklyFacts, type Range } from './analyst.ts'
import { calendarMonth, clearEntry, listRuns, runView, saveEntry, useProofByDefault } from './checklists.ts'
import { jumpTo, localTime, resumeDemoDay, startDemoDay, syncDemoClock } from './clock.ts'
import { proposeFromPhoto, proposeFromVoice } from './readings.ts'
import { fileReport, quickReport, reportView, transcribeReport } from './reports.ts'
import { importSalesCsv } from './sales.ts'
import { onePass, tick } from './scheduler.ts'
import { dropFile, staffMayRead, takeFile, takeFiles, uploadRoutes } from './uploads.ts'
import { isUsableClip } from './wav.ts'

const samples = path.resolve('public/samples')

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, done) => done(null, uploadDir()),
    filename: (_request, file, done) => done(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 30 },
  fileFilter: (_request, file, done) => done(null, allowedExtension(file.originalname)),
})

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, done) => done(null, uploadDir()),
    filename: (_request, _file, done) => done(null, `${crypto.randomUUID()}.wav`),
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, done) => done(null, path.extname(file.originalname).toLowerCase() === '.wav'),
})

const recordingUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, done) => done(null, uploadDir()),
    filename: (_request, _file, done) => done(null, `${crypto.randomUUID()}.wav`),
  }),
  // A 24 kHz recording uses 2.9 MB a minute, and a call stops at 30 minutes.
  limits: { fileSize: 90 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, done) => done(null, path.extname(file.originalname).toLowerCase() === '.wav'),
})

const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, done) => done(null, uploadDir()),
    filename: (_request, _file, done) => done(null, `${crypto.randomUUID()}.csv`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

const anyDocument = { maxBytes: 15 * 1024 * 1024, allowed: (_field: string, name: string) => allowedExtension(name) }
const isWav = (_field: string, name: string) => path.extname(name).toLowerCase() === '.wav'
const takeAudio = takeFile(audioUpload, 'audio', { maxBytes: 12 * 1024 * 1024, allowed: isWav })
const takeRecording = takeFile(recordingUpload, 'audio', { maxBytes: 90 * 1024 * 1024, allowed: isWav })
const takePhoto = takeFile(upload, 'photo', anyDocument)
const takeCsv = takeFile(csvUpload, 'file', { maxBytes: 5 * 1024 * 1024 })

const NEEDS_KEY = 'Add MODEL_API_KEY to use your own voice or photos. Sample mode uses the sample clips.'

const copySample = async (name: string) => {
  const target = `${crypto.randomUUID()}${path.extname(name)}`
  fs.copyFileSync(path.join(samples, name), path.join(uploadDir(), target))
  await saveFile(target)
  return target
}

const idParam = (request: Request, name = 'id') => {
  const value = Number(request.params[name])
  return Number.isInteger(value) && value > 0 ? value : 0
}

async function orderView(orderId: number) {
  const order = await get(`SELECT o.*, s.name AS supplier FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`, orderId)
  if (!order) return null
  const lines = await all(`SELECT ol.*, i.name AS item, i.base_unit AS unit FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ? ORDER BY ol.id`, orderId)
  const turns = order.call_id ? await all('SELECT turn_no, start_ms, end_ms, speaker, role, text FROM call_turns WHERE call_id = ? ORDER BY turn_no', order.call_id) : []
  const tasks = order.call_id ? await all('SELECT * FROM tasks WHERE call_id = ? ORDER BY due_date NULLS FIRST', order.call_id) : []
  const call = order.call_id ? await get('SELECT id, audio_file, duration_ms FROM calls WHERE id = ?', order.call_id) : undefined
  return {
    id: order.id, status: order.status, supplier: order.supplier, deliveryDate: order.delivery_date, summary: order.summary,
    callId: order.call_id, hasAudio: !!call?.audio_file,
    lines: lines.map((line) => ({
      id: line.id, item: line.item, unit: line.unit, quantity: line.qty_milli / 1000, agreedPence: line.agreed_price_p,
      evidenceTurn: line.evidence_turn, needsReview: !!line.needs_review, reviewNote: line.review_note,
    })),
    turns: turns.map((turn) => ({ turn: turn.turn_no, startMs: turn.start_ms, endMs: turn.end_ms, speaker: turn.speaker, role: turn.role, text: turn.text })),
    tasks: tasks.map((task) => ({ id: task.id, title: task.title, dueDate: task.due_date, done: !!task.done })),
  }
}

/** Links invoices that arrived before the order was confirmed. */
async function linkEarlierInvoices(orderId: number, supplierId: number) {
  const free = await get('SELECT id FROM invoices WHERE supplier_id = ? AND order_id IS NULL ORDER BY id DESC LIMIT 1', supplierId)
  if (free) await run('UPDATE invoices SET order_id = ? WHERE id = ?', orderId, free.id)
}

/** A date range from a query string or a JSON body, or nothing if it isn't a real one. */
function rangeOf(request: Request): Range | undefined {
  const from = String(request.query.from ?? request.body?.from ?? '')
  const to = String(request.query.to ?? request.body?.to ?? '')
  const date = /^\d{4}-\d{2}-\d{2}$/
  return date.test(from) && date.test(to) && from <= to ? { from, to } : undefined
}

let started: Promise<void> | null = null

/** First use on each instance. Safe to run on several at once, and it never runs on /healthz. */
function startUp() {
  started ??= (async () => {
    if (config.mode === 'sample' && !process.env.META_BASE_URL) {
      const { startMockMeta } = await import('./sample/mockMeta.ts')
      const mock = await startMockMeta({ delayMs: 350 })
      setSampleEndpoints(mock.httpBase, mock.wsUrl)
    }
    await seedIfEmpty()
    // Lists made before pictures were the default.
    if (await claim('proof_default', 60000) && !await setting('proof_default')) {
      await useProofByDefault()
      await saveSetting('proof_default', '1')
    }
    if (config.mode === 'sample') {
      // Each instance joins the day already running on Vercel. A restart on a Mac starts the story again.
      await locked('sample-day', async () => {
        await (config.hosted ? await resumeDemoDay() : await startDemoDay())
        await refreshStaleSample()
      })
    }
    // Hosted requests run their own checks, and a cold start shouldn't wait for them twice.
    if (!config.hosted) await tick()
  })().catch((error) => { started = null; throw error })
  return started
}

const samePass = (given: string | undefined) => {
  if (!config.cronSecret || !given) return false
  const digest = (text: string) => crypto.createHash('sha256').update(text).digest()
  return crypto.timingSafeEqual(digest(given), digest(`Bearer ${config.cronSecret}`))
}

/** The alert feed is polled every few seconds, so on it the checks only run this often. */
const ALERT_TICK_MS = 60000
let lastAlertTick = 0

/** Routes only. Nothing here touches the database until a request needs it. */
export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // Vercel's edge ends HTTPS, and the Google redirect address is built from what it says.
  app.set('trust proxy', 1)

  // For uptime checks and Vercel, so it stays up when the database doesn't.
  app.get('/healthz', (_request, response) => { response.json({ ok: true }) })

  // Before the JSON parser, because the signature check needs the exact bytes Meta sent.
  app.use('/api', whatsappWebhook())
  app.use(whatsappWebhook())
  app.use(express.json({ limit: '1mb' }))
  // Words built on the server follow the language chosen in the browser that asked.
  app.use((request, _response, next) => inLanguage(request.header('x-stockpot-language'), next))

  /** One pass of everything on a timer. Supabase Cron calls this on Vercel, where nothing stays running. */
  app.post('/api/cron', async (request, response) => {
    if (!samePass(request.header('authorization'))) return void response.status(401).json({ error: 'Sign in first.' })
    await startUp()
    response.json(await onePass())
  })

  // Instances share no memory, so each request reads what another one may have changed.
  app.use('/api', async (_request, _response, next) => {
    await startUp()
    await syncDemoClock()
    await loadStaff()
    next()
  })

  app.get('/api/session', async (request, response) => {
    response.json({ role: roleOf(request), mode: config.mode, needsPasscode: passcodesInUse(), demoTime: config.mode === 'sample' ? localTime().time : null, onboarded: !!await setting('onboarded') })
  })

  app.post('/api/login', (request, response) => {
    const role = roleForPasscode(String(request.body?.passcode ?? ''))
    if (!role) return void response.status(401).json({ error: "That passcode isn't right." })
    response.setHeader('Set-Cookie', sessionCookie(role)).json({ role })
  })

  app.post('/api/logout', (_request, response) => {
    response.setHeader('Set-Cookie', 'stockpot=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0').json({ ok: true })
  })

  app.get('/api/suppliers', requireOwner, async (_request, response) => {
    response.json(await all('SELECT id, name, contact, phone FROM suppliers ORDER BY name'))
  })

  app.get('/api/home', requireOwner, async (_request, response) => {
    await tick()
    response.json(await homeView())
  })

  /** Polled by the owner's screen, so a new urgent item can raise an alert. */
  app.get('/api/alerts', requireOwner, async (_request, response) => {
    if (Date.now() - lastAlertTick > ALERT_TICK_MS) {
      lastAlertTick = Date.now()
      await tick()
    }
    const actions = await listActions()
    response.json({ count: actions.length, urgent: actions.filter((action) => action.urgency === 'now') })
  })

  app.post('/api/actions/:id/done', requireOwner, async (request, response) => {
    const reopening = request.body?.done === false
    if (!(reopening ? await reopenAction(idParam(request)) : await finishAction(idParam(request)))) return void response.status(404).json({ error: 'That item has gone.' })
    response.json({ ok: true })
  })

  /** New items from calls, reports and deliveries wait here for a yes. */
  app.post('/api/actions/:id/confirm', requireOwner, async (request, response) => {
    if (!await confirmAction(idParam(request))) return void response.status(404).json({ error: 'That item has gone.' })
    response.json({ ok: true })
  })

  app.post('/api/actions/:id/dismiss', requireOwner, async (request, response) => {
    if (!await dismissAction(idParam(request))) return void response.status(404).json({ error: 'That item has gone.' })
    response.json({ ok: true })
  })

  app.post('/api/actions', requireOwner, async (request, response) => {
    const title = String(request.body?.title ?? '').trim().slice(0, 200)
    const urgency = ['now', 'today', 'soon'].includes(request.body?.urgency) ? request.body.urgency : 'today'
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.body?.dueDate)) ? String(request.body.dueDate) : null
    if (!title) return void response.status(400).json({ error: 'Say what needs doing.' })
    response.status(201).json({ id: await addOwnAction(title, urgency, dueDate) })
  })

  app.post('/api/actions/:id/urgency', requireOwner, async (request, response) => {
    if (!['now', 'today', 'soon'].includes(request.body?.urgency)) return void response.status(400).json({ error: 'Choose how much it matters.' })
    if (!await setUrgency(idParam(request), request.body.urgency)) return void response.status(404).json({ error: 'That item has gone.' })
    response.json({ ok: true })
  })

  app.post('/api/actions/:id/snooze', requireOwner, async (request, response) => {
    if (!await snoozeAction(idParam(request))) return void response.status(404).json({ error: 'That item has gone.' })
    response.json({ ok: true })
  })

  /** Hands a card to someone on WhatsApp. The browser only ever sees names. */
  app.post('/api/actions/:id/assign', requireOwner, async (request, response) => {
    const name = String(request.body?.person ?? '')
    const person = whatsappReady() ? team().find((candidate) => candidate.name === name) : config.mode === 'sample' ? { name: name || 'Maria' } : undefined
    if (!person) return void response.status(400).json({ error: 'Choose someone on your team.' })
    const action = await assignAction(idParam(request), person.name)
    if (!action) return void response.status(404).json({ error: 'That item has gone.' })
    const result = await sendToPerson({ to: person, text: `Stockpot: can you deal with this?\n${action.title}${action.detail ? `\n${action.detail}` : ''}` })
    if (!result.ok) return void response.status(502).json({ error: result.detail ?? "That didn't send." })
    response.json({ ok: true, person: person.name })
  })

  app.get('/api/team', requireOwner, async (_request, response) => {
    await tick()
    response.json({ ...await teamView(), runs: await listRuns(), connected: whatsappReady() })
  })

  app.get('/api/checklists/calendar', requireOwner, async (request, response) => {
    const month = String(request.query.month ?? '')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return void response.status(400).json({ error: 'Choose a month.' })
    await tick()
    response.json(await calendarMonth(month))
  })

  app.post('/api/team/send/:id', requireOwner, async (request, response) => {
    response.json(await sendChecklist(idParam(request)))
  })

  /** Sample mode only: a staff reply takes the same path a real WhatsApp message does. */
  app.post('/api/sample/whatsapp', requireOwner, async (request, response, next) => {
    if (config.mode !== 'sample') return void response.status(403).json({ error: 'This is only for sample mode.' })
    const person = { name: 'Maria', number: '' }
    const waId = `sample-${crypto.randomUUID()}`
    try {
      if (request.body?.voice) await receive({ waId, person, type: 'voice', media: async () => ({ file: await copySample('sample-report.wav') }) })
      else if (request.body?.photo) await receive({ waId, person, type: 'photo', media: async () => ({ file: await copySample('sample-thermometer.png'), name: 'sample-thermometer.png' }) })
      else await receive({ waId, person, type: 'text', text: String(request.body?.text ?? '').slice(0, 500) })
      response.json(await teamView())
    } catch (error) { next(error) }
  })

  app.get('/api/connections', requireOwner, async (_request, response) => response.json(await connectionStatus()))

  app.post('/api/connections/meta/test', requireOwner, async (_request, response) => response.json(await testMeta()))

  app.post('/api/connections/phone/test', requireOwner, async (_request, response) => response.json(await testCall()))
  app.post('/api/connections/whatsapp/test', requireOwner, async (_request, response) => response.json(await sendWhatsAppTest()))

  app.get('/api/calls', requireOwner, async (_request, response) => {
    const calls = await all(`SELECT c.id, c.status, c.source, c.summary, c.error, c.duration_ms AS durationMs, COALESCE(c.started_at, c.consent_at) AS date,
                         s.name AS supplier, o.id AS orderId
                       FROM calls c JOIN suppliers s ON s.id = c.supplier_id LEFT JOIN orders o ON o.call_id = c.id
                       WHERE c.status <> 'ready' ORDER BY c.id DESC LIMIT 50`)
    response.json(await Promise.all(calls.map(async (call) => ({
      ...call, tasks: (await all('SELECT id, title, due_date AS dueDate, done, urgency FROM tasks WHERE call_id = ? ORDER BY due_date NULLS FIRST', call.id)).map((task) => ({ ...task, done: !!task.done })),
    }))))
  })

  app.post('/api/calls', requireOwner, async (request, response) => {
    const { supplierId, consent, source } = request.body ?? {}
    if (consent !== true) return void response.status(400).json({ error: 'Confirm the supplier has been told about the recording first.' })
    if (!await get('SELECT id FROM suppliers WHERE id = ?', Number(supplierId))) return void response.status(400).json({ error: 'Choose a supplier.' })
    if (source !== 'sample' && config.mode === 'sample') {
      return void response.status(400).json({ error: 'Add MODEL_API_KEY to use a real call. Sample mode plays the sample call.' })
    }
    const id = await insert('INSERT INTO calls (supplier_id, consent_at, source) VALUES (?, ?, ?)', Number(supplierId), nowIso(), source === 'sample' ? 'sample' : 'microphone')
    response.status(201).json({ id })
  })

  /** A recording made outside Stockpot. The browser turns it into a WAV first, so any file it can play works. */
  app.post('/api/calls/upload', requireOwner, takeRecording, async (request, response) => {
    const file = request.file
    const drop = () => dropFile(file)
    if (request.body?.consent !== 'true') { await drop(); return void response.status(400).json({ error: 'Confirm the other person knew the call was recorded.' }) }
    const supplier = await get('SELECT id FROM suppliers WHERE id = ?', Number(request.body?.supplierId))
    if (!supplier) { await drop(); return void response.status(400).json({ error: 'Choose a supplier.' }) }
    if (!file) return void response.status(400).json({ error: 'Add a recording.' })
    if (config.mode === 'sample') { await drop(); return void response.status(400).json({ error: 'Add MODEL_API_KEY to use your own recording. Sample mode uses the sample call.' }) }
    if (!isUsableClip(file.path)) { await drop(); return void response.status(400).json({ error: "That recording couldn't be used. Try a different file." }) }
    response.status(202).json({ id: await addRecording(Number(supplier.id), file.filename) })
  })

  app.post('/api/calls/upload-sample', requireOwner, async (request, response) => {
    const supplier = await get('SELECT id FROM suppliers WHERE id = ?', Number(request.body?.supplierId))
    if (!supplier) return void response.status(400).json({ error: 'Choose a supplier.' })
    response.status(202).json({ id: await addRecording(Number(supplier.id), await copySample('sample-call.wav')) })
  })

  app.get('/api/calls/:id', requireOwner, async (request, response) => {
    const call = await get(`SELECT c.id, c.status, c.error, c.summary, c.source, c.duration_ms AS durationMs, c.audio_file, COALESCE(c.started_at, c.consent_at) AS date, s.name AS supplier
                      FROM calls c JOIN suppliers s ON s.id = c.supplier_id WHERE c.id = ?`, idParam(request))
    if (!call) return void response.status(404).json({ error: 'Call not found.' })
    const order = await get('SELECT id, status FROM orders WHERE call_id = ?', call.id)
    const { audio_file: audio, ...rest } = call
    response.json({
      ...rest, orderId: order?.id ?? null, orderStatus: order?.status ?? null, hasAudio: !!audio,
      turns: await all('SELECT turn_no AS turn, speaker, role, text FROM call_turns WHERE call_id = ? ORDER BY turn_no', call.id),
      tasks: (await all('SELECT id, title, due_date AS dueDate, done, urgency FROM tasks WHERE call_id = ? ORDER BY due_date NULLS FIRST', call.id)).map((task) => ({ ...task, done: !!task.done })),
    })
  })

  app.post('/api/calls/:id/retry', requireOwner, async (request, response, next) => {
    const call = await get('SELECT id, status FROM calls WHERE id = ?', idParam(request))
    if (!call || call.status !== 'failed') return void response.status(400).json({ error: 'This call has nothing to retry.' })
    try { response.json({ orderId: await finishCall(Number(call.id), []) }) } catch (error) { next(error) }
  })

  app.get('/api/calls/:id/audio', requireOwner, async (request, response) => {
    const call = await get('SELECT audio_file FROM calls WHERE id = ?', idParam(request))
    if (!call?.audio_file) return void response.status(404).json({ error: 'This recording has been deleted.' })
    await sendStored(request, response, String(call.audio_file), 'calls')
  })

  app.delete('/api/calls/:id/audio', requireOwner, async (request, response) => {
    const call = await get('SELECT audio_file FROM calls WHERE id = ?', idParam(request))
    if (call?.audio_file) await removeFile(String(call.audio_file), 'calls')
    await run('UPDATE calls SET audio_file = NULL WHERE id = ?', idParam(request))
    response.json({ ok: true })
  })

  app.get('/api/orders/:id', requireOwner, async (request, response) => {
    const order = await orderView(idParam(request))
    if (!order) return void response.status(404).json({ error: 'Order not found.' })
    response.json(order)
  })

  /** A delivery that didn't come from a recorded call: a standing order, or one placed by email. */
  app.post('/api/orders', requireOwner, async (request, response) => {
    try {
      const { supplierId, newSupplier, orderedOn, deliveryDate, lines } = request.body ?? {}
      if (!newSupplier && !await get('SELECT id FROM suppliers WHERE id = ?', Number(supplierId))) return void response.status(400).json({ error: 'Choose a supplier.' })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deliveryDate))) return void response.status(400).json({ error: 'Choose a delivery date.' })
      const ordered = /^\d{4}-\d{2}-\d{2}$/.test(String(orderedOn)) ? String(orderedOn) : nowIso().slice(0, 10)
      if (ordered > deliveryDate) return void response.status(400).json({ error: "The delivery can't be before the order." })
      const rows = (Array.isArray(lines) ? lines : []).filter((line) => String(line?.name ?? '').trim())
      if (!rows.length) return void response.status(400).json({ error: 'Add at least one item.' })
      if (rows.some((line) => !(Number(line.quantity) > 0))) return void response.status(400).json({ error: 'Each quantity must be more than zero.' })
      // Comes after the other checks, so a mistake on the form doesn't leave a stray supplier behind.
      const orderId = await transaction(async () => {
        const supplier = newSupplier ? await saveSupplier(newSupplier) : Number(supplierId)
        const id = await insert(`INSERT INTO orders (supplier_id, status, delivery_date, ordered_on, created_at) VALUES (?, 'confirmed', ?, ?, ?)`, supplier, deliveryDate, ordered, nowIso())
        for (const line of rows) {
          const item = await itemFor(String(line.name).trim().slice(0, 120), String(line.unit ?? 'each'))
          await run('INSERT INTO order_lines (order_id, item_id, qty_milli) VALUES (?, ?, ?)', id, item.id, Math.round(Number(line.quantity) * item.factor * 1000))
        }
        await run('INSERT INTO deliveries (order_id) VALUES (?) ON CONFLICT DO NOTHING', id)
        await linkEarlierInvoices(id, supplier)
        return id
      })
      response.status(201).json({ id: orderId })
    } catch (error) {
      response.status(400).json({ error: (error as Error).message })
    }
  })

  app.post('/api/orders/:id/confirm', requireOwner, async (request, response) => {
    const orderId = idParam(request)
    const order = await get('SELECT * FROM orders WHERE id = ?', orderId)
    if (!order) return void response.status(404).json({ error: 'Order not found.' })
    const { deliveryDate, lines } = request.body ?? {}
    if (deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return void response.status(400).json({ error: 'Choose a delivery date.' })
    const changes = Array.isArray(lines) ? lines : []
    if (changes.some((line) => !(Number(line.quantity) > 0))) return void response.status(400).json({ error: 'Each quantity must be more than zero.' })
    await transaction(async () => {
      for (const line of changes) {
        const price = line.agreedPence === null || line.agreedPence === undefined ? null : Number(line.agreedPence)
        await run('UPDATE order_lines SET qty_milli = ?, agreed_price_p = ?, needs_review = 0, review_note = NULL WHERE id = ? AND order_id = ?',
          Math.round(Number(line.quantity) * 1000), price, Number(line.id), orderId)
      }
      await run(`UPDATE orders SET status = 'confirmed', delivery_date = COALESCE(?, delivery_date) WHERE id = ?`, deliveryDate ?? null, orderId)
      await run('INSERT INTO deliveries (order_id) VALUES (?) ON CONFLICT DO NOTHING', orderId)
      await linkEarlierInvoices(orderId, Number(order.supplier_id))
    })
    response.json(await orderView(orderId))
  })

  app.post('/api/tasks/:id/done', requireOwner, async (request, response) => {
    await run('UPDATE tasks SET done = ? WHERE id = ?', request.body?.done === false ? 0 : 1, idParam(request))
    if (request.body?.done === false) await run(`UPDATE actions SET status = 'open', closed_at = NULL WHERE source_type = 'task' AND source_id = ?`, idParam(request))
    await tick()
    response.json({ ok: true })
  })

  app.get('/api/invoices/price-check', requireOwner, async (request, response) => response.json(await priceCheck(rangeOf(request) ?? { from: '0000-01-01', to: '9999-12-31' })))

  app.get('/api/invoices', requireOwner, async (request, response) => {
    const range = rangeOf(request) ?? { from: '0000-01-01', to: '9999-12-31' }
    const orderBy = ({ amount: 'gross_p', supplier: 'lower(supplier_name)', date: `day` } as Record<string, string>)[String(request.query.sort)] ?? 'day'
    // The two databases put blanks at opposite ends unless told, so a blank always counts as the lowest.
    const direction = request.query.direction === 'asc' ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'
    const invoices = await all(`SELECT id, file, original_name AS name, status, supplier_name AS supplier, number, date, gross_p AS grossPence, issues, order_id AS orderId, source,
                            COALESCE(date, substr(created_at, 1, 10)) AS day
                          FROM invoices WHERE COALESCE(date, substr(created_at, 1, 10)) BETWEEN ? AND ? ORDER BY ${orderBy} ${direction}, id DESC LIMIT 500`, range.from, range.to)
    const lines = await all(`SELECT invoice_id, description, qty_billed AS quantity, unit, unit_price_p AS unitPence, line_total_p AS totalPence, issue FROM invoice_lines
                             WHERE invoice_id IN (SELECT id FROM invoices WHERE COALESCE(date, substr(created_at, 1, 10)) BETWEEN ? AND ?) ORDER BY id`, range.from, range.to)
    response.json(invoices.map((invoice) => ({
      ...invoice,
      issues: JSON.parse(String(invoice.issues)),
      lines: lines.filter((line) => line.invoice_id === invoice.id).map(({ invoice_id: _invoice, ...line }) => line),
    })))
  })

  app.get('/api/invoices.csv', requireOwner, async (request, response) => {
    const range = rangeOf(request)
    response.setHeader('Content-Type', 'text/csv; charset=utf-8')
    response.setHeader('Content-Disposition', `attachment; filename="stockpot-invoice-lines-${range ? `${range.from}-to-${range.to}` : isoDate()}.csv"`)
    response.send(`﻿${await invoiceLinesCsv(range)}`)
  })

  app.post('/api/invoices', requireOwner, takeFiles(upload, 'files', 30, anyDocument), async (request, response) => {
    const files = (request.files ?? []) as Express.Multer.File[]
    if (!files.length) return void response.status(400).json({ error: 'Add a JPG, PNG, WEBP or PDF.' })
    if (config.mode === 'sample') {
      for (const file of files) await dropFile(file)
      return void response.status(400).json({ error: 'Add MODEL_API_KEY to read your own invoices. Sample mode reads the sample invoice.' })
    }
    const ids: number[] = []
    for (const file of files) ids.push(await addInvoice(file.filename, file.originalname.slice(0, 200)))
    background('invoices', () => readInvoices(ids))
    response.status(202).json({ ids })
  })

  app.post('/api/invoices/sample', requireOwner, async (_request, response) => {
    const id = await addInvoice(await copySample('sample-invoice.png'), 'sample-invoice.png')
    background('invoices', () => readInvoices([id]))
    response.status(202).json({ ids: [id] })
  })

  app.post('/api/invoices/sample-pile', requireOwner, async (_request, response) => {
    const ids: number[] = []
    for (const name of ['sample-invoice.png', 'sample-receipt-northgate.png', 'sample-receipt-oakfield.png']) ids.push(await addInvoice(await copySample(name), name))
    background('invoices', () => readInvoices(ids))
    response.status(202).json({ ids })
  })

  /** The owner sees everything. Staff get only the pictures from their own checks and deliveries, never an invoice. */
  app.get('/api/files/:name', requireStaff, async (request, response) => {
    const name = String(request.params.name)
    if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/.test(name)) return void response.status(404).end()
    if (roleOf(request) !== 'owner' && !await staffMayRead(name)) return void response.status(403).json({ error: 'Only the owner can see this.' })
    await sendStored(request, response, name)
  })

  app.get('/api/checks', requireOwner, async (_request, response) => response.json(await listChecks()))

  app.post('/api/checks/:id/what-to-say', requireOwner, async (request, response, next) => {
    try {
      const words = await whatToSay(idParam(request))
      if (!words) return void response.status(404).json({ error: 'Delivery not found.' })
      response.json(words)
    } catch (error) { next(error) }
  })

  app.get('/api/checks/:id', requireOwner, async (request, response) => {
    const check = await checkFor(idParam(request))
    if (!check) return void response.status(404).json({ error: 'Check not found.' })
    response.json({ ...check, gmail: await gmailConnected() })
  })

  app.post('/api/checks/:id/credit', requireOwner, async (request, response) => {
    const credit = await draftCredit(idParam(request))
    if (!credit) return void response.status(400).json({ error: 'Nothing is owed on this order.' })
    response.json(await checkFor(idParam(request)))
  })

  app.post('/api/checks/:id/approve', requireOwner, async (request, response) => {
    const { subject, body } = request.body ?? {}
    if (!subject || !body) return void response.status(400).json({ error: 'The request needs a subject and a message.' })
    await approveCredit(idParam(request), String(subject), String(body))
    response.json(await checkFor(idParam(request)))
  })

  app.post('/api/checks/:id/settled', requireOwner, async (request, response) => {
    await markSettled(idParam(request))
    response.json(await checkFor(idParam(request)))
  })

  app.get('/api/week', requireOwner, async (request, response) => response.json(await weekSummary(rangeOf(request))))

  app.get('/api/reports/:id', requireOwner, async (request, response) => {
    const report = await reportView(idParam(request))
    if (!report) return void response.status(404).json({ error: 'Report not found.' })
    response.json(report)
  })

  const dashboard = async (range?: Range) => {
    const facts = await weeklyFacts(range)
    const shown = (await listChecks()).filter((check) => check.deliveryDate >= facts.period.from && check.deliveryDate <= facts.period.to)
    const deliveries = { count: shown.length, problems: shown.filter((check) => check.problem || check.state === 'owed').length }
    return { report: await latestReport(facts.period), facts, deliveries, money: await weekSummary(facts.period), reports: await listReports(), running: await analystRunning(), ...await analystProgress() }
  }

  app.get('/api/summary', requireOwner, async (request, response) => response.json(await dashboard(rangeOf(request))))

  app.get('/api/summary/:id', requireOwner, async (request, response) => {
    const report = await reportById(idParam(request))
    if (!report) return void response.status(404).json({ error: 'Report not found.' })
    response.json(report)
  })

  app.post('/api/summary/run', requireOwner, async (request, response, next) => {
    try {
      const range = rangeOf(request)
      // A real investigation takes a minute or more, so the screen can start it and watch.
      if (request.body?.background) {
        if (!await startAnalyst()) return void response.json(await dashboard(range))
        // Read first, so the screen sees the run as started however fast it finishes.
        const view = await dashboard(range)
        background('summary', () => investigate(range))
        return void response.status(202).json(view)
      }
      const id = await runWeeklySummary(range)
      if (!id) return void response.status(409).json({ error: 'The summary is already being written.' })
      response.json(await dashboard(range))
    } catch (error) { next(error) }
  })

  app.post('/api/summary/:id/actions/:index', requireOwner, async (request, response) => {
    if (!await addSuggestion(idParam(request), Number(request.params.index))) return void response.status(404).json({ error: 'That suggestion has gone.' })
    response.json({ ok: true })
  })

  // The generative UI provider asks this on load. Answers come from /api/analyst/ask, so there are no agents to list.
  app.get('/api/copilotkit/info', (_request, response) => response.json({ version: '1.83.0', agents: {} }))

  setupRoutes(app)
  uploadRoutes(app)

  app.post('/api/analyst/ask', requireOwner, async (request, response, next) => {
    const question = String(request.body?.question ?? '').trim().slice(0, 300)
    if (!question) return void response.status(400).json({ error: 'Type a question first.' })
    const earlier = (Array.isArray(request.body?.earlier) ? request.body.earlier : []).slice(-3).map((turn: any) => ({ question: String(turn?.question ?? '').slice(0, 300), answer: String(turn?.answer ?? '').slice(0, 500) }))
    try { response.json(await askAnalyst(question, rangeOf(request), earlier)) } catch (error) { next(error) }
  })

  app.post('/api/sales/import', requireOwner, takeCsv, async (request, response) => {
    const file = request.file
    if (!file) return void response.status(400).json({ error: 'Add a CSV file.' })
    try { response.json(await importSalesCsv(fs.readFileSync(file.path, 'utf8'))) } finally { await dropFile(file) }
  })

  app.get('/api/sales/template.csv', requireOwner, (_request, response) => {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8')
    response.setHeader('Content-Disposition', 'attachment; filename="stockpot-sales-template.csv"')
    response.send(`date,dish,quantity,net sales\r\n${isoDate()},Chicken curry,10,95.00\r\n`)
  })

  // Staff routes never return prices, costs or credits.
  app.get('/api/staff/runs', requireStaff, async (_request, response) => {
    await tick()
    response.json(await listRuns())
  })

  app.get('/api/staff/runs/:id', requireStaff, async (request, response) => {
    const view = await runView(idParam(request))
    if (!view) return void response.status(404).json({ error: 'Check not found.' })
    response.json(view)
  })

  app.post('/api/staff/runs/:id/entries', requireStaff, async (request, response) => {
    const runId = idParam(request)
    if (!await runView(runId)) return void response.status(404).json({ error: 'Check not found.' })
    const { itemId, value, source, transcript, photoFile, proofId } = request.body ?? {}
    const photo = typeof photoFile === 'string' && /^[0-9a-f-]{36}\.[a-z0-9]+$/.test(photoFile) && await fileExists(photoFile) ? photoFile : null
    const saved = await saveEntry(runId, Number(itemId), {
      value, photoFile: photo, proofId: proofId ? Number(proofId) : null,
      source: ['tick', 'typed', 'voice', 'photo'].includes(source) ? source : 'tick',
      transcript: typeof transcript === 'string' ? transcript.slice(0, 500) : null,
    })
    if ('error' in saved) return void response.status(400).json({ error: saved.error })
    response.json(saved)
  })

  app.delete('/api/staff/runs/:id/entries/:itemId', requireStaff, async (request, response) => {
    const view = await clearEntry(idParam(request), idParam(request, 'itemId'))
    if (!view) return void response.status(404).json({ error: 'Check not found.' })
    response.json({ run: view })
  })

  app.post('/api/staff/runs/:id/voice', requireStaff, takeAudio, async (request, response, next) => {
    const runId = idParam(request)
    const file = request.file
    if (!file || !await runView(runId)) return void response.status(400).json({ error: 'Record the reading first.' })
    try {
      if (config.mode === 'sample') return void response.status(400).json({ error: NEEDS_KEY })
      if (!isUsableClip(file.path)) return void response.status(400).json({ error: "That recording couldn't be used. Try again." })
      response.json(await proposeFromVoice(runId, file.path))
    } catch (error) { next(error) } finally { await dropFile(file) }
  })

  app.post('/api/staff/runs/:id/sample-voice', requireStaff, async (request, response, next) => {
    const runId = idParam(request)
    if (!await runView(runId)) return void response.status(404).json({ error: 'Check not found.' })
    try { response.json(await proposeFromVoice(runId, path.join(samples, 'sample-fridge.wav'))) } catch (error) { next(error) }
  })

  app.post('/api/staff/runs/:id/photo', requireStaff, takePhoto, async (request, response, next) => {
    const runId = idParam(request)
    const file = request.file
    if (!file || !await runView(runId)) return void response.status(400).json({ error: 'Add a photo of the thermometer.' })
    if (config.mode === 'sample') {
      await dropFile(file)
      return void response.status(400).json({ error: NEEDS_KEY })
    }
    try { response.json(await proposeFromPhoto(runId, Number(request.body?.itemId), file.filename, file.originalname)) } catch (error) { next(error) }
  })

  app.post('/api/staff/runs/:id/sample-photo', requireStaff, async (request, response, next) => {
    const runId = idParam(request)
    if (!await runView(runId)) return void response.status(404).json({ error: 'Check not found.' })
    try { response.json(await proposeFromPhoto(runId, Number(request.body?.itemId), await copySample('sample-thermometer.png'), 'sample-thermometer.png')) } catch (error) { next(error) }
  })

  app.post('/api/staff/reports', requireStaff, takeAudio, async (request, response, next) => {
    const file = request.file
    if (file && config.mode === 'sample') {
      await dropFile(file)
      return void response.status(400).json({ error: NEEDS_KEY })
    }
    try {
      if (!file) {
        const text = String(request.body?.text ?? '').trim().slice(0, 2000)
        if (!text) return void response.status(400).json({ error: 'Record your report or type it.' })
        return void response.status(201).json(await fileReport({ text }))
      }
      if (!isUsableClip(file.path)) {
        await dropFile(file)
        return void response.status(400).json({ error: "That recording couldn't be used. Try again." })
      }
      const text = await transcribeReport(file.path)
      if (!text) {
        await dropFile(file)
        return void response.status(400).json({ error: "We couldn't hear any words. Try again, closer to the phone." })
      }
      response.status(201).json(await fileReport({ text, audioFile: file.filename }))
    } catch (error) { next(error) }
  })

  /** Power, water and gas skip the model, so the owner hears at once and the card opens straight away. */
  app.post('/api/staff/reports/quick', requireStaff, async (request, response) => {
    const report = await quickReport(String(request.body?.kind ?? ''))
    if (!report) return void response.status(400).json({ error: 'Choose what happened.' })
    response.status(201).json(report)
  })

  app.post('/api/staff/reports/sample', requireStaff, async (_request, response, next) => {
    try {
      const file = await copySample('sample-report.wav')
      const text = await transcribeReport(await localFile(file))
      response.status(201).json(await fileReport({ text, audioFile: file }))
    } catch (error) { next(error) }
  })

  const staffOrder = async (orderId: number) => {
    const order = await get(`SELECT o.id, o.delivery_date AS deliveryDate, s.name AS supplier, d.status, d.stored_at AS storedAt, d.photo_file AS photo, d.note, d.received_by AS receivedBy, d.checked_at AS arrivedAt FROM orders o
                       JOIN suppliers s ON s.id = o.supplier_id JOIN deliveries d ON d.order_id = o.id WHERE o.id = ?`, orderId)
    if (!order) return null
    const lines = await all(`SELECT ol.item_id AS itemId, i.name AS item, i.base_unit AS unit, i.case_qty AS packSize, ol.qty_milli / 1000.0 AS expected,
                         dl.received_milli / 1000.0 AS received, dl.issue
                       FROM order_lines ol JOIN items i ON i.id = ol.item_id
                       LEFT JOIN delivery_lines dl ON dl.delivery_id = (SELECT id FROM deliveries WHERE order_id = ol.order_id) AND dl.item_id = ol.item_id
                       WHERE ol.order_id = ? ORDER BY ol.id`, orderId)
    return { ...order, lines, media: await deliveryMedia(orderId) }
  }

  app.get('/api/staff/recipes', requireStaff, async (_request, response) => response.json(await staffRecipes()))
  app.get('/api/staff/recipe-photo/:name', requireStaff, async (request, response) => {
    const name = String(request.params.name)
    if (!/^[0-9a-f-]{36}\.[a-z]+$/.test(name) || !await get('SELECT 1 AS used FROM dishes WHERE photo_file = ?', name)) return void response.status(404).end()
    await sendStored(request, response, name)
  })

  app.get('/api/staff/deliveries', requireStaff, async (_request, response) => {
    const orders = await all(`SELECT o.id FROM orders o JOIN deliveries d ON d.order_id = o.id ORDER BY d.status = 'done', o.delivery_date DESC NULLS LAST, o.id DESC LIMIT 100`)
    response.json(await Promise.all(orders.map((order) => staffOrder(Number(order.id)))))
  })

  app.get('/api/staff/deliveries/:id', requireStaff, async (request, response) => {
    const order = await staffOrder(idParam(request))
    if (!order) return void response.status(404).json({ error: 'Delivery not found.' })
    response.json(order)
  })

  const applyNote = async (orderId: number, file: string, original: string) => {
    await run('UPDATE deliveries SET photo_file = ? WHERE order_id = ?', file, orderId)
    const delivery = (await get('SELECT id FROM deliveries WHERE order_id = ?', orderId))!
    const note = await readDeliveryNote(orderId, file, original)
    for (const line of note.lines) {
      if (line.item_id === null || line.quantity_received === null) continue
      if (!await get('SELECT 1 AS ok FROM order_lines WHERE order_id = ? AND item_id = ?', orderId, line.item_id)) continue
      await run(`INSERT INTO delivery_lines (delivery_id, item_id, received_milli) VALUES (?, ?, ?)
           ON CONFLICT (delivery_id, item_id) DO UPDATE SET received_milli = excluded.received_milli`,
        delivery.id, line.item_id, Math.round(line.quantity_received * 1000))
    }
    return { ...await staffOrder(orderId), notes: note.handwritten_notes }
  }

  app.post('/api/staff/deliveries/:id/photo', requireStaff, takePhoto, async (request, response, next) => {
    const orderId = idParam(request)
    const file = request.file
    if (!file) return void response.status(400).json({ error: 'Add a JPG, PNG, WEBP or PDF.' })
    if (config.mode === 'sample') {
      await dropFile(file)
      return void response.status(400).json({ error: 'Add MODEL_API_KEY to read a real delivery note. Sample mode reads the sample note.' })
    }
    try { response.json(await applyNote(orderId, file.filename, file.originalname)) } catch (error) { next(error) }
  })

  app.post('/api/staff/deliveries/:id/sample-photo', requireStaff, async (request, response, next) => {
    try { response.json(await applyNote(idParam(request), await copySample('sample-delivery-note.png'), 'sample-delivery-note.png')) } catch (error) { next(error) }
  })

  app.post('/api/staff/deliveries/:id/issue-photo', requireStaff, takePhoto, async (request, response) => {
    if (!request.file) return void response.status(400).json({ error: 'Add a photo.' })
    await run('UPDATE deliveries SET issue_photo = ? WHERE order_id = ?', request.file.filename, idParam(request))
    response.json({ ok: true })
  })

  app.post('/api/staff/deliveries/:id/counts', requireStaff, async (request, response) => {
    const orderId = idParam(request)
    const delivery = await get('SELECT id FROM deliveries WHERE order_id = ?', orderId)
    if (!delivery) return void response.status(404).json({ error: 'Delivery not found.' })
    const lines = request.body?.lines
    if (!Array.isArray(lines) || lines.some((line) => !(Number(line.received) >= 0))) {
      return void response.status(400).json({ error: 'Enter a count for every item.' })
    }
    const expected = async (itemId: number) => Number((await get('SELECT qty_milli FROM order_lines WHERE order_id = ? AND item_id = ?', orderId, itemId))?.qty_milli ?? 0)
    for (const line of lines) {
      const received = Math.round(Number(line.received) * 1000)
      const issue = ['damaged', 'wrong', 'missing'].includes(line.issue) ? line.issue : received < await expected(Number(line.itemId)) ? 'short' : null
      await run(`INSERT INTO delivery_lines (delivery_id, item_id, received_milli, issue) VALUES (?, ?, ?, ?)
           ON CONFLICT (delivery_id, item_id) DO UPDATE SET received_milli = excluded.received_milli, issue = excluded.issue`,
        delivery.id, Number(line.itemId), received, issue)
    }
    const stored = String(request.body?.stored ?? '').trim().slice(0, 120) || null
    const note = String(request.body?.note ?? '').trim().slice(0, 500) || null
    const receivedBy = String(request.body?.receivedBy ?? '').trim().slice(0, 60) || null
    const arrivedOn = String(request.body?.arrivedOn ?? '')
    const now = nowIso()
    // A delivery written up the next day keeps the day it really came.
    const arrived = /^\d{4}-\d{2}-\d{2}$/.test(arrivedOn) && arrivedOn !== now.slice(0, 10) ? `${arrivedOn}T12:00:00.000Z` : now
    await run(`UPDATE deliveries SET status = 'done', checked_at = ?, stored_at = ?, note = ?, received_by = ? WHERE id = ?`, arrived, stored, note, receivedBy, delivery.id)
    await reportDeliveryProblems(orderId)
    await run(`UPDATE tasks SET done = 1 WHERE title LIKE 'Check in the %' AND call_id = (SELECT call_id FROM orders WHERE id = ?)`, orderId)
    response.json(await staffOrder(orderId))
  })

  /** Sample mode only: clears the demo so it can run again. */
  app.post('/api/sample/reset', requireOwner, async (_request, response) => {
    if (config.mode !== 'sample') return void response.status(403).json({ error: 'Reset is only for sample mode.' })
    try {
      await resetSample()
    } catch (error) {
      if (error instanceof RefusedWipe) return void response.status(403).json({ error: error.message })
      throw error
    }
    // Under the same lock, because another instance can be clearing these very rows.
    await locked('seed', tick)
    response.json({ ok: true })
  })

  /** Sample mode only: moves the demo clock, so the one-day story can reach closing time. */
  app.post('/api/sample/clock', requireOwner, async (request, response) => {
    if (config.mode !== 'sample') return void response.status(403).json({ error: 'The demo clock is only for sample mode.' })
    const time = String(request.body?.time ?? '')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return void response.status(400).json({ error: 'Choose a time.' })
    await jumpTo(time)
    await tick()
    response.json({ ok: true })
  })

  // Vercel serves dist itself, so on a Mac this is the only place the screens come from.
  const built = path.resolve('dist')
  if (!config.hosted && fs.existsSync(built)) {
    app.use(express.static(built))
    app.get(/^(?!\/api|\/ws).*/, (_request, response) => response.sendFile(path.join(built, 'index.html')))
  }

  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error)
    const tooBig = error instanceof multer.MulterError
    if (!response.headersSent) {
      response.status(tooBig ? 400 : 502).json({ error: tooBig ? 'That file is too large.' : "That didn't work. Try again." })
    }
  })

  const server = http.createServer(app)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

  const refuse = (socket: Duplex) => {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = url.pathname.match(/^\/ws\/call\/(\d+)$/)
    const origin = request.headers.origin
    // Vercel keeps the public address in its own header, and a browser can't set that on a socket.
    const sameSite = !origin || [request.headers.host, request.headers['x-forwarded-host']].includes(new URL(origin).host)
    if (!match || roleOf(request) !== 'owner' || !(sameSite || !config.production)) return refuse(socket)
    void (async () => {
      await startUp()
      await syncDemoClock()
      const call = await get('SELECT id, status, source FROM calls WHERE id = ?', Number(match[1]))
      // A call that's already live is a browser coming back, on this instance or any other.
      if (!call || !['ready', 'live'].includes(String(call.status))) return refuse(socket)
      sockets.handleUpgrade(request, socket, head, (client) => handleCall(client, Number(call.id), call.source === 'sample'))
    })().catch((error) => {
      console.error('call socket:', (error as Error).message)
      refuse(socket)
    })
  })

  return server
}

/** The whole app, ready to use. The hosted entry point uses createApp, so a plain import does no database work. */
export async function buildApp() {
  const server = createApp()
  await startUp()
  return server
}

/**
 * The only thing a public tunnel reaches. It listens on its own port with no other routes,
 * so opening WhatsApp to the internet doesn't open the owner's screens.
 */
export function startWebhookListener() {
  const app = express()
  app.disable('x-powered-by')
  app.use(whatsappWebhook())
  const server = http.createServer(app)
  server.on('error', (error) => console.error('WhatsApp webhook:', error.message))
  server.listen(config.whatsapp.webhookPort, '127.0.0.1')
  return server
}

async function handleCall(client: WebSocket, callId: number, replay: boolean) {
  const emit = (event: CallEvent) => { if (client.readyState === client.OPEN) client.send(JSON.stringify(event)) }
  const opening: Promise<LiveCall> = LiveCall.open(callId, emit)
  let timer: NodeJS.Timeout | undefined
  let ending = false

  const stop = (work: (live: LiveCall) => Promise<unknown>) => {
    clearInterval(timer)
    if (ending) return
    ending = true
    void opening.then(work).catch((error) => {
      console.error(`call ${callId} end:`, error)
      emit({ type: 'warning', message: 'The call could not be written up. Open it again to retry.' })
    })
  }

  opening.then(async (live) => {
    if (!replay) return
    // The sample call goes through exactly the same path as a microphone, at real speed.
    await live.listening
    const pcm = fs.readFileSync(path.join(samples, 'sample-call.wav')).subarray(44)
    const speed = Number(process.env.REPLAY_SPEED ?? 1)
    const step = 4800
    let offset = live.position
    timer = setInterval(() => {
      if (offset >= pcm.length) return stop((call) => call.end())
      live.audio(Buffer.from(pcm.subarray(offset, offset + step)))
      offset += step
    }, 100 / speed)
  }).catch((error) => {
    console.error(`call ${callId} start:`, (error as Error).message)
    client.close()
  })

  // Each goes on the back of the one before, so audio and commands keep the order they came in.
  let line: Promise<unknown> = opening
  client.on('message', (data, isBinary) => {
    line = line.then(async () => {
      const live = await opening
      if (isBinary) return replay ? undefined : live.audio(data as Buffer)
      const command = JSON.parse(data.toString())
      if (command.type === 'from') await live.audioFrom(Number(command.offset))
      if (command.type === 'end') stop((call) => call.end())
      if (command.type === 'handover') stop((call) => call.handOver().then(() => client.close()))
    }).catch(() => undefined)
  })
  // No warning that it's closing is ever guaranteed, so nothing important waits for this.
  client.on('close', () => stop((call) => call.dropped()))
}
