import fs from 'node:fs'
import path from 'node:path'
import { insert, nowIso } from '../core/db.ts'
import { samFind, samTrack, sparkJson, type ContentPart, type SamBox, type SamFrame } from '../ai/meta.ts'
import { localFile, signedUrl, storageReady } from '../core/files.ts'
import { itemFor } from '../operations/checklists.ts'
import { languageName } from '../core/lang.ts'
import { proofPrompt, proofSchema, proofTargetPrompt, proofTargetSchema, type ExtractedProof } from '../ai/prompts.ts'

const MIME: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp' }
const dataUrl = async (file: string) => `data:${MIME[path.extname(file).toLowerCase()] ?? 'image/jpeg'};base64,${fs.readFileSync(await localFile(file)).toString('base64')}`

/** Worked out once when a list is saved, so SAM has a short noun phrase to look for. */
export async function proofTargetFor(label: string, hint: string | null) {
  try {
    const { target } = await sparkJson<{ target: string }>({
      name: 'proof_target', schema: proofTargetSchema, system: proofTargetPrompt, effort: 'minimal', timeoutMs: 20000,
      content: [{ type: 'text', text: `Check: ${label}\nThe photo should show: ${hint ?? 'not stated'}` }],
    })
    return target.trim().slice(0, 40) || null
  } catch (error) {
    console.error('proof target:', (error as Error).message)
    return null
  }
}

/** SAM reads MP4 and MOV, not WebM. Anything longer than this waits too long at a kitchen counter. */
const SAM_VIDEO = /\.(mp4|mov)$/i
const LARGEST_VIDEO = 50 * 1024 * 1024
const COMMON_FPS = 30
const TRACK_POINTS = 150

/**
 * SAM doesn't say how long a clip is and skips empty frames, so the count comes from the file.
 * A clip fresh from a browser recorder doesn't list its frames and returns 0.
 */
export function mp4FrameCount(bytes: Buffer) {
  const boxes = (start: number, end: number) => {
    const found: Array<{ type: string; start: number; end: number }> = []
    for (let at = start; at + 8 <= end;) {
      let size = bytes.readUInt32BE(at)
      let header = 8
      if (size === 1) { size = Number(bytes.readBigUInt64BE(at + 8)); header = 16 }
      if (size === 0) size = end - at
      if (size < header || at + size > end) break
      found.push({ type: bytes.toString('latin1', at + 4, at + 8), start: at + header, end: at + size })
      at += size
    }
    return found
  }
  const inside = (parent: { start: number; end: number } | undefined, type: string) => (parent ? boxes(parent.start, parent.end).find((box) => box.type === type) : undefined)
  const movie = boxes(0, bytes.length).find((box) => box.type === 'moov')
  if (!movie) return 0
  for (const track of boxes(movie.start, movie.end).filter((box) => box.type === 'trak')) {
    const media = inside(track, 'mdia')
    const handler = inside(media, 'hdlr')
    if (!handler || bytes.toString('latin1', handler.start + 8, handler.start + 12) !== 'vide') continue
    const sizes = inside(inside(inside(media, 'minf'), 'stbl'), 'stsz')
    return sizes ? bytes.readUInt32BE(sizes.start + 8) : 0
  }
  return 0
}

/** How much of the clip SAM followed the thing through, with a short path to draw over the video. */
export function summariseTrack(frames: SamFrame[], seconds: number, frameCount = 0) {
  if (!frames.length) return { seen: 0, total: 0, share: 0, objects: 0, fps: COMMON_FPS, path: [] as Array<{ t: number; boxes: SamBox[] }>, seenAt: (_fraction: number) => false }
  const last = frames[frames.length - 1].frame
  const total = Math.max(frameCount || Math.round(seconds * COMMON_FPS), last + 1)
  const fps = seconds > 0 ? total / seconds : COMMON_FPS
  const step = Math.max(1, Math.ceil(frames.length / TRACK_POINTS))
  const nearby = Math.max(1, Math.round(total * 0.06))
  return {
    seen: frames.length, total, fps,
    share: Math.min(100, Math.round((frames.length / total) * 100)),
    objects: new Set(frames.flatMap((frame) => frame.objects.map((object) => object.id))).size,
    path: frames.filter((_frame, index) => index % step === 0).map((frame) => ({ t: Number((frame.frame / fps).toFixed(2)), boxes: frame.objects.slice(0, 8) })),
    seenAt: (fraction: number) => frames.some((frame) => Math.abs(frame.frame - fraction * total) <= nearby),
  }
}

