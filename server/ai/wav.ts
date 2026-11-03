import fs from 'node:fs'

export const SAMPLE_RATE = 24000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2

/** Meta's file endpoint stops at 10 minutes, so long calls are split a little before that. */
export const MAX_CHUNK_MS = 9.5 * 60 * 1000

export function wavHeader(dataBytes: number) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

export function pcmToWav(pcmFile: string, wavFile: string) {
  const pcm = fs.readFileSync(pcmFile)
  fs.writeFileSync(wavFile, Buffer.concat([wavHeader(pcm.length), pcm]))
  return Math.round((pcm.length / BYTES_PER_SECOND) * 1000)
}

export function splitWav(wavFile: string): Array<{ file: string; offsetMs: number }> {
  const pcm = fs.readFileSync(wavFile).subarray(44)
  const chunkBytes = (MAX_CHUNK_MS / 1000) * BYTES_PER_SECOND
  if (pcm.length <= chunkBytes) return [{ file: wavFile, offsetMs: 0 }]
  const chunks: Array<{ file: string; offsetMs: number }> = []
  for (let start = 0, index = 0; start < pcm.length; start += chunkBytes, index += 1) {
    const part = pcm.subarray(start, start + chunkBytes)
    const file = wavFile.replace(/\.wav$/, `.part${index}.wav`)
    fs.writeFileSync(file, Buffer.concat([wavHeader(part.length), part]))
    chunks.push({ file, offsetMs: (start / BYTES_PER_SECOND) * 1000 })
  }
  return chunks
}

/** Meta's file endpoint takes mono 16-bit WAV at 16 or 24 kHz. Anything else is refused before it costs a call. */
export function isUsableClip(file: string) {
  const handle = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(44)
    const read = fs.readSync(handle, header, 0, 44, 0)
    if (read < 44 || header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') return false
    const rate = header.readUInt32LE(24)
    return header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 1 && header.readUInt16LE(34) === 16 && (rate === 16000 || rate === 24000)
  } finally {
    fs.closeSync(handle)
  }
}
