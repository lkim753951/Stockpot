import { useEffect, useRef, useState } from 'react'
import { Camera, FolderOpen, ImageSquare, Record, Stop, VideoCamera } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { rememberStills, stillOf } from '../lib/media'
import { t } from '../lib/i18n'
import { ErrorNote, Sheet } from './ui'

const LONGEST_CLIP_SECONDS = 30
const STILL_EVERY_SECONDS = 2
const CLIP_BITS_PER_SECOND = 2500000
const LIVE_SECONDS = 60
const LIVE_PAUSE_MS = 700
const LIVE_WIDTH = 480

type LiveTarget = { what: string; item: string }
type LiveBox = { x1: number; y1: number; x2: number; y2: number }

/** A phone's own camera app is better than anything in a page. A computer gets a camera right here. */
const hasCameraApp = () => navigator.maxTouchPoints > 0

/** SAM looks at one small frame at a time while the camera is open, so the boxes follow within a second or two. */
function useLiveFind(preview: React.RefObject<HTMLVideoElement | null>, target?: LiveTarget) {
  const [seen, setSeen] = useState<{ boxes: LiveBox[]; width: number; height: number } | null>(null)
  const what = target?.what
  const item = target?.item
  useEffect(() => {
    if (item === undefined) return
    let stopped = false
    const started = Date.now()
    const canvas = document.createElement('canvas')
    const look = async () => {
      while (!stopped && Date.now() - started < LIVE_SECONDS * 1000) {
        const video = preview.current
        if (video?.videoWidth) {
          canvas.width = LIVE_WIDTH
          canvas.height = Math.round((LIVE_WIDTH * video.videoHeight) / video.videoWidth)
          canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
          try {
            const found = await api('/api/staff/live-find', { body: { image: canvas.toDataURL('image/jpeg', 0.6), what, item } })
            if (!stopped) setSeen({ boxes: found.boxes, width: canvas.width, height: canvas.height })
          } catch { break }
        }
        await new Promise((done) => setTimeout(done, LIVE_PAUSE_MS))
      }
      if (!stopped) setSeen(null)
    }
    look()
    return () => { stopped = true }
  }, [preview, what, item])
  return seen
}