/**
 * The clip ready to send to SAM with its real frame count, or null if SAM can't read it.
 * The count needs the file itself, because the frame list can sit at the very end of it.
 * With Storage, SAM gets a short-lived link rather than the whole clip as text.
 */
export async function clipForSam(file: string) {
  if (!SAM_VIDEO.test(file)) return null
  const full = await localFile(file)
  if (!fs.existsSync(full) || fs.statSync(full).size > LARGEST_VIDEO) return null
  const bytes = fs.readFileSync(full)
  const asData = () => `data:${/\.mov$/i.test(file) ? 'video/quicktime' : 'video/mp4'};base64,${bytes.toString('base64')}`
  return { data: storageReady() ? await signedUrl(file, 'uploads', 600) : asData(), asData, linked: storageReady(), frames: mp4FrameCount(bytes) }
}

/** Follows the phrase through a clip. If SAM won't take the link, it gets the clip itself. */
export async function trackClip(clip: NonNullable<Awaited<ReturnType<typeof clipForSam>>>, phrase: string) {
  try {
    return await samTrack(clip.data, phrase)
  } catch (error) {
    if (!clip.linked) throw error
    console.error('sam video link:', (error as Error).message)
    return samTrack(clip.asData(), phrase)
  }
}

async function followInVideo(file: string, target: string, seconds: number) {
  const clip = await clipForSam(file)
  if (!clip) return null
  try {
    return summariseTrack(await trackClip(clip, target), seconds, clip.frames)
  } catch (error) {
    console.error('sam video:', (error as Error).message)
    return null
  }
}

/** SAM can see a digital thermometer as a plain screen, so it gets a second look under that name. */
const OTHER_NAMES: Record<string, string> = { thermometer: 'digital display' }

/**
 * SAM finds the thing in the picture and Muse Spark judges it. Neither saves anything:
 * the worker sees the suggestion and decides, and a saved "recheck" goes to the owner.
 */
export async function checkProof(input: { runId: number; itemId: number; frames: string[]; videoFile: string | null; seconds?: number }) {
  const item = await itemFor(input.runId, input.itemId)
  if (!item) return null
  const target = (item.proof_target as string | null) ?? null
  const otherName = target ? OTHER_NAMES[target] : undefined
  let boxes: SamBox[] = []
  let track = target && input.videoFile ? await followInVideo(input.videoFile, target, input.seconds ?? 0) : null
  if (track && !track.seen && otherName) track = await followInVideo(input.videoFile!, otherName, input.seconds ?? 0) ?? track
  if (target && !track) {
    try {
      const picture = await dataUrl(input.frames[0])
      boxes = await samFind(picture, target)
      if (!boxes.length && otherName) boxes = await samFind(picture, otherName)
    } catch (error) { console.error('sam:', (error as Error).message) }
  }
  const found = track
    ? (track.seen ? `SAM 3.1 followed "${target}" through the video: visible in about ${track.share}% of it, ${track.objects} separate object(s).` : `SAM 3.1 could not find "${target}" anywhere in the video.`)
    : target ? `SAM 3.1 looked for "${target}" in the first picture and found ${boxes.length}.` : ''
  // The stills are spaced evenly through the clip, so the ones showing the thing are the ones worth judging.
  const useful = track ? input.frames.filter((_file, index) => track.seenAt((index + 0.5) / input.frames.length)) : input.frames
  const pictures = useful.length ? useful : input.frames
  const shown = track ? { share: track.share, objects: track.objects, path: track.path } : null
  const content: ContentPart[] = [
    { type: 'text', text: `Check: ${item.label}\nThe photos should show: ${item.proof_hint ?? item.label}\n${found}\nWrite the reason in ${languageName()}.` },
    ...await Promise.all(pictures.map(async (file): Promise<ContentPart> => ({ type: 'image_url', image_url: { url: await dataUrl(file) } }))),
  ]
  const { verdict, reason, reading } = await sparkJson<ExtractedProof>({ name: 'proof_check', schema: proofSchema, system: proofPrompt, content, effort: 'low', timeoutMs: 45000 })
  const id = await insert('INSERT INTO proof_checks (run_id, item_id, file, video_file, verdict, reason, target, boxes, track, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    input.runId, input.itemId, input.frames[0], input.videoFile, verdict, reason.slice(0, 300), target, JSON.stringify(boxes.slice(0, 8)), shown ? JSON.stringify(shown) : null, nowIso())
  return { proofId: id, itemId: input.itemId, label: item.label, type: item.check_type, unit: item.unit, reading, verdict, reason, target, boxes: boxes.slice(0, 8), file: input.frames[0], video: input.videoFile, track: shown }
}
