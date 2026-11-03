import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const envFile = () => path.resolve(process.env.ENV_FILE ?? '.env')

function loadDotEnv() {
  const file = envFile()
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
}
loadDotEnv()

const apiKey = process.env.MODEL_API_KEY?.trim() || ''
/** Vercel sets this. Its disk is read-only apart from the temp folder, and nothing there outlasts an instance. */
const hosted = !!process.env.VERCEL

function databaseSchema() {
  const schema = process.env.DB_SCHEMA?.trim() || 'public'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA can only use lower-case letters, digits and underscores.')
  return schema
}

/** Name:number or Name:number:language, with commas between people. */
function parseStaff(value: string) {
  return value.split(',').map((pair) => pair.split(':')).flatMap(([name, number, language]) => {
    const digits = number?.replace(/[^\d]/g, '')
    return name?.trim() && digits ? [{ name: name.trim(), number: digits, language: language?.trim() || null }] : []
  })
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  hosted,
  /** On Vercel this is only a cache. With Supabase set, Storage holds the real copy of every file. */
  dataDir: hosted ? path.join(os.tmpdir(), 'stockpot') : path.resolve(process.env.DATA_DIR ?? './data'),
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  dbSchema: databaseSchema(),
  supabase: {
    url: process.env.SUPABASE_URL?.trim().replace(/\/+$/, '') || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY?.trim() || '',
    bucket: process.env.SUPABASE_BUCKET?.trim() || 'stockpot',
  },
  cronSecret: process.env.CRON_SECRET?.trim() || '',
  /** "sample" runs the same code path against a built-in stand-in for the Meta API. */
  mode: (apiKey ? 'live' : 'sample') as 'live' | 'sample',
  apiKey: apiKey || 'sample',
  baseUrl: process.env.META_BASE_URL ?? 'https://api.meta.ai/v1',
  realtimeUrl: process.env.META_REALTIME_URL ?? 'wss://api.meta.ai/v1/asr/realtime',
  sparkModel: process.env.META_SPARK_MODEL ?? 'muse-spark-1.3',
  voiceModel: process.env.META_VOICE_MODEL ?? 'muse-voice-transcribe-1.0',
  samModel: process.env.META_SAM_MODEL ?? 'sam-3.1',
  ownerPasscode: process.env.OWNER_PASSCODE?.trim() || '',
  staffPasscode: process.env.STAFF_PASSCODE?.trim() || '',
  sessionSecret: process.env.SESSION_SECRET?.trim() || 'stockpot-local-only',
  maxModelCalls: Number(process.env.MAX_MODEL_CALLS ?? 2000),
  maxCallMinutes: 30,
  production: process.env.NODE_ENV === 'production' || hosted,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
    authUrl: process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    apiUrl: process.env.GOOGLE_API_URL ?? 'https://gmail.googleapis.com/gmail/v1',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || '',
    authToken: process.env.TWILIO_AUTH_TOKEN?.trim() || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || '',
    ownerNumber: process.env.OWNER_PHONE?.trim() || '',
    baseUrl: process.env.TWILIO_BASE_URL ?? 'https://api.twilio.com/2010-04-01',
  },
  whatsapp: {
    baseUrl: process.env.WHATSAPP_BASE_URL ?? 'https://graph.facebook.com/v26.0',
    token: process.env.WHATSAPP_TOKEN?.trim() || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '',
    // The owner's own number. It stays in .env and is never sent to a browser or written to a log.
    ownerNumber: process.env.WHATSAPP_OWNER_NUMBER?.replace(/[^\d]/g, '') || '',
    /** The business number invites point to. Without it, Stockpot asks Meta. */
    businessNumber: process.env.WHATSAPP_BUSINESS_NUMBER?.replace(/[^\d]/g, '') || '',
    /** Staff as Name:number pairs, separated by commas. Only the names ever reach a screen. */
    staff: parseStaff(process.env.WHATSAPP_STAFF_NUMBERS ?? ''),
    /** Proves a message really came from Meta. Replies are refused without it. */
    appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() || '',
    webhookPort: Number(process.env.WEBHOOK_PORT ?? 8788),
  },
}

/** A public server with a real key and no passcode would let anyone spend the credits and read the invoices. */
export function assertSafeToStart() {
  if (config.mode === 'live' && config.production) {
    if (!config.ownerPasscode) throw new Error('OWNER_PASSCODE is required when MODEL_API_KEY is set in production.')
    if (!config.staffPasscode) throw new Error('STAFF_PASSCODE is required when MODEL_API_KEY is set in production.')
  }
  if (config.ownerPasscode && config.sessionSecret === 'stockpot-local-only' && config.production) {
    throw new Error('SESSION_SECRET is required when OWNER_PASSCODE is set in production.')
  }
  // A sample with no database is fine on Vercel: it keeps its made-up data on the function's temporary disk.
  const throwaway = config.hosted && config.mode === 'sample' && !config.databaseUrl
  if (config.hosted && !throwaway && !config.databaseUrl) throw new Error('DATABASE_URL is required on Vercel, because its disk does not last.')
  if (config.hosted && !throwaway && !(config.supabase.url && config.supabase.serviceKey)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required on Vercel, because its disk does not last.')
  // Sample mode clears its data when asked. A missing key must never be able to point that at the real tables.
  if (config.mode === 'sample' && config.databaseUrl && config.dbSchema !== 'sample') {
    throw new Error('With no MODEL_API_KEY, Stockpot runs the sample and clears its data. Set DB_SCHEMA=sample, so it can never touch the real tables.')
  }
}
/** Picks up what the owner saved on the Connections screen, so WhatsApp and Gmail work without a restart. */
export function applySavedConnections() {
  const text = (key: string) => process.env[key]?.trim() || ''
  config.google.clientId = text('GOOGLE_CLIENT_ID')
  config.google.clientSecret = text('GOOGLE_CLIENT_SECRET')
  config.whatsapp.token = text('WHATSAPP_TOKEN')
  config.whatsapp.phoneNumberId = text('WHATSAPP_PHONE_NUMBER_ID')
  config.whatsapp.ownerNumber = text('WHATSAPP_OWNER_NUMBER').replace(/[^\d]/g, '')
  config.whatsapp.businessNumber = text('WHATSAPP_BUSINESS_NUMBER').replace(/[^\d]/g, '')
  config.twilio.accountSid = text('TWILIO_ACCOUNT_SID')
  config.twilio.authToken = text('TWILIO_AUTH_TOKEN')
  config.twilio.fromNumber = text('TWILIO_FROM_NUMBER')
  config.twilio.ownerNumber = text('OWNER_PHONE')
  config.whatsapp.staff = parseStaff(text('WHATSAPP_STAFF_NUMBERS'))
  config.whatsapp.appSecret = text('WHATSAPP_APP_SECRET')
  config.whatsapp.verifyToken = text('WHATSAPP_VERIFY_TOKEN')
}

/** Writes to .env on this computer. The values never come back to a browser. */
export function saveToEnv(values: Record<string, string>) {
  const file = envFile()
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []
  for (const [key, value] of Object.entries(values)) {
    const clean = value.replace(/[\r\n]/g, '').trim()
    const index = lines.findIndex((line) => line.startsWith(`${key}=`))
    if (index >= 0) lines[index] = `${key}=${clean}`
    else lines.push(`${key}=${clean}`)
    process.env[key] = clean
  }
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  applySavedConnections()
}

export function setSampleEndpoints(httpBase: string, wsUrl: string) {
  config.baseUrl = httpBase
  config.realtimeUrl = wsUrl
}
