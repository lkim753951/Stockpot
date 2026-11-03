import { formatPounds } from './money.ts'

/**
 * Turns a tool result into A2UI operations for CopilotKit's standard catalog.
 * Muse Spark names the result and the kind of view. Every figure here is copied from the result by code.
 */

export interface ViewChoice {
  result: number
  kind: 'table' | 'bar' | 'line'
  title: string
}

const CATALOG = 'copilotkit/standard@1'
const HIDDEN = new Set(['source_id', 'order_id', 'type', 'lines'])

const label = (key: string) => {
  const words = key.replace(/_pence$/, '').replace(/_percent$/, ' %').replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const show = (key: string, value: unknown) => {
  if (value === null || value === undefined) return ''
  if (key.endsWith('_pence')) return formatPounds(Number(value))
  if (key.endsWith('_percent')) return `${value}%`
  return String(value)
}

/** The rows of a result, whether a tool gave one object, a list, or lists inside an object. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result.filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>
  if (result && typeof result === 'object') {
    const lists = Object.values(result).filter(Array.isArray)
    if (lists.length) return lists.flatMap(rowsOf)
    return [result as Record<string, unknown>]
  }
  return []
}

function tableFor(id: string, rows: Array<Record<string, unknown>>) {
  const keys = Object.keys(rows[0]).filter((key) => !HIDDEN.has(key))
  return {
    id, component: 'Table',
    columns: keys.map((key) => ({ label: label(key), align: typeof rows[0][key] === 'number' ? 'end' : 'start' })),
    rows: rows.map((row) => keys.map((key) => show(key, row[key]))),
  }
}

function chartFor(id: string, kind: 'bar' | 'line', rows: Array<Record<string, unknown>>) {
  const keys = Object.keys(rows[0]).filter((key) => !HIDDEN.has(key))
  const category = keys.find((key) => typeof rows[0][key] === 'string') ?? keys[0]
  const measure = keys.find((key) => key.endsWith('_percent') && kind === 'line') ?? keys.find((key) => key.endsWith('_pence')) ?? keys.find((key) => typeof rows[0][key] === 'number')!
  const name = label(measure)
  return {
    id, component: 'Chart', chartType: kind, xKey: 'label', height: 200, showLegend: false,
    series: [{ key: 'value', color: 'var(--aubergine)', label: measure.endsWith('_pence') ? `${name} (£)` : name }],
    data: rows.map((row) => ({ label: String(row[category]), value: measure.endsWith('_pence') ? Number(row[measure]) / 100 : Number(row[measure]) })),
  }
}

export function buildAnswerSurface(surfaceId: string, choices: ViewChoice[], results: unknown[]) {
  const components: Array<Record<string, unknown>> = []
  const children: string[] = []
  choices.forEach((choice, index) => {
    const rows = rowsOf(results.at(choice.result))
    if (!rows.length) return
    components.push({ id: `title-${index}`, component: 'Title', text: choice.title })
    components.push(choice.kind === 'table' ? tableFor(`view-${index}`, rows) : chartFor(`view-${index}`, choice.kind, rows))
    children.push(`title-${index}`, `view-${index}`)
  })
  if (!children.length) return null
  return {
    surfaceId,
    catalogId: CATALOG,
    operations: [
      { version: 'v1.0', createSurface: { surfaceId, catalogId: CATALOG } },
      { version: 'v1.0', updateComponents: { surfaceId, components: [{ id: 'root', component: 'Column', children }, ...components] } },
    ],
  }
}
