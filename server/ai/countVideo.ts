import type { SamBox, SamFrame } from './meta.ts'
import { clipForSam, summariseTrack, trackClip } from '../money/proof.ts'

/** Short noun phrases, because SAM looks for what is named and nothing else. */
const PHRASES: Record<string, string> = { box: 'cardboard box', bag: 'sack', crate: 'plastic crate', bottle: 'bottle' }
export const phraseFor = (what: string, item: string) => PHRASES[what] ?? item.toLowerCase().slice(0, 40)

/** An object seen for a blink is usually a tracking slip, not one more box. */
const SHORTEST_SIGHTING = 3
const SHORTEST_SHARE = 0.03

/**
 * Each object keeps its id while it's in shot, so a pan along a pallet can be counted, which a
 * single photo can't do. An object that leaves and comes back may get a new id, so this is a
 * suggestion for a person to check against the numbers drawn on the video.
 */
export function countObjects(frames: SamFrame[], total: number) {
  const sightings = new Map<number, number>()
  for (const frame of frames) for (const object of frame.objects) sightings.set(object.id, (sightings.get(object.id) ?? 0) + 1)
  const longEnough = Math.max(SHORTEST_SIGHTING, Math.round(total * SHORTEST_SHARE))
  const numbers = new Map<number, number>()
  for (const frame of frames) {
    for (const object of frame.objects) {
      if ((sightings.get(object.id) ?? 0) >= longEnough && !numbers.has(object.id)) numbers.set(object.id, numbers.size + 1)
    }
  }
  const kept = frames.map((frame) => ({ ...frame, objects: frame.objects.filter((object) => numbers.has(object.id)) })).filter((frame) => frame.objects.length)
  return { count: numbers.size, peak: Math.max(0, ...kept.map((frame) => frame.objects.length)), numbers, kept }
}

export async function countInVideo(file: string, phrase: string, seconds: number) {
  const clip = await clipForSam(file)
  if (!clip) return null
  const frames = await trackClip(clip, phrase)
  const span = clip.frames || (frames.at(-1)?.frame ?? 0) + 1
  const { count, peak, numbers, kept } = countObjects(frames, span)
  const { fps } = summariseTrack(frames, seconds, clip.frames)
  const step = Math.max(1, Math.ceil(kept.length / 180))
  const path = kept.filter((_frame, index) => index % step === 0).map((frame) => ({
    t: Number((frame.frame / fps).toFixed(2)),
    boxes: frame.objects.map((object): SamBox & { id: number; n: number } => ({ ...object, n: numbers.get(object.id)! })),
  }))
  return { count, peak, phrase, track: { path } }
}
