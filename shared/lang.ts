/** The languages Stockpot speaks. English is the source: every other language is a file in shared/words, keyed by the English text. */
export const LANGUAGES = [
  { code: 'en', name: 'English', english: 'English', locale: 'en-GB' },
  { code: 'pl', name: 'Polski', english: 'Polish', locale: 'pl-PL' },
  { code: 'ro', name: 'Română', english: 'Romanian', locale: 'ro-RO' },
  { code: 'es', name: 'Español', english: 'Spanish', locale: 'es-ES' },
  { code: 'pt', name: 'Português', english: 'Portuguese', locale: 'pt-PT' },
  { code: 'it', name: 'Italiano', english: 'Italian', locale: 'it-IT' },
  { code: 'fr', name: 'Français', english: 'French', locale: 'fr-FR' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', locale: 'tr-TR' },
  { code: 'bn', name: 'বাংলা', english: 'Bengali', locale: 'bn-BD-u-nu-latn' },
  { code: 'hi', name: 'हिन्दी', english: 'Hindi', locale: 'hi-IN' },
  { code: 'ur', name: 'اردو', english: 'Urdu', locale: 'ur-PK', rtl: true },
  { code: 'ne', name: 'नेपाली', english: 'Nepali', locale: 'ne-NP-u-nu-latn' },
  { code: 'ar', name: 'العربية', english: 'Arabic', locale: 'ar-EG-u-nu-latn', rtl: true },
  { code: 'zh', name: '中文', english: 'Chinese', locale: 'zh-CN' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese', locale: 'vi-VN' },
  { code: 'tl', name: 'Tagalog', english: 'Tagalog', locale: 'fil-PH' },
  { code: 'ko', name: '한국어', english: 'Korean', locale: 'ko-KR' },
  { code: 'ja', name: '日本語', english: 'Japanese', locale: 'ja-JP' },
] as const

export type Lang = (typeof LANGUAGES)[number]['code']
export type Words = Record<string, string | Record<string, string>>
export type Values = Record<string, string | number | null | undefined>

export const isLang = (code: unknown): code is Lang => LANGUAGES.some((language) => language.code === code)
export const languageOf = (code: Lang) => LANGUAGES.find((language) => language.code === code)!
export const isRightToLeft = (code: Lang) => 'rtl' in languageOf(code)

/** The first language on a browser's list that Stockpot speaks, or English. */
export function pickLanguage(wanted: readonly string[]): Lang {
  for (const tag of wanted) {
    const code = tag.toLowerCase().split('-')[0]
    if (isLang(code)) return code
    if (code === 'fil') return 'tl'
  }
  return 'en'
}

const RIGHT_TO_LEFT_TEXT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/

/** Prices, times and phone numbers keep their reading order inside Arabic and Urdu sentences. */
const keepOrder = (text: string, value: string) => (/\d/.test(value) && RIGHT_TO_LEFT_TEXT.test(text) ? `\u2066${value}\u2069` : value)

export const fill = (text: string, values?: Values) =>
  values ? text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? keepOrder(text, String(values[key] ?? '')) : whole)) : text

export function translate(words: Words, english: string, values?: Values) {
  const found = words[english]
  return fill(typeof found === 'string' ? found : english, values)
}

/** Counted text. A language's own plural rules pick the form, so Polish can have its three. */
export function translateCount(words: Words, code: Lang, count: number, one: string, many: string, values?: Values) {
  const all = { n: count, ...values }
  const found = words[many]
  if (found === undefined) return fill(count === 1 ? one : many, all)
  if (typeof found === 'string') return fill(found, all)
  return fill(found[new Intl.PluralRules(languageOf(code).locale).select(count)] ?? found.other, all)
}

/**
 * Text saved in English with details in it, like "£12.40 to claim from Brakes". The saved row stays
 * in English, and the sentence is translated on the way out with the details left as they were.
 */
export const SAVED_PATTERNS = [
  'Check the {supplier} order',
  '{amount} to claim from {supplier}',
  '{item} is low: {value}',
  '{item} is at {value}',
  '{checklist} are overdue',
  'Was due at {time}.',
  'Check the photo: {item}',
  'Delivery from {supplier} is due',
  'Problem with the {supplier} delivery',
  'Should be {low} to {high}.',
  'Should be {range}.',
  '{value} or below',
  '{value} or above',
]

const matchers = SAVED_PATTERNS.map((pattern) => {
  const names = [...pattern.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
  const source = pattern.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
  return { pattern, names, regex: new RegExp(`^${source}$`) }
})

export function translateSaved(words: Words, text: string): string {
  if (typeof words[text] === 'string') return words[text] as string
  for (const { pattern, names, regex } of matchers) {
    const match = text.match(regex)
    if (match) return translate(words, pattern, Object.fromEntries(names.map((name, index) => [name, translateSaved(words, match[index + 1])])))
  }
  return text
}
