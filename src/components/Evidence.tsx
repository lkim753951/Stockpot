import { useEffect, useRef, useState } from 'react'
import { Camera, FolderOpen, ImageSquare, Record, Stop, VideoCamera } from '@phosphor-icons/react'
import { t } from '../lib/i18n'
import { ErrorNote, Sheet } from './ui'

const LONGEST_CLIP_SECONDS = 30

/** A phone's own camera app is better than anything in a page. A computer gets a camera right here. */
const hasCameraApp = () => navigator.maxTouchPoints > 0

function Camcorder({ mode, onFile, onBack }: { mode: 'photo' | 'video'; onFile: (file: File) => void; onBack: () => void }) {
  const preview = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    if (seconds >= LONGEST_CLIP_SECONDS) { recorder.current?.stop(); return }
    const timer = setTimeout(() => setSeconds(seconds + 1), 1000)
    return () => clearTimeout(timer)
  }, [seconds])

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
    const media = new MediaRecorder(stream.current!, type ? { mimeType: type } : undefined)
    media.ondataavailable = (event) => chunks.push(event.data)
    media.onstop = () => {
      const kind = media.mimeType.split(';')[0] || 'video/webm'
      onFile(new File(chunks, `video.${kind.includes('mp4') ? 'mp4' : 'webm'}`, { type: kind }))
    }
    media.start()
    recorder.current = media
    setSeconds(0)
  }

  return (
    <div className="camcorder">
      <video ref={preview} autoPlay muted playsInline aria-label={t('Camera preview')} />
      <ErrorNote message={error} />
      {mode === 'photo'
        ? <button className="btn primary block" type="button" disabled={!!error} onClick={snap}><Camera size={24} aria-hidden="true" />{t('Take the photo')}</button>
        : seconds === null
          ? <button className="btn primary block" type="button" disabled={!!error} onClick={record}><Record size={24} weight="fill" aria-hidden="true" />{t('Start recording')}</button>
          : <button className="btn danger block" type="button" onClick={() => recorder.current?.stop()}><Stop size={24} weight="fill" aria-hidden="true" />{t('Stop, {seconds}s', { seconds })}</button>}
      <button className="btn text block" type="button" onClick={onBack}>{t('Back')}</button>
    </div>
  )
}

/** One way to add a picture everywhere in the app: take a photo, record a video, or pick a file. */
export function EvidenceSheet({ title, hint, onFile, onClose, sample = false, videoOnly = false }: { title: string; hint?: string | null; onFile: (file: File) => void; onClose: () => void; videoOnly?: boolean; sample?: boolean }) {
  const photoInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [camera, setCamera] = useState<'photo' | 'video' | null>(null)
  const take = (file?: File) => { if (file) onFile(file) }
  const open = (mode: 'photo' | 'video') => (hasCameraApp() ? (mode === 'photo' ? photoInput : videoInput).current?.click() : setCamera(mode))
  const useSample = async () => {
    const blob = await (await fetch('/samples/sample-thermometer.png')).blob()
    onFile(new File([blob], 'sample-thermometer.png', { type: 'image/png' }))
  }

  return (
    <Sheet title={title} onClose={onClose}>
      {hint ? <p className="muted">{hint}</p> : null}
      {camera ? <Camcorder mode={camera} onFile={onFile} onBack={() => setCamera(null)} /> : (
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
