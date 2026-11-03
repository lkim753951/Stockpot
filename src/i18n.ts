import { useSyncExternalStore } from 'react'
import { LANGUAGES, isLang, isRightToLeft, languageOf, pickLanguage, translate, translateCount, translateSaved, type Lang, type Values, type Words } from '../shared/lang'

const CHOICE = 'stockpot-language'
const files = import.meta.glob<{ default: Words }>(['../shared/words/*.json', '!../shared/words/english.json'])

function firstLanguage(): Lang {
  try {
    const chosen = localStorage.getItem(CHOICE)
    if (isLang(chosen)) return chosen
  } catch { /* private window */ }
  return pickLanguage(navigator.languages ?? [navigator.language])
}

let language: Lang = firstLanguage()
let words: Words = {}
const listeners = new Set<() => void>()

async function load(code: Lang) {
  // With no signal and no saved copy, English still works, so a crisis card always opens.
  words = code === 'en' ? {} : await files[`../shared/words/${code}.json`]().then((file) => file.default).catch(() => ({}))
  language = code
  document.documentElement.lang = code
  document.documentElement.dir = isRightToLeft(code) ? 'rtl' : 'ltr'
}

export const loadLanguage = () => load(language)

export async function setLanguage(code: Lang) {
  await load(code)
  try { localStorage.setItem(CHOICE, code) } catch { /* private window */ }
  listeners.forEach((listener) => listener())
}

export const useLanguage = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, () => language)
export const currentLanguage = () => language
export const locale = () => languageOf(language).locale
export { LANGUAGES }

/** The English text is the key, so a screen reads the same as it does on the page. Unknown text comes back as it is. */
export const t = (english: string, values?: Values) => translate(words, english, values)
export const tn = (count: number, one: string, many: string, values?: Values) => translateCount(words, language, count, one, many, values)
/** Marks text kept in a list outside a screen. The screen translates it when it draws, with t(). */
export const tk = (english: string) => english
/** For text the server saved in English. */
export const tSaved = (text: string | null | undefined) => (text ? translateSaved(words, text) : '')
