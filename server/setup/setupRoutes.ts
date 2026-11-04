import { acceptInvoice, orderMessage, sendOrder } from '../operations/supplierOrders.ts'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Express, NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { config, saveToEnv } from '../core/config.ts'
import { all, get, insert, nowIso, run } from '../core/db.ts'
import { requireOwner, requireStaff, roleOf } from '../core/auth.ts'
import { allowedExtension } from './documents.ts'
import { sendStored, uploadDir, writeFile } from '../core/files.ts'
import { dropFile, takeFields, takeFile, VIDEO_EXTENSIONS } from '../core/uploads.ts'
import { checkFor, deliveryMedia } from '../operations/checks.ts'
import { clearSampleData, RefusedWipe } from '../core/seed.ts'
import { runView } from '../operations/checklists.ts'
import { checkProof } from '../money/proof.ts'
import { countInVideo, phraseFor } from '../ai/countVideo.ts'
import { samFind } from '../ai/meta.ts'
import { checkInbox, disconnectGmail, finishGmailLogin, gmailConfigured, gmailConnected, gmailLoginUrl, GmailError, sendMail } from '../integrations/gmail.ts'
import { imageAllowed, ingestAllowed, MAX_FILE_BYTES, menuAllowed, readIngest, readMenu, readRecipeFile, recipeAllowed, saveIngest } from './ingest.ts'
import type { IngestKind } from '../ai/prompts.ts'
import { deleteDish, deleteSupplier, hasSampleData, listChecklists, changeItemUnit, listDishes, listSuppliers, restaurantName, retireChecklist, saveChecklist, saveDish, setDishPortions, saveRestaurant, saveSupplier, SetupError } from './setup.ts'
import { estimateDish } from './estimate.ts'
import { checksFromPhoto } from './checklistPhoto.ts'
import { orderText, setItemSource, setWeeklyPortions, shoppingList, usePurchaseEstimate } from '../operations/shopping.ts'
import { estimateDensities, saveStockCount, setDensity, stockView } from '../operations/stock.ts'
import { changeStaff, whatsappReady } from '../integrations/whatsapp.ts'
import { crisisCard, crisisCards, isCrisisPhoto, resetCrisisCard, saveCrisisCard } from '../operations/crisisCards.ts'
import { saveSetting, setting } from '../core/db.ts'
import { phoneReady } from '../integrations/phone.ts'
import { createInvite, waitingInvites } from '../operations/invites.ts'
import { isLang } from '../../shared/lang.ts'

const fileName = (_request: unknown, file: Express.Multer.File, done: (error: Error | null, name: string) => void) =>
  done(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)

const LARGEST_LIVE_FRAME = 700000
const LIVE_CONFIDENCE = 0.5

const documents = multer({
  storage: multer.diskStorage({ destination: (_request, _file, done) => done(null, uploadDir()), filename: fileName }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, done) => done(null, allowedExtension(file.originalname)),
})

/** Pictures are shrunk in the browser first. A video is kept as it is, so the owner can watch it. */
const evidence = multer({
  storage: multer.diskStorage({ destination: (_request, _file, done) => done(null, uploadDir()), filename: fileName }),
  limits: { fileSize: 120 * 1024 * 1024, files: 5 },
  fileFilter: (_request, file, done) => done(null, evidenceAllowed(file.fieldname, file.originalname)),
})

/** What the import screen and the recipe form take. Each keeps the extension, because that's how a file is read. */
const stored = (allowed: (field: string, name: string) => boolean, files: number) => multer({
  storage: multer.diskStorage({ destination: (_request, _file, done) => done(null, uploadDir()), filename: fileName }),
  limits: { fileSize: MAX_FILE_BYTES, files },
  fileFilter: (_request, file, done) => done(null, allowed(file.fieldname, file.originalname)),
})

