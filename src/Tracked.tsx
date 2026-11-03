import { useRef, useState } from 'react'

/**
 * The clip plays with SAM's boxes following what it found, so a person can see what it looked at.
 * Boxes that carry a number show it, which lets a worker check a count against the picture.
 */
export function TrackedVideo({ src, path, label }: { src: string; path: any[]; label: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [boxes, setBoxes] = useState<any[]>([])
  const follow = () => {
    const at = video.current?.currentTime ?? 0
    const point = [...path].reverse().find((row) => row.t <= at + 0.05)
    setBoxes(point && at - point.t < 0.6 ? point.boxes : [])
    if (video.current && !video.current.paused) requestAnimationFrame(follow)
  }
  return (
    <div className="proof-image tracked">
      <video ref={video} src={src} controls playsInline muted aria-label={label} onPlay={follow} onSeeked={follow} onLoadedData={follow} />
      {boxes.map((box) => (
        <i key={box.id} aria-hidden="true" data-n={box.n} style={{ left: `${(box.x1 / box.w) * 100}%`, top: `${(box.y1 / box.h) * 100}%`, width: `${((box.x2 - box.x1) / box.w) * 100}%`, height: `${((box.y2 - box.y1) / box.h) * 100}%` }} />
      ))}
    </div>
  )
}
