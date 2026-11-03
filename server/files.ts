import fs from 'node:fs'
import path from 'node:path'
import type { Request, Response } from 'express'
import { config } from './config.ts'

/**
 * Where files live. With SUPABASE_URL and SUPABASE_SERVICE_KEY, a private Storage bucket holds the
 * real copy, and the local folder is a throwaway cache. Without them, the local folder is all there is.
 * The service key only ever goes in a header from here to Supabase. It is never logged or sent to a browser.
 */

export type Area = 'uploads' | 'calls' | 'backups'

/** Vercel's temp folder holds 512 MB and is shared with everything else the instance does. */
const CACHE_LIMIT_BYTES = 300 * 1024 * 1024

export const storageReady = () => !!(config.supabase.url && config.supabase.serviceKey)

export function areaDir(area: Area) {
  const folder = path.join(config.dataDir, area)
  fs.mkdirSync(folder, { recursive: true })
  return folder
}

export const uploadDir = () => areaDir('uploads')
export const callDir = () => areaDir('calls')

/** Only a plain file name reaches a path or an object key. */
const clean = (name: string) => path.basename(name)
const localPath = (name: string, area: Area) => path.join(areaDir(area), clean(name))
const objectKey = (name: string, area: Area) => `${area}/${clean(name)}`
const objectPath = (key: string) => key.split('/').map(encodeURIComponent).join('/')

/** Supabase's newer sb_secret_ keys aren't JWTs, so they travel in apikey alone. Older service_role keys need both. */
export const storageHeaders = (key: string): Record<string, string> => key.startsWith('sb_') ? { apikey: key } : { Authorization: `Bearer ${key}`, apikey: key }

async function storage(route: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 60000, ...rest } = init
  const { url, serviceKey } = config.supabase
  return fetch(`${url}/storage/v1${route}`, {
    ...rest,
    headers: { ...storageHeaders(serviceKey), ...rest.headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

const refused = (doing: string, response: { status: number }) => new Error(`Storage refused to ${doing}: ${response.status}`)

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.3gp': 'video/3gpp',
  '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
export const contentTypeOf = (name: string) => CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream'

async function put(key: string, bytes: Buffer) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await storage(`/object/${config.supabase.bucket}/${objectPath(key)}`, {
        method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': contentTypeOf(key), 'x-upsert': 'true' }, timeoutMs: 120000,
      })
      if (response.ok) return
      // A full bucket or a file over the plan's limit won't change by trying again.
      if (response.status < 500 || attempt >= 3) throw refused('save a file', response)
    } catch (error) {
      if (attempt >= 3 || !(error instanceof TypeError || (error as Error).name === 'TimeoutError')) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
  }
}

/** Saves a file already in the local folder. It's only safe to rely on once this has returned. */
export async function saveFile(name: string, area: Area = 'uploads') {
  if (storageReady()) await put(objectKey(name, area), fs.readFileSync(localPath(name, area)))
}

/** Writes bytes to the local folder and through to Storage. */
export async function writeFile(name: string, bytes: Uint8Array, area: Area = 'uploads') {
  fs.writeFileSync(localPath(name, area), bytes)
  await saveFile(name, area)
}

/** Clears the oldest cached files once the temp folder gets full. Every one of them can be fetched again. */
function trimCache(keep: string) {
  if (!storageReady()) return
  const files = (['uploads', 'calls'] as const).flatMap((area) => fs.readdirSync(areaDir(area)).map((name) => {
    const file = path.join(areaDir(area), name)
    const { size, atimeMs } = fs.statSync(file)
    return { file, size, atimeMs }
  })).sort((a, b) => a.atimeMs - b.atimeMs)
  let total = files.reduce((sum, row) => sum + row.size, 0)
  for (const { file, size } of files) {
    if (total <= CACHE_LIMIT_BYTES) return
    if (file === keep) continue
    fs.rmSync(file, { force: true })
    total -= size
  }
}

/**
 * The path of a file on this disk, fetching it first if this instance hasn't got it.
 * Use this before every read and every sendFile. A file that exists nowhere gives a path that isn't there.
 */
export async function localFile(name: string, area: Area = 'uploads') {
  const file = localPath(name, area)
  if (fs.existsSync(file) || !storageReady()) return file
  const response = await storage(`/object/${config.supabase.bucket}/${objectPath(objectKey(name, area))}`, { timeoutMs: 120000 })
  if (response.status === 400 || response.status === 404) return file
  if (!response.ok) throw refused('open a file', response)
  // Written to one side, then moved, so a half-finished download is never read as a whole file.
  const partial = `${file}.${process.pid}.${Date.now()}.part`
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()))
  fs.renameSync(partial, file)
  trimCache(file)
  return file
}

