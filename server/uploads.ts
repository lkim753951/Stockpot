import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Express as App, NextFunction, Request, RequestHandler, Response } from 'express'
import multer from 'multer'
import { requireStaff, roleOf } from './auth.ts'
import { config } from './config.ts'
import { get, nowIso, run } from './db.ts'
import { allowedExtension } from './documents.ts'
import { contentTypeOf, fileExists, localFile, removeFile, saveFile, signedUploadUrl, storageReady, uploadDir } from './files.ts'

/**
 * Vercel refuses a request body over 4.5 MB. So a big file goes straight from the browser to Storage,
 * and the form then carries only where it went. Each route reads the same file object either way.
 */

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.3gp'])
const LARGEST_UPLOAD = 120 * 1024 * 1024
/** The app's own limit. Supabase fixes its signed links at two hours, so this ticket is what really runs out. */
const TICKET_LIFE_MS = 15 * 60 * 1000

const uploadable = (name: string) => allowedExtension(name) || VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) || ['.wav', '.csv'].includes(path.extname(name).toLowerCase())

/** One route: the browser asks where to put a big file, and gets a link to that one new file. */
export function uploadRoutes(app: App) {
  app.post('/api/uploads/sign', requireStaff, async (request, response) => {
    const name = String(request.body?.name ?? '')
    const size = Number(request.body?.size)
    // With no Storage, or in the open sample, the file goes in the form as usual.
    if (!storageReady() || config.mode === 'sample') return void response.json({ direct: false })
    if (!uploadable(name)) return void response.status(400).json({ error: 'Add a JPG, PNG, WEBP or PDF.' })
    if (!(size > 0 && size <= LARGEST_UPLOAD)) return void response.status(400).json({ error: 'That file is too large.' })
    const stored = `${crypto.randomUUID()}${path.extname(name).toLowerCase()}`
    await run('INSERT INTO uploads (name, role, created_at) VALUES (?, ?, ?)', stored, roleOf(request), nowIso())
    response.json({ direct: true, url: await signedUploadUrl(stored), path: stored, contentType: contentTypeOf(stored) })
  })
}

/**
 * A stored path only counts once, from the role it was issued to, and while its ticket is fresh.
 * Otherwise staff could name an invoice's file as their own photo and read it back through a staff route.
 */
async function takeTicket(name: string, role: string | null) {
  const taken = await run('UPDATE uploads SET used_at = ? WHERE name = ? AND role = ? AND used_at IS NULL AND created_at >= ?',
    nowIso(), name, role, new Date(Date.now() - TICKET_LIFE_MS).toISOString())
  return taken.changes > 0
}

interface Rules {
  maxBytes: number
  allowed?: (field: string, name: string) => boolean
}

type Saved = Express.Multer.File

function asFile(field: string, stored: string, original: string, size: number, full: string) {
  return { fieldname: field, originalname: original, filename: stored, path: full, destination: uploadDir(), size, mimetype: contentTypeOf(stored), encoding: '7bit' } as Saved
}

/** What came in the form itself goes on to Storage now, because the next request may land on another instance. */
async function writeThrough(request: Request) {
  const files = request.file ? [request.file] : Array.isArray(request.files) ? request.files : Object.values(request.files ?? {}).flat()
  await Promise.all(files.map((file) => saveFile(file.filename)))
}

/** What went straight to Storage, as the same file object multer gives. A video stays put: nothing here reads the whole of one. */
async function fromStorage(request: Request, rules: Rules) {
  let listed: Array<{ field?: unknown; path?: unknown; name?: unknown }> = []
  try { listed = JSON.parse(String(request.body?.storedFiles ?? '[]')) } catch { /* treated as nothing sent */ }
  const found: Saved[] = []
  for (const entry of Array.isArray(listed) ? listed : []) {
    const field = String(entry.field ?? '')
    const stored = String(entry.path ?? '')
    const original = String(entry.name ?? stored)
    if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/.test(stored)) continue
    if (rules.allowed && !rules.allowed(field, original)) continue
    if (!await takeTicket(stored, roleOf(request))) continue
    if (!await fileExists(stored)) continue
    const full = field === 'video' ? path.join(uploadDir(), stored) : await localFile(stored)
    const size = fs.existsSync(full) ? fs.statSync(full).size : 0
    if (size > rules.maxBytes) {
      await removeFile(stored)
      throw new multer.MulterError('LIMIT_FILE_SIZE', field)
    }
    found.push(asFile(field, stored, original, size, full))
  }
  return found
}

/** One handler from two steps: multer reads the form, then the file objects are filled in. */
const taking = (parse: RequestHandler, add: (request: Request, files: Saved[]) => void, rules: Rules): RequestHandler => (request: Request, response: Response, next: NextFunction) => {
  parse(request, response, async (problem?: unknown) => {
    if (problem) return next(problem)
    try {
      await writeThrough(request)
      const stored = await fromStorage(request, rules)
      if (stored.length) add(request, stored)
      next()
    } catch (error) { next(error) }
  })
}

export const takeFile = (parser: multer.Multer, field: string, rules: Rules) => taking(parser.single(field), (request, files) => {
  request.file = files.find((file) => file.fieldname === field) ?? request.file
}, rules)

export const takeFiles = (parser: multer.Multer, field: string, count: number, rules: Rules) => taking(parser.array(field, count), (request, files) => {
  request.files = [...(request.files as Saved[] ?? []), ...files.filter((file) => file.fieldname === field)].slice(0, count)
}, rules)

/** Keeps to the fields and counts the route allows, so a stored path can't bring in more than a form could. */
export const takeFields = (parser: multer.Multer, fields: multer.Field[], rules: Rules) => taking(parser.fields(fields), (request, files) => {
  const all = { ...(request.files as Record<string, Saved[]> ?? {}) }
  for (const { name, maxCount } of fields) {
    const more = files.filter((file) => file.fieldname === name)
    if (more.length) all[name] = [...(all[name] ?? []), ...more].slice(0, maxCount)
  }
  request.files = all
}, rules)

/** Throws away a file a route has finished with. */
export const dropFile = async (file: { filename: string } | undefined) => (file ? await removeFile(file.filename) : Promise.resolve())

/** Which of the files in storage staff may open. Invoices, delivery notes and recordings aren't on the list. */
export async function staffMayRead(name: string) {
  return !!await get(`SELECT 1 AS used FROM checklist_entries WHERE photo_file = ?
                      UNION SELECT 1 FROM proof_checks WHERE file = ? OR video_file = ?
                      UNION SELECT 1 FROM delivery_media WHERE file = ? OR video_file = ?`, name, name, name, name, name)
}

