import { currentLanguage, locale, t } from './i18n'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly values?: Record<string, string | number>) { super(message) }
}

/** Vercel refuses a request over 4.5 MB, so a form stays a little under that. */
const FORM_LIMIT = 4 * 1024 * 1024

/** Sends the biggest files straight to Storage, until what's left fits in the form. The server reads them the same either way. */
async function fitForm(form: FormData) {
  const fileEntries = () => [...form.entries()].filter((entry): entry is [string, File] => entry[1] instanceof File)
  const total = () => fileEntries().reduce((sum, [, file]) => sum + file.size, 0)
  if (total() <= FORM_LIMIT) return form
  const stored: Array<{ field: string; path: string; name: string }> = []
  const kept = new FormData()
  for (const [key, value] of form.entries()) if (!(value instanceof File)) kept.append(key, value)
  let left = total()
  for (const [field, file] of fileEntries().sort((a, b) => b[1].size - a[1].size)) {
    if (left > FORM_LIMIT) {
      const ticket = await api('/api/uploads/sign', { body: { name: file.name, size: file.size } })
      // With no Storage behind this server, a form of any size is fine.
      if (!ticket.direct) return form
      const sent = await fetch(ticket.url, { method: 'PUT', headers: { 'Content-Type': ticket.contentType }, body: file })
      if (!sent.ok) throw new ApiError(t("That didn't work. Try again."), sent.status)
      stored.push({ field, path: ticket.path, name: file.name })
      left -= file.size
    } else kept.append(field, file, file.name)
  }
  kept.append('storedFiles', JSON.stringify(stored))
  return kept
}

export async function api<T = any>(url: string, options: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const form = options.form ? await fitForm(options.form) : undefined
  const response = await fetch(url, {
    method: options.method ?? (options.body || form ? 'POST' : 'GET'),
    headers: { 'X-Stockpot-Language': currentLanguage(), ...(form ? {} : { 'Content-Type': 'application/json' }) },
    body: form ?? (options.body ? JSON.stringify(options.body) : undefined),
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 413) throw new ApiError(t('That file is too large.'), response.status)
  if (!response.ok) throw new ApiError(payload?.error ? t(payload.sentence ?? payload.error, payload.values) : t("That didn't work. Try again."), response.status, payload?.values)
  return payload as T
}

export const pounds = (pence: number | null | undefined) =>
  pence === null || pence === undefined ? t('Not known') : `${pence < 0 ? '-' : ''}£${(Math.abs(Math.round(pence)) / 100).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Whole pounds, for tiles where pence would only be noise. */
export const wholePounds = (pence: number) => `£${Math.round(pence / 100).toLocaleString(locale())}`

export const niceDate = (iso: string | null | undefined) => {
  if (!iso) return t('No date yet')
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`)
    .toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .replace(',', '')
}

/** Saved in kilos and litres, read in grams and millilitres. */
export function portionAmount(line: { quantity: number; unit: string }) {
  if (line.unit === 'each') return `${Number(line.quantity.toFixed(2))}`
  if (line.quantity < 1) return `${Number((line.quantity * 1000).toFixed(1))} ${line.unit === 'kg' ? 'g' : 'ml'}`
  return `${Number(line.quantity.toFixed(2))} ${line.unit}`
}

export const qty = (value: number | null | undefined, unit: string) =>
  value === null || value === undefined ? t('Not counted') : `${Number(value.toFixed(3))} ${unit === 'each' ? '' : unit}`.trim()
