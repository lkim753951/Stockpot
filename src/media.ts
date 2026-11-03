import { t } from './i18n'

const LONGEST_SIDE = 1600
const VIDEO_FRAMES = 4

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

async function videoFrames(file: File) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error(t("This browser can't open that video. Try a photo instead.")))
    })
    // A clip fresh from the recorder doesn't know its length until the browser seeks past the end.
    if (!Number.isFinite(video.duration)) await seek(video, 1e7)
    const seconds = Number.isFinite(video.duration) ? video.duration : 0
    const frames: Blob[] = []
    for (let index = 0; index < VIDEO_FRAMES; index += 1) {
      await seek(video, seconds * ((index + 0.5) / VIDEO_FRAMES))
      frames.push(await canvasOf(video, video.videoWidth, video.videoHeight))
    }
    return { frames, seconds }
  } finally {
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
  const { frames, seconds } = isVideo ? await videoFrames(file) : { frames: await photoFrame(file), seconds: 0 }
  const form = new FormData()
  frames.forEach((frame, index) => form.append('frames', frame, `frame-${index}.jpg`))
  if (isVideo) {
    form.append('video', file, file.name || 'proof.mp4')
    form.append('seconds', String(seconds))
  }
  Object.entries(extra).forEach(([key, value]) => form.append(key, value))
  return form
}
