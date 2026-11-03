import fs from 'node:fs'
import path from 'node:path'
import { collectWords } from './words.ts'
import { LANGUAGES } from '../shared/lang.ts'

/** Checks one language file against the code. Run it with: npx tsx scripts/words-check.ts pl */

const marks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')

export function problemsIn(code: string) {
  const words = JSON.parse(fs.readFileSync(path.join('shared/words', `${code}.json`), 'utf8')) as Record<string, string | Record<string, string>>
  const { plain, counted } = collectWords()
  const problems: string[] = []
  for (const key of plain) {
    if (key in counted) continue
    const value = words[key]
    if (typeof value !== 'string' || !value.trim()) problems.push(`missing: ${key}`)
    else if (marks(value) !== marks(key)) problems.push(`placeholders differ: ${key}`)
  }
  for (const key of Object.keys(counted)) {
    const value = words[key]
    if (!value || typeof value === 'string') { problems.push(`needs plural forms: ${key}`); continue }
    for (const form of new Intl.PluralRules(LANGUAGES.find((language) => language.code === code)!.locale).resolvedOptions().pluralCategories) {
      if (typeof value[form] !== 'string') problems.push(`missing ${form}: ${key}`)
      else if (marks(value[form]) !== marks(key)) problems.push(`placeholders differ in ${form}: ${key}`)
    }
  }
  return problems
}

if (process.argv[2]) {
  const problems = problemsIn(process.argv[2])
  console.log(problems.length ? problems.slice(0, 60).join('\n') : 'OK')
  console.log(`${problems.length} problems`)
}
