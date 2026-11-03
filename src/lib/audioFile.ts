import { t } from './i18n'
import { wavFrom } from './recorder'

const RATE = 24000
const LIMIT_SECONDS = 30 * 60

/** The browser decodes whatever it can play (m4a, mp3, ogg, wav), so the server only ever sees one format. */
export async function toCallWav(file: File) {
  const context = new OfflineAudioContext(1, 1, RATE)
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer())
  } catch {
    throw new Error(t("This browser can't read that file. Try an m4a, mp3 or wav recording."))
  }
  if (decoded.duration > LIMIT_SECONDS) throw new Error(t('That recording is longer than 30 minutes.'))
  const pcm = new Int16Array(decoded.length)
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const data = decoded.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, data[index]))
      pcm[index] += Math.round((sample * 32767) / decoded.numberOfChannels)
    }
  }
  return wavFrom([pcm.buffer])
}
