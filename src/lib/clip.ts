import { useEffect, useRef, useState } from 'react'

/** Plays one spoken turn from a saved call, then stops. */
export function useClip(callId: number | null | undefined) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const stopAt = useRef(0)

  useEffect(() => {
    if (!callId) return
    const element = new Audio(`/api/calls/${callId}/audio`)
    element.preload = 'metadata'
    const tick = () => {
      if (element.currentTime * 1000 >= stopAt.current) {
        element.pause()
        setPlaying(null)
      }
    }
    element.addEventListener('timeupdate', tick)
    element.addEventListener('ended', () => setPlaying(null))
    audio.current = element
    return () => { element.pause(); element.removeEventListener('timeupdate', tick) }
  }, [callId])

  return {
    playing,
    play(turn: number, startMs: number, endMs: number) {
      const element = audio.current
      if (!element) return
      if (playing === turn) { element.pause(); setPlaying(null); return }
      stopAt.current = endMs
      element.currentTime = startMs / 1000
      void element.play()
      setPlaying(turn)
    },
  }
}
