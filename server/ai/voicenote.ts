import fs from 'node:fs'
import { OggOpusDecoder } from 'ogg-opus-decoder'
import { SAMPLE_RATE, wavHeader } from './wav.ts'

/** A WhatsApp voice note is Ogg Opus at 48 kHz. Muse Voice Transcribe takes mono 16-bit WAV at 24 kHz. */
export async function voiceNoteToWav(ogg: Uint8Array, wavFile: string) {
  const decoder = new OggOpusDecoder()
  await decoder.ready
  try {
    const { channelData, samplesDecoded, sampleRate } = await decoder.decodeFile(ogg)
    if (!samplesDecoded) throw new Error('That voice note has no sound in it.')
    const left = channelData[0]
    const right = channelData[1] ?? left
    const step = sampleRate / SAMPLE_RATE
    const length = Math.floor(samplesDecoded / step)
    const pcm = Buffer.alloc(length * 2)
    for (let index = 0; index < length; index += 1) {
      const from = Math.floor(index * step)
      const to = Math.max(from + 1, Math.floor((index + 1) * step))
      let sum = 0
      for (let at = from; at < to; at += 1) sum += (left[at] + right[at]) / 2
      const sample = Math.max(-1, Math.min(1, sum / (to - from)))
      pcm.writeInt16LE(Math.round(sample * 32767), index * 2)
    }
    fs.writeFileSync(wavFile, Buffer.concat([wavHeader(pcm.length), pcm]))
  } finally {
    decoder.free()
  }
}
