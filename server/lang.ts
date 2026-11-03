import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGUAGES, isLang, languageOf, translate, translateCount, translateSaved, type Lang, type Values, type Words } from '../shared/lang.ts'

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'words')

function read(code: Lang): Words {
  if (code === 'en') return {}
  try { return JSON.parse(fs.readFileSync(path.join(folder, `${code}.json`), 'utf8')) } catch { return {} }
}

const dictionaries = Object.fromEntries(LANGUAGES.map(({ code }) => [code, read(code)])) as Record<Lang, Words>
const current = new AsyncLocalStorage<Lang>()

/** Whatever runs inside speaks this language: a browser's request, or one WhatsApp message to one person. */
export const inLanguage = <T>(code: unknown, work: () => T) => current.run(isLang(code) ? code : 'en', work)

export const lang = () => current.getStore() ?? 'en'
export const languageName = () => languageOf(lang()).english
export const t = (english: string, values?: Values) => translate(dictionaries[lang()], english, values)
export const tn = (count: number, one: string, many: string, values?: Values) => translateCount(dictionaries[lang()], lang(), count, one, many, values)
export const tSaved = (text: string) => translateSaved(dictionaries[lang()], text)
