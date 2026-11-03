import { test } from 'node:test'
import assert from 'node:assert/strict'
import { problemsIn } from '../scripts/words-check.ts'
import { LANGUAGES } from '../shared/lang.ts'

test('every sentence in the app is translated, with its details in place', () => {
  for (const { code } of LANGUAGES.filter((language) => language.code !== 'en')) assert.deepEqual(problemsIn(code), [], code)
})