export async function fileExists(name: string, area: Area = 'uploads') {
  if (fs.existsSync(localPath(name, area))) return true
  if (!storageReady()) return false
  return (await storage(`/object/${config.supabase.bucket}/${objectPath(objectKey(name, area))}`, { method: 'HEAD' })).ok
}

export async function removeFile(name: string, area: Area = 'uploads') {
  fs.rmSync(localPath(name, area), { force: true })
  if (!storageReady()) return
  const response = await storage(`/object/${config.supabase.bucket}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [objectKey(name, area)] }),
  })
  if (!response.ok && response.status !== 404) console.error(refused('remove a file', response).message)
}

/** Renames a file on both sides, without sending the bytes again. */
export async function moveFile(from: string, fromArea: Area, to: string, toArea: Area) {
  if (fs.existsSync(localPath(from, fromArea))) fs.renameSync(localPath(from, fromArea), localPath(to, toArea))
  if (!storageReady()) return
  const response = await storage('/object/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: config.supabase.bucket, sourceKey: objectKey(from, fromArea), destinationKey: objectKey(to, toArea) }),
  })
  if (!response.ok) throw refused('move a file', response)
}

/** A link to one file that stops working soon after. It's the only way the bytes reach a browser or a model. */
export async function signedUrl(name: string, area: Area = 'uploads', seconds = 300) {
  const response = await storage(`/object/sign/${config.supabase.bucket}/${objectPath(objectKey(name, area))}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }),
  })
  if (!response.ok) throw refused('sign a link', response)
  const { signedURL } = await response.json() as { signedURL: string }
  return `${config.supabase.url}/storage/v1${signedURL}`
}

/** A link the browser can PUT one new file to. Supabase sets how long it lasts, so the app's own ticket is what runs out first. */
export async function signedUploadUrl(name: string, area: Area = 'uploads') {
  const response = await storage(`/object/upload/sign/${config.supabase.bucket}/${objectPath(objectKey(name, area))}`, { method: 'POST' })
  if (!response.ok) throw refused('sign an upload', response)
  const { url } = await response.json() as { url: string }
  return `${config.supabase.url}/storage/v1${url}`
}

/** Sends a file to a browser. Storage answers range requests itself, and big files can't pass through a Vercel response. */
export async function sendStored(request: Request, response: Response, name: string, area: Area = 'uploads') {
  if (storageReady()) {
    if (!await fileExists(name, area)) return void response.status(404).end()
    response.setHeader('Cache-Control', 'private, no-store')
    return response.redirect(302, await signedUrl(name, area))
  }
  const file = localPath(name, area)
  if (!fs.existsSync(file)) return void response.status(404).end()
  response.sendFile(file)
}

/** Backups live beside the data rather than in it. */
export async function listBackups() {
  if (!storageReady()) return fs.readdirSync(areaDir('backups')).sort()
  const response = await storage(`/object/list/${config.supabase.bucket}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: 'backups/', limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  })
  if (!response.ok) throw refused('list backups', response)
  return ((await response.json()) as Array<{ name: string }>).map((row) => row.name.split('/').at(-1)!).sort()
}
