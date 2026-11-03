/**
 * When a checklist happens. Either on chosen days of the week (every day is all seven), or on
 * rules like "first and third Wednesday of the month". Days are 0 for Sunday to 6 for Saturday.
 */

export type Schedule =
  | { kind: 'days'; days: number[] }
  | { kind: 'monthly'; rules: Array<{ week: number; day: number }> }

const utc = (date: string) => new Date(`${date}T12:00:00Z`)

/** Which week of the month a date falls in by counting that weekday: the third Wednesday is 3. */
const weekOfMonth = (date: Date) => Math.ceil(date.getUTCDate() / 7)

const isLastOfMonth = (date: Date) => {
  const next = new Date(date)
  next.setUTCDate(date.getUTCDate() + 7)
  return next.getUTCMonth() !== date.getUTCMonth()
}

export function occursOn(schedule: Schedule, iso: string) {
  const date = utc(iso)
  const weekday = date.getUTCDay()
  if (schedule.kind === 'days') return schedule.days.includes(weekday)
  return schedule.rules.some((rule) => rule.day === weekday && (rule.week === -1 ? isLastOfMonth(date) : rule.week === weekOfMonth(date)))
}

/** Returns a clean schedule, or null if it can never happen. */
export function cleanSchedule(input: any): Schedule | null {
  const weekday = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6
  if (input?.kind === 'days' && Array.isArray(input.days)) {
    const days = [...new Set<number>(input.days.filter(weekday))].sort()
    return days.length ? { kind: 'days', days } : null
  }
  if (input?.kind === 'monthly' && Array.isArray(input.rules)) {
    const rules = input.rules.filter((rule: any) => weekday(rule?.day) && [1, 2, 3, 4, 5, -1].includes(rule?.week)).map((rule: any) => ({ week: rule.week, day: rule.day }))
    return rules.length ? { kind: 'monthly', rules } : null
  }
  return null
}

/** What older lists saved as a plain frequency mean as a schedule. */
export function scheduleFor(template: Record<string, any>): Schedule | null {
  if (!template.schedule) return null
  try { return cleanSchedule(JSON.parse(String(template.schedule))) } catch { return null }
}

export const frequencyOf = (schedule: Schedule) => (schedule.kind === 'monthly' ? 'monthly' : schedule.days.length === 7 ? 'daily' : 'weekly')
