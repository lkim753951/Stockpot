import { config } from './config.ts'
import { saveSetting, setting } from './db.ts'

/** Restaurant time. Checklists run on the wall clock in the kitchen, not on server time. */

const zone = process.env.RESTAURANT_TIMEZONE ?? 'Europe/London'
const format = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** Lives in the database, because the sample's requests land on different instances. Read at the start of each one. */
let demoOffsetMs = 0
const DEMO_CLOCK = 'demo_clock'

export async function syncDemoClock() {
  if (config.mode !== 'sample') return
  demoOffsetMs = Number(JSON.parse(await setting(DEMO_CLOCK) ?? '{}').offsetMs ?? 0)
}

async function saveDemoClock(offsetMs: number) {
  demoOffsetMs = offsetMs
  await saveSetting(DEMO_CLOCK, JSON.stringify({ offsetMs, day: new Date().toISOString().slice(0, 10) }))
}

export function localTime(at = new Date(Date.now() + demoOffsetMs)) {
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const time = `${parts.hour}:${parts.minute}`
  return { date, time, stamp: `${date}T${time}` }
}

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

/** Monday of the week that holds this date. */
export function mondayOf(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  return addDays(date, -((weekday + 6) % 7))
}

const asMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/** How far the clock has to move to reach a time today. Checked again after the move, because the clocks can change on the way. */
function offsetTo(time: string, fromOffset: number) {
  let offset = fromOffset
  for (let step = 0; step < 3; step += 1) offset += (asMinutes(time) - asMinutes(localTime(new Date(Date.now() + offset)).time)) * 60000
  return offset
}

/** Used only by the sample demo, so the one-day story can reach closing time. */
export async function jumpTo(time: string) {
  await syncDemoClock()
  await saveDemoClock(offsetTo(time, demoOffsetMs))
}

/** The sample restaurant's day starts before opening, so nothing is overdue yet. */
export const startDemoDay = () => saveDemoClock(offsetTo('07:30', 0))

/** A new instance joins the day already running. Only a new real day starts the story again. */
export async function resumeDemoDay() {
  const saved = JSON.parse(await setting(DEMO_CLOCK) ?? '{}')
  if (saved.day === new Date().toISOString().slice(0, 10)) demoOffsetMs = Number(saved.offsetMs ?? 0)
  else await startDemoDay()
}