const recipeField = (field: string, name: string) => (field === 'photo' ? imageAllowed(name) : recipeAllowed(name))
const takeIngest = takeFile(stored((_field, name) => ingestAllowed(name), 1), 'file', { maxBytes: MAX_FILE_BYTES, allowed: (_field, name) => ingestAllowed(name) })
const takeMenu = takeFile(stored((_field, name) => menuAllowed(name), 1), 'file', { maxBytes: MAX_FILE_BYTES, allowed: (_field, name) => menuAllowed(name) })
const takeRecipe = takeFile(stored((_field, name) => recipeAllowed(name), 1), 'file', { maxBytes: MAX_FILE_BYTES, allowed: (_field, name) => recipeAllowed(name) })
const takeDishFiles = takeFields(stored(recipeField, 2), [{ name: 'recipe', maxCount: 1 }, { name: 'photo', maxCount: 1 }], { maxBytes: MAX_FILE_BYTES, allowed: recipeField })

const evidenceAllowed = (field: string, name: string) => (field === 'video' ? VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) : allowedExtension(name))
const EVIDENCE_FIELDS = [{ name: 'frames', maxCount: 4 }, { name: 'video', maxCount: 1 }]
const takeDocument = takeFile(documents, 'file', { maxBytes: 15 * 1024 * 1024, allowed: (_field, name) => allowedExtension(name) })
const takeEvidence = takeFields(evidence, EVIDENCE_FIELDS, { maxBytes: 120 * 1024 * 1024, allowed: evidenceAllowed })

/** Turns a setup rule into a plain message rather than a server error. */
const guarded = (work: (request: Request, response: Response) => unknown) => async (request: Request, response: Response, next: NextFunction) => {
  try { await work(request, response) } catch (error) {
    if (error instanceof RefusedWipe) return void response.status(403).json({ error: error.message })
    // error is filled in, so a page from before this change still names the ingredient. New pages translate the sentence.
    if (error instanceof SetupError) return void response.status(400).json({ error: error.message, sentence: error.sentence, values: error.values })
    if (error instanceof GmailError) return void response.status(400).json({ error: error.message })
    next(error)
  }
}

/** An upload that's only being read is gone before the owner hears back. */
async function droppingAfter<T>(file: Express.Multer.File, work: () => Promise<T>) {
  try { return await work() } finally { await dropFile(file) }
}

const id = (request: Request) => Number(request.params.id)
const money = (pence: unknown) => `£${(Number(pence) / 100).toFixed(2)}`

