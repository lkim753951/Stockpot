import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { problemsIn } from '../scripts/words-check.ts'
import { LANGUAGES } from '../shared/lang.ts'
import { usableKeywords } from '../server/ai/meta.ts'

test('every sentence in the app is translated, with its details in place', () => {
  for (const { code } of LANGUAGES.filter((language) => language.code !== 'en')) assert.deepEqual(problemsIn(code), [], code)
})

test('the browser loads each language from the real words folder', () => {
  const source = fs.readFileSync('src/lib/i18n.ts', 'utf8')
  const glob = source.match(/import\.meta\.glob<[^>]*>>?\(\[\s*'([^']+)\*\.json'/)?.[1]
  assert.ok(glob, 'no language glob found')
  assert.ok(source.includes(`files[\`${glob}\${code}.json\`]`), 'the lookup key must match the glob path')
  for (const { code } of LANGUAGES.filter((language) => language.code !== 'en')) {
    assert.ok(fs.existsSync(path.resolve('src/lib', glob, `${code}.json`)), code)
  }
})

test('transcription keywords stay within Meta\'s limit', () => {
  const long = 'Chicken thighs, boneless, skin on, five kilo tray'
  const [cut] = usableKeywords([long])
  assert.equal(cut, 'Chicken thighs, boneless, skin')
  assert.deepEqual(usableKeywords(['Basmati rice', ' Basmati rice ', '']), ['Basmati rice'])
  assert.ok(usableKeywords([long, 'x'.repeat(50)]).every((word) => word.length <= 30))
})
