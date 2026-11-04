import { t } from './i18n'

const LONGEST_SIDE = 1600
const VIDEO_FRAMES = 4
/** A phone can refuse to open a clip without ever saying so, so the wait has an end. */
const OPEN_WAIT_MS = 10000

/** Stills taken from the camera while recording, so a clip made here never has to be opened again. */
const recorded = new WeakMap<File, { frames: Blob[]; seconds: number }>()

export function rememberStills(file: File, frames: Blob[], seconds: number) {
  const chosen = frames.length <= VIDEO_FRAMES ? frames : Array.from({ length: VIDEO_FRAMES }, (_, index) => frames[Math.floor(((index + 0.5) / VIDEO_FRAMES) * frames.length)])
  recorded.set(file, { frames: chosen, seconds })
}

export const stillOf = (video: HTMLVideoElement) => canvasOf(video, video.videoWidth, video.videoHeight)

function canvasOf(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, LONGEST_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("That picture couldn't be read.")))), 'image/jpeg', 0.85))
}

function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve) => {
    // Some recordings never report that the seek finished, so a still is taken after a moment anyway.
    const timer = setTimeout(resolve, 1500)
    video.onseeked = () => { clearTimeout(timer); resolve() }
    video.currentTime = time
  })
}

/** iPhones ignore preload on a video that isn't on the page and isn't playing, so this does both. */
function opened(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    const cannot = () => { clearTimeout(timer); reject(new Error(t("This browser can't open that video. Try a photo instead."))) }
    const ready = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(cannot, OPEN_WAIT_MS)
    video.addEventListener('loadeddata', ready, { once: true })
    video.addEventListener('canplay', ready, { once: true })
    video.addEventListener('error', cannot, { once: true })
    video.load()
    void video.play().catch(() => undefined)
  })
}

async function videoFrames(file: File) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.setAttribute('aria-hidden', 'true')
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'
  video.src = URL.createObjectURL(file)
  document.body.append(video)
  try {
    await opened(video)
    video.pause()
    // A clip fresh from the recorder doesn't know its length until the browser seeks past the end.
    if (!Number.isFinite(video.duration)) await seek(video, 1e7)
    const seconds = Number.isFinite(video.duration) ? video.duration : 0
    const frames: Blob[] = []
    for (let index = 0; index < VIDEO_FRAMES; index += 1) {
      await seek(video, seconds * ((index + 0.5) / VIDEO_FRAMES))
      frames.push(await stillOf(video))
    }
    return { frames, seconds }
  } finally {
    video.remove()
    URL.revokeObjectURL(video.src)
  }
}

async function photoFrame(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(t("That picture couldn't be read.")) })
  const frame = await canvasOf(bitmap, bitmap.width, bitmap.height)
  bitmap.close()
  return [frame]
}

/** Shrinks a photo, or takes four stills from a video, so a model only ever sees a few small images. */
export async function evidenceForm(file: File, extra: Record<string, string> = {}) {
  const isVideo = file.type.startsWith('video/')
  const made = isVideo ? recorded.get(file) : null
  const { frames, seconds } = made?.frames.length ? made : isVideo ? await videoFrames(file) : { frames: await photoFrame(file), seconds: 0 }
  const form = new FormData()
  frames.forEach((frame, index) => form.append('frames', frame, `frame-${index}.jpg`))
  if (isVideo) {
    form.append('video', file, file.name || 'proof.mp4')
    form.append('seconds', String(seconds))
  }
  Object.entries(extra).forEach(([key, value]) => form.append(key, value))
  return form
}
