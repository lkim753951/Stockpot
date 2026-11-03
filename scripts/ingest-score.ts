import fs from 'node:fs'
import path from 'node:path'
import { toBase } from '../server/parsing.ts'

/** Compares what a file import found with the ground truth beside the datasets. The tests and the real Meta check both use this. */

export const DATASETS = path.resolve(process.env.INGEST_DATASETS ?? 'public/samples/datasets')

export interface TruthEntry { month: string; file: string; format: string; kind: 'sales' | 'recipes' | 'ingredients'; expected: any; read: any; full: string }

export function loadTruth() {
  return fs.readdirSync(DATASETS).sort().map((month) => {
    const truth = JSON.parse(fs.readFileSync(path.join(DATASETS, month, 'ground-truth.json'), 'utf8'))
    return { month, totals: truth.month_totals, files: truth.files.map((entry: any) => ({ ...entry, month, full: path.join(DATASETS, month, entry.file) })) as TruthEntry[] }
  })
}

const close = (a: number, b: number, share = 0.01) => Math.abs(a - b) <= Math.max(Math.abs(b) * share, 0.0005)

export function scoreFile(entry: TruthEntry, preview: any) {
  const wrong: string[] = []
  const same = (label: string, found: unknown, want: unknown) => { if (found !== want) wrong.push(`${label}: found ${found}, expected ${want}`) }
  const { expected } = entry
  let found = 0
  let wanted = 0
  let totals = ''
  if (entry.kind === 'sales') {
    found = preview.summary.rows
    wanted = expected.rows
    same('rows', found, wanted)
    same('quantity', preview.summary.quantity, expected.quantity)
    same('net pence', preview.summary.netPence, expected.netPence)
    same('rows flagged', preview.summary.problems, expected.problems)
    same('printed net pence', preview.summary.printed.netPence, expected.printedNetPence)
    same('printed total flagged', preview.checks.some((check: any) => /The rows add up to \{rows\},/.test(check.text)), expected.totalsDiffer)
    for (const dish of expected.unknownDishes) if (!preview.problems.some((row: any) => row.dish === dish)) wrong.push(`${dish} was not flagged as unknown`)
    totals = `net £${(preview.summary.netPence / 100).toFixed(2)}, expected £${(expected.netPence / 100).toFixed(2)}; ${preview.summary.quantity} sold, expected ${expected.quantity}`
  } else if (entry.kind === 'ingredients') {
    found = preview.rows.length
    wanted = expected.rows
    same('rows', found, wanted)
    same('supplier', preview.supplier.name, expected.supplier)
    same('date', preview.date, expected.date)
    for (const line of expected.lines) {
      const row = preview.rows.find((candidate: any) => candidate.name === line.name)
      if (!row) { wrong.push(`${line.name} is missing`); continue }
      same(`${line.name} flagged`, row.status === 'problem', line.flagged)
      if (!line.flagged) {
        same(`${line.name} unit`, row.unit, line.unit)
        if (row.basePricePence === null || !close(row.basePricePence, line.basePricePence)) wrong.push(`${line.name} price: found ${row.basePricePence}, expected ${line.basePricePence}`)
      }
    }
    const priced = expected.lines.filter((line: any) => !line.flagged).length
    totals = `${preview.rows.filter((row: any) => row.basePricePence !== null).length} priced, expected ${priced}`
  } else {
    found = preview.recipes.length
    wanted = expected.recipes.length
    same('recipes', found, wanted)
    for (const recipe of expected.recipes) {
      const read = preview.recipes.find((candidate: any) => candidate.name === recipe.name)
      if (!read) { wrong.push(`${recipe.name} is missing`); continue }
      same(`${recipe.name} portions`, read.portions, recipe.portions)
      same(`${recipe.name} prep`, read.prepMinutes, recipe.prepMinutes)
      same(`${recipe.name} service`, read.serviceMinutes, recipe.serviceMinutes)
      same(`${recipe.name} steps`, read.steps.length, recipe.steps)
      same(`${recipe.name} ingredients`, read.lines.length, recipe.ingredients.length)
      for (const line of recipe.ingredients) {
        const row = read.lines.find((candidate: any) => candidate.name.toLowerCase() === line.name.toLowerCase())
        if (!row) { wrong.push(`${recipe.name}: ${line.name} is missing`); continue }
        same(`${recipe.name}: ${line.name} flagged`, row.flags.length > 0, line.flagged)
        if (line.flagged) continue
        const base = row.quantity === null ? null : toBase(row.quantity, row.unit)
        if (!base || base.unit !== line.unit || !close(base.quantity, line.perPortion)) wrong.push(`${recipe.name}: ${line.name} per portion: found ${row.quantity} ${row.unit}, expected ${line.perPortion} ${line.unit}`)
      }
    }
    totals = `${preview.summary.ingredients} ingredients, expected ${expected.recipes.reduce((sum: number, recipe: any) => sum + recipe.ingredients.length, 0)}`
  }
  return { pass: !wrong.length, found, wanted, totals, wrong }
}