function Camcorder({ mode, live, onFile, onBack }: { mode: 'photo' | 'video'; live?: LiveTarget; onFile: (file: File) => void; onBack: () => void }) {
  const preview = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stills = useRef<Blob[]>([])
  const started = useRef(0)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seen = useLiveFind(preview, mode === 'video' ? live : undefined)

  useEffect(() => {
    let closed = false
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: mode === 'video' })
      .then((media) => {
        if (closed) return media.getTracks().forEach((track) => track.stop())
        stream.current = media
        if (preview.current) preview.current.srcObject = media
      })
      .catch(() => setError(t('Allow the camera in your browser, then try again.')))
    return () => {
      closed = true
      stream.current?.getTracks().forEach((track) => track.stop())
    }
  }, [mode])

  useEffect(() => {
    if (seconds === null) return
    if (seconds >= LONGEST_CLIP_SECONDS) { void finish(); return }
    if (seconds % STILL_EVERY_SECONDS === 0) void grab()
    const timer = setTimeout(() => setSeconds(seconds + 1), 1000)
    return () => clearTimeout(timer)
  }, [seconds])

  const grab = async () => {
    const video = preview.current
    if (video?.videoWidth) stills.current.push(await stillOf(video).catch(() => null) as Blob)
    stills.current = stills.current.filter(Boolean)
  }

  const finish = async () => {
    if (recorder.current?.state !== 'recording') return
    const media = recorder.current
    await grab()
    if (media.state === 'recording') media.stop()
  }

  const snap = () => {
    const video = preview.current!
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    canvas.toBlob((blob) => blob && onFile(new File([blob], 'photo.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.9)
  }

  const record = () => {
    // SAM reads H.264 in MP4 and can't read WebM, so ask for that first.
    const type = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm'].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
    const chunks: Blob[] = []
    const media = new MediaRecorder(stream.current!, { videoBitsPerSecond: CLIP_BITS_PER_SECOND, ...(type ? { mimeType: type } : {}) })
    media.ondataavailable = (event) => chunks.push(event.data)
    media.onstop = () => {
      const kind = media.mimeType.split(';')[0] || 'video/webm'
      const file = new File(chunks, `video.${kind.includes('mp4') ? 'mp4' : 'webm'}`, { type: kind })
      if (!file.size) { setSeconds(null); return setError(t("That didn't work. Try again.")) }
      rememberStills(file, stills.current, (performance.now() - started.current) / 1000)
      onFile(file)
    }
    stills.current = []
    started.current = performance.now()
    media.start()
    recorder.current = media
    setSeconds(0)
  }

  return (
    <div className="camcorder">
      <div className="camcorder-view">
        <video ref={preview} autoPlay muted playsInline aria-label={t('Camera preview')} />
        {seen ? (
          <>
            <svg className="live-boxes" viewBox={`0 0 ${seen.width} ${seen.height}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
              {seen.boxes.map((box, index) => <rect key={index} x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} rx={6} />)}
            </svg>
            <p className="live-count" role="status">{t('Seeing {count} now', { count: seen.boxes.length })}</p>
          </>
        ) : null}
      </div>
      <ErrorNote message={error} />
      {mode === 'photo'
        ? <button className="btn primary block" type="button" disabled={!!error} onClick={snap}><Camera size={24} aria-hidden="true" />{t('Take the photo')}</button>
        : seconds === null
          ? <button className="btn primary block" type="button" disabled={!!error} onClick={record}><Record size={24} weight="fill" aria-hidden="true" />{t('Start recording')}</button>
          : <button className="btn danger block" type="button" onClick={() => void finish()}><Stop size={24} weight="fill" aria-hidden="true" />{t('Stop, {seconds}s', { seconds })}</button>}
      <button className="btn text block" type="button" onClick={onBack}>{t('Back')}</button>
    </div>
  )
}

/** One way to add a picture everywhere in the app: take a photo, record a video, or pick a file. */
export function EvidenceSheet({ title, hint, live, onFile, onClose, sample = false, videoOnly = false }: { title: string; live?: LiveTarget; hint?: string | null; onFile: (file: File) => void; onClose: () => void; videoOnly?: boolean; sample?: boolean }) {
  const photoInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [camera, setCamera] = useState<'photo' | 'video' | null>(null)
  const take = (file?: File) => { if (file) onFile(file) }
  const open = (mode: 'photo' | 'video') => (hasCameraApp() && !(live && mode === 'video') ? (mode === 'photo' ? photoInput : videoInput).current?.click() : setCamera(mode))
  const useSample = async () => {
    const blob = await (await fetch('/samples/sample-thermometer.png')).blob()
    onFile(new File([blob], 'sample-thermometer.png', { type: 'image/png' }))
  }

  return (
    <Sheet title={title} onClose={onClose}>
      {hint ? <p className="muted">{hint}</p> : null}
      {camera ? <Camcorder mode={camera} live={live} onFile={onFile} onBack={() => setCamera(null)} /> : (
        <div className="evidence-options">
          {videoOnly ? null : <button className="tile-btn" type="button" onClick={() => open('photo')}><Camera size={32} aria-hidden="true" />{t('Take a photo')}</button>}
          <button className="tile-btn" type="button" onClick={() => open('video')}><VideoCamera size={32} aria-hidden="true" />{t('Record a video')}</button>
          <button className="tile-btn" type="button" onClick={() => fileInput.current?.click()}><FolderOpen size={32} aria-hidden="true" />{t('Choose a file')}</button>
          {sample ? <button className="tile-btn" type="button" onClick={useSample}><ImageSquare size={32} aria-hidden="true" />{t('Use a sample photo')}</button> : null}
        </div>
      )}
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => take(event.target.files?.[0])} />
      <input ref={videoInput} type="file" accept="video/*" capture="environment" hidden onChange={(event) => take(event.target.files?.[0])} />
      <input ref={fileInput} type="file" accept={videoOnly ? 'video/*' : 'image/*,video/*'} hidden onChange={(event) => take(event.target.files?.[0])} />
    </Sheet>
  )
}
