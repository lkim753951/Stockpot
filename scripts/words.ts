import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGUAGES, SAVED_PATTERNS } from '../shared/lang.ts'
import { CRISIS_CARDS } from '../server/operations/crisis.ts'

/**
 * Lists every English sentence the app can show, by reading the code. A language file needs a
 * translation for each one, and test/words.test.ts fails if any are missing.
 * Run it with: npx tsx scripts/words.ts
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const skip = /(^|\/)(kit|sample|test)(\/|$)/

function sources(folder: string): string[] {
  return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(folder, entry.name)
    if (entry.isDirectory()) return skip.test(relative) ? [] : sources(relative)
    return /\.tsx?$/.test(entry.name) ? [relative] : []
  })
}

const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`
const read = (literal: string) => literal.slice(1, -1).replace(/\\(.)/g, (_all, letter: string) => (letter === 'n' ? '\n' : letter))

/** Sentences the app needs that are built from data, or saved in the database. */
const EXTRA = [
  ...SAVED_PATTERNS, ...CRISIS_CARDS.flatMap((card) => [card.title, ...(card.call ? [card.call.label] : []), ...card.steps]),
  ...LANGUAGES.map((language) => language.english),
]

/** Fixed rows in the code that only reach the screen through t(variable). */
const DATA_FILES = ['server/operations/checklists.ts', 'server/setup/setup.ts', 'server/operations/reports.ts', 'server/ai/analyst.ts', 'server/operations/actions.ts'].map((file) => path.normalize(file))
const DATA_PATTERNS = [
  /template\((?:'|")([^'"]+)(?:'|"), '(?:daily|weekly|monthly)'/g,
  /^\s*\[(?:'|")([^'"]+)(?:'|"), '(?:tick|temperature|stock)'/gm,
]

export function collectWords() {
  const plain = new Set<string>(EXTRA)
  const counted = new Map<string, string>()
  for (const file of [...sources('src'), ...sources('server'), 'shared/lang.ts']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const match of text.matchAll(new RegExp(String.raw`\btk?\(\s*(${STRING})`, 'g'))) plain.add(read(match[1]))
    for (const match of text.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*(${STRING}),\s*(${STRING})`, 'g'))) counted.set(read(match[2]), read(match[1]))
    // A sentence chosen by a condition inside t(), such as t(rise ? 'a' : 'b').
    for (const match of text.matchAll(new RegExp(String.raw`\bt\([^'"\n]*\?\s*(${STRING})\s*:\s*(${STRING})`, 'g'))) { plain.add(read(match[1])); plain.add(read(match[2])) }
    // Server messages are translated in the browser when they arrive.
    for (const match of text.matchAll(new RegExp(String.raw`(?:error: |new SetupError\(|new GmailError\()(${STRING})`, 'g'))) plain.add(read(match[1]))
    if (DATA_FILES.includes(file)) {
      for (const pattern of DATA_PATTERNS) for (const match of text.matchAll(pattern)) plain.add(match[1])
      for (const match of text.matchAll(new RegExp(String.raw`(?:title|detail|label): (${STRING})`, 'g'))) plain.add(read(match[1]))
    }
  }
  return { plain: [...plain].filter((word) => /\p{L}/u.test(word) && word !== 'Stockpot').sort(), counted: Object.fromEntries(counted) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const words = collectWords()
  fs.writeFileSync(path.join(root, 'shared/words/english.json'), `${JSON.stringify(words, null, 1)}\n`)
  console.log(`${words.plain.length} sentences, ${Object.keys(words.counted).length} counted`)
}
