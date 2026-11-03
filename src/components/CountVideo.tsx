import { useState } from 'react'
import { VideoCamera } from '@phosphor-icons/react'
import { EvidenceSheet } from './Evidence'
import { api } from '../lib/api'
import { t, tk } from '../lib/i18n'
import { evidenceForm } from '../lib/media'
import { Mascot } from './Mascot'
import { TrackedVideo } from './Tracked'
import { ErrorNote, Sheet } from './ui'

const THINGS = [{ value: 'box', label: tk('Boxes') }, { value: 'bag', label: tk('Bags') }, { value: 'crate', label: tk('Crates') }, { value: 'bottle', label: tk('Bottles') }, { value: 'item', label: tk('Each item') }]

/** A pan along the delivery becomes a number. Nothing changes until the worker uses it. */
export function CountVideo({ orderId, line, sample, addedBy, onUse, onMedia, onClose }: {
  orderId: string; line: any; sample: boolean; addedBy: string; onUse: (quantity: number) => void; onMedia: (media: any[]) => void; onClose: () => void
}) {
  const [what, setWhat] = useState('box')
  const [pack, setPack] = useState(line.packSize ? String(line.packSize) : '')
  const [filming, setFilming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const each = what === 'item' || line.unit === 'each' ? 1 : Number(pack)
  const unit = line.unit === 'each' ? t('each') : line.unit

  const run = async (work: () => Promise<any>, clip: (found: any) => string) => {
    setBusy(true)
    setError(null)
    try {
      const found = await work()
      onMedia(found.media)
      setResult({ ...found, clip: clip(found) })
    } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const fields = { itemId: String(line.itemId), what, addedBy }
  const film = async (file: File) => {
    setFilming(false)
    const local = URL.createObjectURL(file)
    await run(async () => api(`/api/staff/deliveries/${orderId}/count`, { form: await evidenceForm(file, fields) }), () => local)
  }
  const useSample = () => run(() => api(`/api/staff/deliveries/${orderId}/count-sample`, { body: fields }), (found) => `/api/staff/delivery-media/${found.video}`)

  if (filming) return <EvidenceSheet title={t('Record the delivery')} onFile={film} onClose={() => setFilming(false)} videoOnly />
  return (
    <Sheet title={t('Count on video')} onClose={onClose}>
      {busy ? <div className="count-busy"><Mascot size={64} thinking /><p>{t('Counting on the video')}</p></div> : null}
      {!busy && result ? (
        <div className="stack">
          <p className="count-number">{result.count}</p>
          <TrackedVideo src={result.clip} path={result.track.path} label={t('Video of {name}', { name: t('the delivery') })} />
          <p className="caption">{t('Check the numbers on the video before you use this.')}</p>
          {each > 0 ? <p><strong>{t('{count} × {pack} {unit} = {total} {unit}', { count: result.count, pack: each, unit, total: Number((result.count * each).toFixed(3)) })}</strong> {t('Expected {expected} {unit}', { expected: line.expected, unit })}</p> : null}
          <button className="btn primary block" type="button" disabled={!(each > 0)} onClick={() => onUse(Number((result.count * each).toFixed(3)))}>{t('Use this count')}</button>
          <button className="btn text block" type="button" onClick={() => setResult(null)}>{t('Take it again')}</button>
        </div>
      ) : null}
      {!busy && !result ? (
        <div className="stack">
          <h3>{t('What are you counting?')}</h3>
          <div className="issue-picks place-picks" role="group" aria-label={t('What are you counting?')}>
            {THINGS.map((thing) => <button type="button" key={thing.value} aria-pressed={what === thing.value} onClick={() => setWhat(thing.value)}>{t(thing.label)}</button>)}
          </div>
          {what !== 'item' && line.unit !== 'each' ? <label className="field">{t('How much is in each?')} ({unit})<input inputMode="decimal" value={pack} onChange={(event) => setPack(event.target.value)} /></label> : null}
          <p className="caption">{t('Film slowly along the delivery so each one is seen once.')}</p>
          <button className="btn primary block" type="button" onClick={() => setFilming(true)}><VideoCamera size={24} aria-hidden="true" />{t('Record the delivery')}</button>
          {sample ? <button className="btn block" type="button" onClick={useSample}>{t('Use a sample video')}</button> : null}
        </div>
      ) : null}
      <ErrorNote message={error} />
    </Sheet>
  )
}
