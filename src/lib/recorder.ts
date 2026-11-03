import { t } from './i18n'
import { useEffect, useRef, useState } from 'react'

const RATE = 24000

export function wavFrom(chunks: ArrayBuffer[]) {
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const header = new DataView(new ArrayBuffer(44))
  const text = (offset: number, value: string) => [...value].forEach((letter, index) => header.setUint8(offset + index, letter.charCodeAt(0)))
  text(0, 'RIFF'); header.setUint32(4, 36 + bytes, true); text(8, 'WAVEfmt ')
  header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true)
  header.setUint32(24, RATE, true); header.setUint32(28, RATE * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true)
  text(36, 'data'); header.setUint32(40, bytes, true)
  return new Blob([header.buffer, ...chunks], { type: 'audio/wav' })
}

/** Records a short spoken clip in the format Muse Voice Transcribe takes: mono 16-bit WAV at 24 kHz. */
export function useRecorder(limitSeconds: number, onClip: (clip: Blob) => void) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const stopper = useRef<(() => void) | null>(null)

  useEffect(() => () => stopper.current?.(), [])

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const context = new AudioContext({ sampleRate: RATE })
      await context.audioWorklet.addModule('/pcm-worklet.js')
      const node = new AudioWorkletNode(context, 'pcm-sender')
      context.createMediaStreamSource(stream).connect(node)
      const chunks: ArrayBuffer[] = []
      node.port.onmessage = ({ data }) => { chunks.push(data.pcm) }
      const began = Date.now()
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - began) / 1000)
        setSeconds(elapsed)
        if (elapsed >= limitSeconds) stopper.current?.()
      }, 250)
      stopper.current = () => {
        stopper.current = null
        clearInterval(timer)
        stream.getTracks().forEach((track) => track.stop())
        void context.close()
        setRecording(false)
        setSeconds(0)
        if (chunks.length) onClip(wavFrom(chunks))
      }
      setRecording(true)
    } catch {
      setError(t('Allow the microphone in your browser, then try again.'))
    }
  }

  return { recording, seconds, error, start, stop: () => stopper.current?.() }
}