async function orderEmail(orderId: number) {
  const order = await get(`SELECT o.id, o.delivery_date, o.emailed_at, s.name AS supplier, s.contact, s.email FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`, orderId)
  if (!order) return null
  const lines = await all(`SELECT i.name, i.base_unit, ol.qty_milli, ol.agreed_price_p FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ? ORDER BY ol.id`, orderId)
  const restaurant = await restaurantName()
  const when = order.delivery_date ? new Date(`${order.delivery_date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : null
  const body = [
    `Hi ${order.contact ?? order.supplier},`, '',
    `Thanks for the call. Here is what we agreed${restaurant ? ` for ${restaurant}` : ''}:`, '',
    ...lines.map((line) => `- ${Number(line.qty_milli) / 1000} ${line.base_unit === 'each' ? '' : `${line.base_unit} `}${line.name}${line.agreed_price_p === null ? '' : ` at ${money(line.agreed_price_p)} per ${line.base_unit === 'each' ? 'item' : line.base_unit}`}`), '',
    ...(when ? [`Delivery on ${when}.`, ''] : []),
    'Let me know if anything here is wrong.', '', 'Thanks,', restaurant || 'Stockpot',
  ].join('\n')
  return { to: (order.email as string | null) ?? '', subject: `Order confirmation${restaurant ? ` from ${restaurant}` : ''}`, body, sentAt: order.emailed_at ?? null, gmail: await gmailConnected() }
}

export function setupRoutes(app: Express) {
  app.get('/api/setup', requireOwner, async (_request, response) => {
    response.json({
      restaurant: await restaurantName(), sampleData: await hasSampleData(), onboarded: !!await setting('onboarded'), whatsapp: whatsappReady(), phone: phoneReady(),
      people: config.whatsapp.staff.map(({ name, language }) => ({ name, language: language ?? null })), waiting: await waitingInvites(),
    })
  })
  app.post('/api/setup/onboarded', requireOwner, async (_request, response) => { await saveSetting('onboarded', '1'); response.json({ ok: true }) })
  // Once the restaurant has a name, onboarding never starts over. Anything skipped stays on Home's setup list.
  app.post('/api/setup/restaurant', requireOwner, guarded(async (request, response) => {
    await saveRestaurant(request.body?.name)
    if (await restaurantName()) await saveSetting('onboarded', '1')
    response.json({ ok: true })
  }))
  app.post('/api/setup/clear-sample', requireOwner, guarded(async (_request, response) => { await clearSampleData(); response.json({ ok: true }) }))

  app.get('/api/setup/suppliers', requireOwner, async (_request, response) => response.json(await listSuppliers()))
  app.post('/api/setup/suppliers', requireOwner, guarded(async (request, response) => response.status(201).json({ id: await saveSupplier(request.body ?? {}) })))
  app.put('/api/setup/suppliers/:id', requireOwner, guarded(async (request, response) => response.json({ id: await saveSupplier(request.body ?? {}, id(request)) })))
  app.delete('/api/setup/suppliers/:id', requireOwner, guarded(async (request, response) => { await deleteSupplier(id(request)); response.json({ ok: true }) }))

  app.get('/api/setup/dishes', requireOwner, async (_request, response) => response.json(await listDishes()))
  /** Staff and the owner both count stock. Only the owner gets the order figures, and neither route carries a price. */
  const stockFor = async (request: Request) => {
    const view = await stockView()
    if (roleOf(request) !== 'owner') return view
    const orders = new Map((await shoppingList()).items.map((item) => [item.id, item.order]))
    return { ...view, items: view.items.map((item) => ({ ...item, order: orders.get(item.id) ?? null })) }
  }
  app.get('/api/stock', requireStaff, guarded(async (request, response) => response.json(await stockFor(request))))
  app.post('/api/stock/estimate', requireStaff, guarded(async (request, response) => {
    await estimateDensities(Number(request.body?.itemId) || undefined)
    response.json(await stockFor(request))
  }))
  app.post('/api/stock/:id/count', requireStaff, guarded(async (request, response) => {
    await saveStockCount(id(request), request.body ?? {}, roleOf(request) as string)
    response.json(await stockFor(request))
  }))
  app.post('/api/stock/:id/density', requireOwner, guarded(async (request, response) => {
    await setDensity(id(request), request.body?.density)
    response.json(await stockFor(request))
  }))

  /** The weekly shopping list: recipes times portions a week, by supplier. Nothing here orders on its own. */
  app.get('/api/shopping', requireOwner, async (_request, response) => response.json(await shoppingList()))
  app.post('/api/shopping/portions/:id', requireOwner, guarded(async (request, response) => { await setWeeklyPortions(id(request), request.body?.portions); response.json(await shoppingList()) }))
  app.post('/api/shopping/portions-from-receipts', requireOwner, guarded(async (_request, response) => response.json(await usePurchaseEstimate())))
  app.post('/api/shopping/items/:id', requireOwner, guarded(async (request, response) => { await setItemSource(id(request), request.body ?? {}); response.json(await shoppingList()) }))
  app.get('/api/shopping/order/:id', requireOwner, guarded(async (request, response) => response.json({ ...await orderText(id(request)), gmail: await gmailConnected() })))
  app.get('/api/shopping/order/:id/whatsapp', requireOwner, guarded(async (request, response) => response.json(await orderMessage(id(request)))))
  app.post('/api/shopping/order/:id/whatsapp', requireOwner, guarded(async (request, response) => response.status(201).json({ orderId: await sendOrder(id(request), request.body ?? {}) })))
  app.post('/api/orders/:id/accept-invoice', requireOwner, guarded(async (request, response) => { await acceptInvoice(id(request)); response.json({ ok: true }) }))
  app.post('/api/shopping/order/:id/send', requireOwner, guarded(async (request, response) => {
    const { to, subject, body } = request.body ?? {}
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to ?? ''))) throw new SetupError('Add the supplier email address.')
    await sendMail({ to: String(to), subject: String(subject ?? '').slice(0, 200), body: String(body ?? '').slice(0, 5000) })
    response.json({ ok: true })
  }))
  app.post('/api/setup/items/unit', requireOwner, guarded(async (request, response) => { await changeItemUnit(String(request.body?.name ?? ''), String(request.body?.unit ?? '')); response.json({ ok: true }) }))
  app.post('/api/setup/dishes', requireOwner, guarded(async (request, response) => response.status(201).json({ id: await saveDish(request.body ?? {}) })))
  app.put('/api/setup/dishes/:id', requireOwner, guarded(async (request, response) => response.json({ id: await saveDish(request.body ?? {}, id(request)) })))
  app.delete('/api/setup/dishes/:id', requireOwner, guarded(async (request, response) => { await deleteDish(id(request)); response.json({ ok: true }) }))
  /** An estimate only: nothing is saved, so a real receipt price always takes over. */
  app.post('/api/setup/dishes/:id/portions', requireOwner, guarded(async (request, response) => { await setDishPortions(id(request), request.body?.portions); response.json({ ok: true }) }))
  app.post('/api/setup/dishes/estimate', requireOwner, guarded(async (request, response) => response.json(await estimateDish(request.body ?? {}))))
  app.post('/api/setup/menu/read', requireOwner, takeMenu, guarded(async (request, response) => {
    const file = request.file
    if (!file) throw new SetupError('Stockpot reads PDF, photo (JPG, PNG, WEBP), Word, text, CSV and Excel files. Save the menu as one of these and try again.')
    response.json(await droppingAfter(file, () => readMenu(file.filename, file.originalname)))
  }))

  /** Reads a recipe and saves nothing. The browser holds on to the files until the owner confirms, so a change of mind leaves no trace. */
  app.post('/api/setup/recipes/read', requireOwner, takeRecipe, guarded(async (request, response) => {
    const file = request.file
    if (!file) throw new SetupError('Stockpot reads recipes from PDF, photo (JPG, PNG, WEBP), Word and text files. Save the recipe as one of these and try again.')
    const dishId = Number(request.body?.dishId) || undefined
    response.json(await droppingAfter(file, () => readRecipeFile(file.filename, file.originalname, dishId)))
  }))

  /** Reads a saved dish's own file again. The answer is a set of changes to look at, not a change. */
  app.post('/api/setup/dishes/:id/read-again', requireOwner, guarded(async (request, response) => {
    const dish = await get('SELECT recipe_file, recipe_file_name FROM dishes WHERE id = ?', id(request))
    if (!dish?.recipe_file) throw new SetupError('Add a recipe file first.')
    response.json(await readRecipeFile(String(dish.recipe_file), String(dish.recipe_file_name ?? dish.recipe_file), id(request)))
  }))

  /** Runs once the owner has confirmed. The recipe file stays for the owner alone. Staff are served the photo, so that can only be a picture. */
  app.post('/api/setup/dishes/:id/files', requireOwner, takeDishFiles, guarded(async (request, response) => {
    const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>
    const [recipe, photo] = [files.recipe?.[0], files.photo?.[0]]
    if (!await get('SELECT id FROM dishes WHERE id = ?', id(request))) { await Promise.all([dropFile(recipe), dropFile(photo)]); throw new SetupError('That dish has gone.') }
    if (!recipe && !photo) throw new SetupError('Add a recipe file or a photo.')
    if (recipe) await run('UPDATE dishes SET recipe_file = ?, recipe_file_name = ? WHERE id = ?', recipe.filename, recipe.originalname.slice(0, 200), id(request))
    if (photo) await run('UPDATE dishes SET photo_file = ? WHERE id = ?', photo.filename, id(request))
    response.json({ recipeFile: recipe?.filename ?? null, photo: photo?.filename ?? null })
  }))

  /** A photo of a station or a prep list becomes checks in the form. Nothing is saved, and the photo is thrown away. */
  app.post('/api/setup/checklists/from-photo', requireOwner, takeDocument, guarded(async (request, response) => {
    const file = request.file
    if (!file) throw new SetupError('Add a JPG, PNG or WEBP.')
    response.json({ items: await droppingAfter(file, () => checksFromPhoto(file.filename, file.originalname)) })
  }))

  /** Reads one file into a preview. Nothing is saved, and the upload is thrown away afterwards. */
  app.post('/api/ingest/read', requireOwner, takeIngest, guarded(async (request, response) => {
    const file = request.file
    if (!file) throw new SetupError('Add a CSV, XLSX, PDF, Word, text or photo file.')
    const kind = String(request.body?.kind) as IngestKind
    const preview = await droppingAfter(file, async () => {
      if (!['sales', 'recipes', 'ingredients'].includes(kind)) throw new SetupError('Choose what this file holds.')
      return readIngest(kind, file.filename, file.originalname)
    })
    response.json({ file: file.originalname, ...preview })
  }))
  app.post('/api/ingest/save', requireOwner, guarded(async (request, response) => response.json(await saveIngest(request.body ?? {}))))

  // Open without a sign-in, like the cards themselves: the wrong moment to ask for a passcode.
  app.get('/api/crisis', async (_request, response) => response.json(await crisisCards()))
  app.get('/api/crisis/photo/:name', async (request, response) => {
    const name = String(request.params.name)
    if (!/^[0-9a-f-]{36}\.[a-z]+$/.test(name) || !await isCrisisPhoto(name)) return void response.status(404).end()
    await sendStored(request, response, name)
  })
  app.post('/api/crisis/photo', requireOwner, takeDocument, guarded((request, response) => {
    if (!request.file) throw new SetupError('Add a JPG, PNG or WEBP.')
    response.json({ photo: request.file.filename })
  }))
  const cardInput = (body: any) => {
    const title = String(body?.title ?? '').trim().slice(0, 120)
    const steps = (Array.isArray(body?.steps) ? body.steps : []).map((step: any) => ({ text: String(step?.text ?? '').trim().slice(0, 500), photo: /^[0-9a-f-]{36}\.[a-z]+$/.test(String(step?.photo)) ? String(step.photo) : null })).filter((step: any) => step.text)
    if (!title) throw new SetupError('Give the card a title.')
    if (!steps.length) throw new SetupError('Add at least one step.')
    return { title, number: String(body?.number ?? '').replace(/[^\d+ ]/g, '').trim().slice(0, 24), steps }
  }
  app.post('/api/crisis', requireOwner, guarded(async (request, response) => {
    const key = `own-${crypto.randomBytes(4).toString('hex')}`
    await saveCrisisCard(key, cardInput(request.body))
    response.status(201).json({ key })
  }))
  app.put('/api/crisis/:key', requireOwner, guarded(async (request, response) => {
    if (!await crisisCard(request.params.key)) throw new SetupError('That card has gone.')
    await saveCrisisCard(String(request.params.key), cardInput(request.body))
    response.json({ ok: true })
  }))
  app.delete('/api/crisis/:key', requireOwner, async (request, response) => {
    await resetCrisisCard(String(request.params.key))
    response.json({ ok: true })
  })

  app.get('/api/setup/checklists', requireOwner, async (_request, response) => {
    await saveSetting('checklists_seen', '1')
    response.json(await listChecklists())
  })
  app.post('/api/setup/checklists', requireOwner, guarded(async (request, response) => response.status(201).json({ id: await saveChecklist(request.body ?? {}) })))
  app.put('/api/setup/checklists/:id', requireOwner, guarded(async (request, response) => response.json({ id: await saveChecklist(request.body ?? {}, id(request)) })))
  app.delete('/api/setup/checklists/:id', requireOwner, guarded(async (request, response) => { await retireChecklist(id(request)); response.json({ ok: true }) }))

  /** Only these can be written, and nothing saved here is ever sent back. */
  const SAVABLE = ['MODEL_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_OWNER_NUMBER', 'WHATSAPP_BUSINESS_NUMBER', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'OWNER_PHONE']
  app.post('/api/connections/save', requireOwner, guarded((request, response) => {
    const values = Object.fromEntries(Object.entries(request.body ?? {}).filter(([key, value]) => SAVABLE.includes(key) && typeof value === 'string' && value.trim())) as Record<string, string>
    if (!Object.keys(values).length) throw new SetupError('Fill in at least one box.')
    if (config.hosted) throw new SetupError('On the hosted site, add these in the Vercel project settings.')
    if (config.production && !config.ownerPasscode) throw new SetupError('Set an owner passcode before saving keys on a public server.')
    saveToEnv(values)
    response.json({ ok: true, restart: 'MODEL_API_KEY' in values })
  }))

  app.post('/api/team/invites', requireOwner, guarded(async (request, response) => {
    const name = String(request.body?.name ?? '').replace(/[:,]/g, ' ').trim().slice(0, 60)
    if (!name) throw new SetupError('Add their name.')
    response.status(201).json(await createInvite(name, isLang(request.body?.language) ? request.body.language : null))
  }))
  app.delete('/api/team/invites/:code', requireOwner, async (request, response) => {
    await run('DELETE FROM invites WHERE code = ? AND used_at IS NULL', request.params.code)
    response.json({ ok: true })
  })

  app.post('/api/team/people', requireOwner, guarded(async (request, response) => {
    const name = String(request.body?.name ?? '').replace(/[:,]/g, ' ').trim().slice(0, 60)
    const number = String(request.body?.number ?? '').replace(/[^\d]/g, '')
    const language = isLang(request.body?.language) ? request.body.language : null
    if (!name) throw new SetupError('Add their name.')
    if (number.length < 8) throw new SetupError('Add their WhatsApp number with the country code.')
    if (config.whatsapp.staff.some((person) => person.name.toLowerCase() === name.toLowerCase())) throw new SetupError('You already have someone with that name.')
    await changeStaff((people) => [...people, { name, number, language }])
    response.status(201).json({ ok: true })
  }))
  app.delete('/api/team/people/:name', requireOwner, guarded(async (request, response) => {
    await changeStaff((people) => people.filter((person) => person.name !== request.params.name))
    response.json({ ok: true })
  }))

  const redirectUri = (request: Request) => `${request.protocol}://${request.get('host')}/api/google/callback`
  app.get('/api/google/login', requireOwner, async (request, response) => {
    if (!gmailConfigured()) return void response.redirect('/#/connections')
    response.redirect(await gmailLoginUrl(redirectUri(request)))
  })
  app.get('/api/google/callback', requireOwner, async (request, response) => {
    try {
      await finishGmailLogin(String(request.query.code ?? ''), String(request.query.state ?? ''), redirectUri(request))
      response.redirect('/#/connections')
    } catch (error) {
      console.error('gmail login:', (error as Error).message)
      response.redirect('/#/connections?gmail=failed')
    }
  })
  app.post('/api/google/disconnect', requireOwner, async (_request, response) => { await disconnectGmail(); response.json({ ok: true }) })
  app.post('/api/google/check', requireOwner, guarded(async (_request, response) => response.json(await checkInbox())))

  app.get('/api/orders/:id/email', requireOwner, async (request, response) => {
    const email = await orderEmail(id(request))
    if (!email) return void response.status(404).json({ error: 'Order not found.' })
    response.json(email)
  })
  app.post('/api/orders/:id/email', requireOwner, guarded(async (request, response) => {
    const { to, subject, body, sent } = request.body ?? {}
    // "sent" means the owner sent it from their own email app, so there is nothing more to do here.
    if (!sent) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to ?? ''))) throw new SetupError('Add the supplier email address.')
      await sendMail({ to: String(to), subject: String(subject ?? '').slice(0, 200), body: String(body ?? '').slice(0, 5000) })
    }
    await run('UPDATE orders SET emailed_at = ? WHERE id = ?', nowIso(), id(request))
    response.json({ ok: true })
  }))

  app.post('/api/checks/:id/email', requireOwner, guarded(async (request, response) => {
    const check = await checkFor(id(request)) as any
    if (!check?.credit) throw new SetupError('Draft the credit request first.')
    const to = (await get('SELECT s.email FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?', id(request)))?.email
    if (!to) throw new SetupError('Add the supplier email address in Settings.')
    await sendMail({ to: String(to), subject: String(check.credit.subject), body: String(check.credit.body) })
    response.json({ ok: true })
  }))

  app.post('/api/staff/runs/:id/proof', requireStaff, takeEvidence, guarded(async (request, response) => {
    const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>
    const frames = (files.frames ?? []).map((file) => file.filename)
    if (!frames.length || !await runView(id(request))) throw new SetupError('Add a photo or a video.')
    const checked = await checkProof({ runId: id(request), itemId: Number(request.body?.itemId), frames, seconds: Number(request.body?.seconds) || 0, videoFile: files.video?.[0]?.filename ?? null })
    if (!checked) throw new SetupError('That check is not on this list.')
    response.json(checked)
  }))

  /** Anyone taking a delivery in can add pictures, before or after it's checked in. */
  app.post('/api/staff/deliveries/:id/media', requireStaff, takeEvidence, guarded(async (request, response) => {
    const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>
    if (!files.frames?.[0] || !await get('SELECT id FROM orders WHERE id = ?', id(request))) throw new SetupError('Add a photo or a video.')
    await insert('INSERT INTO delivery_media (order_id, file, video_file, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
      id(request), files.frames[0].filename, files.video?.[0]?.filename ?? null, String(request.body?.addedBy ?? '').trim().slice(0, 60) || null, nowIso())
    response.status(201).json({ media: await deliveryMedia(id(request)) })
  }))

  /** Film the delivery and SAM counts what it can tell apart. The worker checks it before using it. */
  const counted = async (request: Request, response: Response, frame: string, video: string) => {
    const orderId = id(request)
    const line = await get(`SELECT ol.item_id, i.name FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ? AND ol.item_id = ?`, orderId, Number(request.body?.itemId))
    if (!line) throw new SetupError('Delivery not found.')
    const phrase = phraseFor(String(request.body?.what ?? ''), String(line.name))
    const result = await countInVideo(video, phrase, Number(request.body?.seconds) || 0).catch((error) => {
      console.error('sam count:', (error as Error).message)
      throw new SetupError("That video couldn't be counted. Count by hand.")
    })
    if (!result) throw new SetupError('Stockpot can only count from an MP4 or MOV video.')
    await insert('INSERT INTO delivery_media (order_id, file, video_file, added_by, item_id, counted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      orderId, frame, video, String(request.body?.addedBy ?? '').trim().slice(0, 60) || null, line.item_id, result.count, nowIso())
    response.status(201).json({ ...result, video, media: await deliveryMedia(orderId) })
  }

  /** One frame from the live camera. It's small, and nothing is kept. */
  app.post('/api/staff/live-find', requireStaff, guarded(async (request, response) => {
    const image = String(request.body?.image ?? '')
    const phrase = phraseFor(String(request.body?.what ?? ''), String(request.body?.item ?? ''))
    if (!phrase || !image.startsWith('data:image/jpeg;base64,') || image.length > LARGEST_LIVE_FRAME) throw new SetupError('Add a photo or a video.')
    response.json({ boxes: (await samFind(image, phrase)).filter((box) => (box.c ?? 1) >= LIVE_CONFIDENCE).slice(0, 30) })
  }))

  app.post('/api/staff/deliveries/:id/count', requireStaff, takeEvidence, guarded(async (request, response) => {
    const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>
    if (!files.frames?.[0] || !files.video?.[0]) throw new SetupError('Add a photo or a video.')
    await counted(request, response, files.frames[0].filename, files.video[0].filename)
  }))

  app.post('/api/staff/deliveries/:id/count-sample', requireStaff, guarded(async (request, response) => {
    if (config.mode !== 'sample') throw new SetupError('This is only for sample mode.')
    const name = (ending: string) => `${crypto.randomUUID()}${ending}`
    const [still, clip] = [name('.png'), name('.mp4')]
    await writeFile(still, fs.readFileSync(path.resolve('public/samples/sample-delivery-note.png')))
    await writeFile(clip, fs.readFileSync(path.resolve('public/samples/sample-delivery.mp4')))
    await counted(request, response, still, clip)
  }))

  app.get('/api/staff/delivery-media/:name', requireStaff, async (request, response) => {
    const name = String(request.params.name)
    if (!await get('SELECT 1 AS used FROM delivery_media WHERE file = ? OR video_file = ?', name, name)) return void response.status(404).end()
    await sendStored(request, response, path.basename(name))
  })

  app.post('/api/staff/reports/:id/media', requireStaff, takeEvidence, guarded(async (request, response) => {
    const files = (request.files ?? {}) as Record<string, Express.Multer.File[]>
    await run('UPDATE staff_reports SET photo_file = COALESCE(?, photo_file), video_file = COALESCE(?, video_file) WHERE id = ?', files.frames?.[0]?.filename ?? null, files.video?.[0]?.filename ?? null, id(request))
    response.json({ ok: true })
  }))
}
