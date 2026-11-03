import fs from 'node:fs'
import WebSocket from 'ws'
import { Ajv } from 'ajv'
import { config } from './config.ts'

const ajv = new Ajv({ strict: false, allErrors: true })

let modelCalls = 0
export const usage = { get modelCalls() { return modelCalls } }

function countCall() {
  modelCalls += 1
  if (modelCalls > config.maxModelCalls) {
    throw new MetaError('The model call limit for this server has been reached. Restart it or raise MAX_MODEL_CALLS.', 429, false)
  }
}

export class MetaError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function withRetries<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      const retryable = error instanceof MetaError ? error.retryable : (error as Error).name === 'TimeoutError'
      if (!retryable || attempt >= attempts) throw error
      await sleep(400 * 2 ** (attempt - 1) + Math.random() * 200)
    }
  }
}

async function failure(response: Response) {
  const detail = (await response.text().catch(() => '')).slice(0, 300)
  return new MetaError(`Meta API returned ${response.status}: ${detail}`, response.status, response.status === 429 || response.status >= 500)
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { file_data: string; filename: string } }

export interface JsonRequest {
  name: string
  schema: Record<string, unknown>
  system: string
  content: ContentPart[]
  effort?: 'minimal' | 'low' | 'medium' | 'high'
  timeoutMs?: number
  /** A live price that arrives late is useless, so live checks don't retry. */
  attempts?: number
}

/** Muse Spark with structured output. The reply is checked against the schema before anyone uses it. */
export async function sparkJson<T>(request: JsonRequest): Promise<T> {
  const validate = ajv.compile(request.schema)
  const body = {
    model: config.sparkModel,
    reasoning_effort: request.effort ?? 'low',
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: request.name, schema: request.schema },
    },
  }

  return withRetries(async () => {
    countCall()
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.timeoutMs ?? 90000),
    })
    if (!response.ok) throw await failure(response)
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> }
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.choices[0].message.content)
    } catch {
      throw new MetaError('Muse Spark returned text that was not JSON.', 502, true)
    }
    if (!validate(parsed)) throw new MetaError(`Muse Spark reply did not match ${request.name}: ${ajv.errorsText(validate.errors)}`, 502, true)
    return parsed as T
  }, request.attempts ?? 3)
}

export interface SparkTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: any) => unknown
}

export interface ToolStep {
  tool: string
  args: unknown
  result: unknown
  ok: boolean
}

export interface ToolRequest {
  system: string
  prompt: string
  tools: SparkTool[]
  /** Meta's max_tool_calls doesn't cover function tools, so the app sets its own limits. */
  maxRounds?: number
  maxCalls?: number
  /** Told about each tool as it runs, so a screen can show the work. */
  onStep?: (tool: string) => void | Promise<void>
  effort?: JsonRequest['effort']
  timeoutMs?: number
  /** When to stop asking and answer with what there is, because a function has a time limit. */
  stopAt?: number
}

/**
 * Muse Spark with function tools. The model asks, the code runs read-only tools, and the results go back.
 * The reply can be plain text at any point, and the arguments are always checked here before a tool runs.
 */
export async function sparkTools(request: ToolRequest) {
  const maxRounds = request.maxRounds ?? 6
  const maxCalls = request.maxCalls ?? 12
  const tools = request.tools.map((tool) => ({ ...tool, validate: ajv.compile(tool.parameters) }))
  const steps: ToolStep[] = []
  const messages: unknown[] = [
    { role: 'system', content: request.system },
    { role: 'user', content: request.prompt },
  ]

  const timeLeft = () => (request.stopAt ? request.stopAt - Date.now() : Infinity)
  for (let round = 1; round <= maxRounds; round += 1) {
    if (timeLeft() < 5000) return { text: '', steps, stoppedEarly: true }
    const message = await withRetries(async () => {
      countCall()
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.sparkModel,
          reasoning_effort: request.effort ?? 'medium',
          messages,
          tools: request.tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
        }),
        signal: AbortSignal.timeout(Math.min(request.timeoutMs ?? 90000, timeLeft())),
      })
      if (!response.ok) throw await failure(response)
      const payload = (await response.json()) as { choices: Array<{ message: AssistantMessage }> }
      return payload.choices[0].message
    })

    const calls = message.tool_calls ?? []
    if (!calls.length) return { text: message.content ?? '', steps, stoppedEarly: false }
    messages.push(message)

    for (const call of calls) {
      let result: unknown
      let ok = false
      let args: unknown = null
      const tool = tools.find((candidate) => candidate.name === call.function.name)
      try {
        args = JSON.parse(call.function.arguments || '{}')
        if (!tool) result = { error: `There is no tool called ${call.function.name}.` }
        else if (steps.length >= maxCalls) result = { error: 'The tool limit has been reached. Write your answer now.' }
        else if (!tool.validate(args)) result = { error: `Bad arguments: ${ajv.errorsText(tool.validate.errors)}` }
        else { result = await tool.run(args); ok = true }
      } catch (error) {
        result = { error: (error as Error).message }
      }
      steps.push({ tool: call.function.name, args, result, ok })
      await request.onStep?.(call.function.name)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  return { text: '', steps, stoppedEarly: true }
}

interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

export interface TranscriptTurn {
  turnId: number
  startMs: number
  endMs: number
  transcript: string
  speaker?: string
}

export interface FileTranscript {
  transcript: string
  audioDurationMs: number
  turns: TranscriptTurn[]
}

export interface TranscribeOptions {
  mode?: 'PUSH_TO_TALK' | 'ENDPOINTING' | 'DIARIZATION'
  /** Pass null to leave the setting out, so the model detects the language itself. */
  languageBias?: string[] | null
}

/** Muse Voice Transcribe file endpoint. Takes mono 16-bit WAV, up to 10 minutes and 32 MB. */
export async function transcribeWav(file: string, keywords: string[], options: TranscribeOptions = {}): Promise<FileTranscript> {
  const language = options.languageBias === undefined ? ['English'] : options.languageBias
  return withRetries(async () => {
    countCall()
    const form = new FormData()
    const settings = {
      mode: options.mode ?? 'DIARIZATION', model: config.voiceModel, audioEncoding: 'WAV',
      ...(language ? { languageBias: language } : {}),
      ...(keywords.length ? { keywords } : {}),
    }
    form.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }))
    form.append('audio', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'call.wav')
    const response = await fetch(`${config.baseUrl}/asr/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180000),
    })
    if (!response.ok) throw await failure(response)
    return (await response.json()) as FileTranscript
  })
}

export interface RealtimeHandlers {
  onReady: () => void
  onPartial: (text: string, audioMs: number) => void
  onTurn: (turnId: number, text: string, audioMs: number) => void
  onError: (message: string) => void
  onClose: () => void
}

/**
 * Muse Voice Transcribe realtime stream. ENDPOINTING gives turn boundaries with low delay.
 * Speaker labels come later, from a DIARIZATION pass over the saved recording,
 * because Meta says that mode is not tuned for low latency.
 */
export function openRealtime(keywords: string[], handlers: RealtimeHandlers, languageBias: string[] | null = ['English'], startMs = 0) {
  // Each connection is a new session to Meta. Only the local stand-in needs telling where in its script to carry on.
  const carryOn = startMs && /^ws:\/\/(127\.0\.0\.1|localhost)/.test(config.realtimeUrl) ? `&startMs=${startMs}` : ''
  const socket = new WebSocket(`${config.realtimeUrl}?sessionId=stockpot-${crypto.randomUUID()}${carryOn}`)
  let accepted = false
  let closing = false

  socket.on('open', () => {
    socket.send(JSON.stringify({
      authorization: { accessToken: `Bearer ${config.apiKey}` },
      audioEncoding: 'PCM_24KHZ',
      model: config.voiceModel,
      mode: 'ENDPOINTING',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: false,
      ...(languageBias ? { languageBias } : {}),
      ...(keywords.length ? { keywords } : {}),
    }))
  })

  socket.on('message', (data, isBinary) => {
    if (isBinary) return
    let event: Record<string, any>
    try {
      event = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!accepted) {
      if (event.sessionId && !event.type) {
        accepted = true
        handlers.onReady()
      } else {
        handlers.onError(String(event.message ?? 'Meta refused the transcription session.'))
      }
      return
    }
    if (event.type === 'transcript' && event.transcript) handlers.onPartial(event.transcript, event.audioProcessedMs ?? 0)
    if (event.type === 'speechComplete' && event.transcript) handlers.onTurn(event.turnId, event.transcript, event.audioProcessedMs ?? 0)
    if (event.type === 'error') handlers.onError(String(event.message ?? 'Transcription stopped.'))
  })

  socket.on('error', (error) => { if (!closing) handlers.onError(error.message) })
  socket.on('close', () => handlers.onClose())

  return {
    get ready() { return accepted && socket.readyState === WebSocket.OPEN },
    /** Skip audio rather than build a backlog: a late card is worse than a missed frame. */
    send(pcm: Buffer) {
      if (accepted && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 96000) socket.send(pcm)
    },
    finish() {
      closing = true
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'endStream' }))
    },
    close() {
      closing = true
      socket.close()
    },
  }
}

export interface SamBox { x1: number; y1: number; x2: number; y2: number; w: number; h: number; c: number | null }

/** SAM's answer is text with one box token per object, like <|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|>. */
export function readSamBoxes(text: string): SamBox[] {
  return [...text.matchAll(/<\|box;([^|]*)\|>/g)].flatMap((match) => {
    const fields = Object.fromEntries(match[1].split(';').map((pair) => pair.split('=')))
    const [x1, y1, x2, y2, w, h] = ['x1', 'y1', 'x2', 'y2', 'w', 'h'].map((key) => Number(fields[key]))
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite)) return []
    return [{ x1, y1, x2, y2, w, h, c: fields.c === undefined ? null : Number(fields.c) }]
  })
}

export type SamFrame = { frame: number; objects: Array<SamBox & { id: number }> }

/**
 * Video answers have one record per frame, like <12f>0<|box;...|><|mask;...|>,2<|box;...|>.
 * Frames with nothing in them are left out, so the frame number is read from the marker.
 */
export function readSamFrames(text: string): SamFrame[] {
  return text.split(/(?=<\d+f>)/).flatMap((record) => {
    const marker = record.match(/^<(\d+)f>/)
    if (!marker) return []
    const objects = [...record.matchAll(/(\d+)<\|box;[^|]*\|>/g)].flatMap((match) => {
      const [box] = readSamBoxes(match[0])
      return box ? [{ ...box, id: Number(match[1]) }] : []
    })
    return objects.length ? [{ frame: Number(marker[1]), objects }] : []
  }).sort((a, b) => a.frame - b.frame)
}

/** SAM 3.1 follows what the phrase names through a whole clip, keeping each object's identity. */
export async function samTrack(video: string, phrase: string): Promise<SamFrame[]> {
  countCall()
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: config.samModel, stream: true, metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }, { type: 'input_video', video_url: video }] }],
    }),
    signal: AbortSignal.timeout(90000),
  })
  if (!response.ok) throw await failure(response)
  const text = (await response.text()).split('\n').filter((line) => line.startsWith('data:')).flatMap((line) => {
    try {
      const data = JSON.parse(line.slice(5).trim())
      return data.type === 'response.output_text.delta' ? [String(data.delta ?? '')] : []
    } catch { return [] }
  }).join('')
  return readSamFrames(text)
}

/** SAM 3.1 finds every match for a short noun phrase in one image. Pass the image as a data URL. */
export async function samFind(image: string, phrase: string): Promise<SamBox[]> {
  countCall()
  return withRetries(async () => {
    const response = await fetch(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: config.samModel, stream: true, metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }, { type: 'input_image', image_url: image }] }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw await failure(response)
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
    const text = events.flatMap((event) => {
      try {
        const data = JSON.parse(event)
        return data.type === 'response.output_text.delta' ? [String(data.delta ?? '')] : []
      } catch { return [] }
    }).join('')
    return readSamBoxes(text)
  })
}
