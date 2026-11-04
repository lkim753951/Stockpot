import { api } from './api'

/** Long enough to keep small print readable, small enough for any model and any upload limit. */
const LONGEST_SIDE = 2400
const IMAGE = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i

/**
 * A photo of a menu or recipe goes as a JPEG of a sensible size. A large PNG screenshot or a phone photo can be
 * too big for the model, and a transparent PNG can read as black. Anything the browser can't open goes as it is.
 */
export async function readableImage(file: File) {
  if (!(file.type.startsWith('image/') || IMAGE.test(file.name)) || file.type === 'image/svg+xml') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    if (!blob) return file
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' })
  } catch { return file }
}

export interface FileProblem { file: string; message: string }

/** Reads files one after another, so one bad file doesn't lose the others. */
export async function readEach<T>(files: File[], read: (file: File) => Promise<T>) {
  const found: Array<{ file: string; result: T }> = []
  const problems: FileProblem[] = []
  for (const file of files) {
    try { found.push({ file: file.name, result: await read(await readableImage(file)) }) } catch (problem) { problems.push({ file: file.name, message: (problem as Error).message }) }
  }
  return { found, problems }
}

/** The menu reader for one file. Each dish carries notes about anything left out. */
export const readMenuFile = (file: File) => {
  const form = new FormData()
  form.append('file', file)
  return api<any[]>('/api/setup/menu/read', { form })
}

/** What every menu file may be. */
export const MENU_FILES = 'application/pdf,image/jpeg,image/png,image/webp,text/plain,.pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.csv,.xlsx'

/** Runs a few at a time, so a long menu doesn't wait on one call after another, nor send them all at once. */
export async function inTurns<T, R>(items: T[], work: (item: T) => Promise<R>, together = 3) {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(together, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  }))
  return results
}

/** Two pages of one menu can both list a dish. It's kept once, as the later file has it. */
export function mergeDishes<T extends { name: string }>(kept: T[], more: T[]) {
  const byName = new Map(kept.map((dish) => [dish.name.trim().toLowerCase(), dish]))
  for (const dish of more) byName.set(dish.name.trim().toLowerCase(), dish)
  return [...byName.values()]
}
