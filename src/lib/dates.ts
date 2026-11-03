import { locale, t } from './i18n'

const shortDate = (date: Date) => date.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')

/** Today, Tomorrow or Yesterday, then the date itself, so a list reads at a glance. */
export function dayWords(iso: string | null | undefined) {
  if (!iso) return t('No date')
  const date = new Date(`${iso.slice(0, 10)}T12:00:00`)
  const days = Math.round((date.getTime() - new Date(new Date().toDateString()).getTime() - 12 * 3600000) / 86400000)
  if (days === 0) return t('Today')
  if (days === 1) return t('Tomorrow')
  if (days === -1) return t('Yesterday')
  return shortDate(date)
}

/** The same words for the middle of a sentence: "due today", but "due Fri 6 Nov". */
export const inSentence = (words: string) => {
  const day = [t('Today'), t('Tomorrow'), t('Yesterday')].find((word) => words.startsWith(word))
  return day ? day.toLocaleLowerCase(locale()) + words.slice(day.length) : words
}

/** A time saved as restaurant time, written 2026-11-02T22:00. */
export const atWords = (stamp: string) => t('{day} at {time}', { day: dayWords(stamp), time: stamp.slice(11, 16) })

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** A moment saved in UTC, shown in the viewer's own time. */
export function momentWords(iso: string) {
  const date = new Date(iso)
  return t('{day} at {time}', { day: dayWords(localDay(date)), time: clockWords(iso) })
}

/** Just the clock time, for things that happened today. */
export const clockWords = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

/** Just the time for today, so a list doesn't say "Today at" on every line. */
export function whenWords(iso: string) {
  return localDay(new Date(iso)) === localDay(new Date()) ? clockWords(iso) : momentWords(iso)
}

export const longToday = () => new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })
