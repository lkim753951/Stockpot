/**
 * Keeps one call going across connections. A hosted socket can last no more than 300 seconds, and it
 * can be cut with no warning at all, so a new one opens well before that and a dropped one comes straight back.
 * Audio is held here until the server says it's saved, so a connection lost mid-sentence loses nothing.
 */

export type LinkEvent = { type: string; [key: string]: any }

interface Socket {
  binaryType: string
  readyState: number
  onmessage: ((event: { data: any }) => void) | null
  onclose: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
  send(data: any): void
  close(): void
}

interface Options {
  /** How long one connection is used. Below the platform's limit, with room to spare. Zero turns it off. */
  rotateMs?: number
  open?: (url: string) => Socket
}

const OPEN = 1
const ROTATE_MS = 240000
const FIRST_RETRY_MS = 250
const LONGEST_RETRY_MS = 4000
/** About two minutes of trying before the screen stops waiting. The server still writes up what it has. */
const TRIES_BEFORE_GIVING_UP = 30

export class CallLink {
  private current: Socket | null = null
  private joining: Socket | null = null
  private leaving: Socket | null = null
  /** Audio not yet confirmed as saved, each block with where it starts in the call. */
  private held: Array<{ at: number; pcm: ArrayBuffer }> = []
  private produced = 0
  private sent = 0
  private saved = 0
  private tries = 0
  private ending = false
  private closed = false
  private rotateTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly rotateMs: number
  private readonly openSocket: (url: string) => Socket

  constructor(private readonly url: string, private readonly onEvent: (event: LinkEvent) => void, options: Options = {}) {
    this.rotateMs = options.rotateMs ?? ROTATE_MS
    this.openSocket = options.open ?? ((address) => new WebSocket(address) as unknown as Socket)
    this.connect()
  }

  send(pcm: ArrayBuffer) {
    this.held.push({ at: this.produced, pcm })
    this.produced += pcm.byteLength
    if (this.current?.readyState === OPEN) {
      this.current.send(pcm)
      this.sent = this.produced
    }
  }

  /** Waits for a connection if there isn't one, so the last words still arrive. */
  end() {
    this.ending = true
    clearTimeout(this.rotateTimer)
    if (this.current?.readyState === OPEN && !this.joining) this.current.send(JSON.stringify({ type: 'end' }))
  }

  close() {
    this.closed = true
    clearTimeout(this.rotateTimer)
    clearTimeout(this.retryTimer)
    this.joining?.close()
    this.current?.close()
  }

  private connect() {
    if (this.closed || this.joining) return
    const socket = this.openSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.joining = socket
    socket.onmessage = (message) => this.heard(socket, JSON.parse(message.data))
    socket.onerror = () => undefined
    socket.onclose = () => this.gone(socket)
  }

  private heard(socket: Socket, event: LinkEvent) {
    if (event.type === 'saved') {
      this.saved = Math.max(this.saved, event.bytes)
      this.held = this.held.filter(({ at, pcm }) => at + pcm.byteLength > this.saved)
    }
    if (event.type === 'listening' && socket === this.joining) return this.joined(socket, event)
    if (event.type !== 'saved') this.onEvent(event)
  }

  /** The new connection is ready. With the old one still up, it hands over cleanly. If not, what wasn't saved goes again. */
  private joined(socket: Socket, event: LinkEvent) {
    const old = this.current?.readyState === OPEN ? this.current : null
    const from = old ? this.sent : Math.max(event.saved ?? 0, this.saved)
    const coming = !!this.tries
    this.joining = null
    this.current = socket
    this.tries = 0
    socket.send(JSON.stringify({ type: 'from', offset: from }))
    if (old) {
      this.leaving = old
      old.send(JSON.stringify({ type: 'handover' }))
    } else {
      for (const { at, pcm } of this.held) {
        if (at + pcm.byteLength <= from) continue
        socket.send(at >= from ? pcm : pcm.slice(from - at))
      }
    }
    this.sent = this.produced
    this.onEvent(event)
    if (coming) this.onEvent({ type: 'reconnected' })
    clearTimeout(this.rotateTimer)
    if (this.ending) socket.send(JSON.stringify({ type: 'end' }))
    else if (this.rotateMs) this.rotateTimer = setTimeout(() => this.connect(), this.rotateMs)
  }

  private gone(socket: Socket) {
    if (socket === this.joining) this.joining = null
    if (this.closed) return
    if (socket !== this.current && this.current?.readyState === OPEN) {
      // Handing over failed, or an old connection has finished. The current one is still fine, so a new try can wait.
      if (!this.joining && !this.ending && this.rotateMs && socket !== this.leaving) this.rotateTimer = setTimeout(() => this.connect(), 10000)
      if (socket === this.leaving) this.leaving = null
      return
    }
    if (socket === this.current) this.current = null
    clearTimeout(this.rotateTimer)
    if (this.joining) return
    this.tries += 1
    if (this.tries > TRIES_BEFORE_GIVING_UP) return this.onEvent({ type: 'lost' })
    if (this.tries === 1 && !this.ending) this.onEvent({ type: 'reconnecting' })
    const wait = Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** (this.tries - 1))
    this.retryTimer = setTimeout(() => this.connect(), wait)
  }
}
