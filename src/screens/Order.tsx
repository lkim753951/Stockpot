import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { EnvelopeSimple, Pause, Play } from '@phosphor-icons/react'
import { OrderEmailSheet } from './OrderEmail'
import { api } from '../api'
import { useClip } from '../clip'
import { Chip, Dock, ErrorNote, Loading, Screen } from '../ui'

export function Order({ id }: { id: string }) {
  const [emailing, setEmailing] = useState(false)
  const [order, setOrder] = useState<any>(null)
  const [lines, setLines] = useState<any[]>([])
  const [date, setDate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const clip = useClip(order?.hasAudio ? order.callId : null)

  const load = (value: any) => {
    setOrder(value)
    setDate(value.deliveryDate ?? '')
    setLines(value.lines.map((line: any) => ({ ...line, pounds: line.agreedPence === null ? '' : (line.agreedPence / 100).toFixed(2) })))
  }
  useEffect(() => { api(`/api/orders/${id}`).then(load).catch((e) => setError(e.message)) }, [id])

  if (!order) return <Screen title={t('Order')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const change = (lineId: number, key: string, value: string) =>
    setLines((list) => list.map((line) => (line.id === lineId ? { ...line, [key]: value } : line)))

  const confirm = async () => {
    setError(null)
    try {
      load(await api(`/api/orders/${id}/confirm`, {
        body: {
          deliveryDate: date || undefined,
          lines: lines.map((line) => ({ id: line.id, quantity: Number(line.quantity), agreedPence: line.pounds === '' ? null : Math.round(Number(line.pounds) * 100) })),
        },
      }))
    } catch (problem) {
      setError((problem as Error).message)
    }
  }

  const removeRecording = async () => {
    await api(`/api/calls/${order.callId}/audio`, { method: 'DELETE' })
    setOrder({ ...order, hasAudio: false })
  }

  const confirmed = order.status === 'confirmed'
  return (
    <Screen title={confirmed ? t('Order confirmed') : t('Check this order')} lead={order.supplier}>
      <p>{order.summary}</p>
      {lines.map((line) => {
        const turn = order.turns.find((candidate: any) => candidate.turn === line.evidenceTurn)
        return (
          <section className="card" key={line.id}>
            <div className="row between">
              <h2>{line.item}</h2>
              {line.needsReview ? <Chip tone="attention">{t('Check this')}</Chip> : null}
            </div>
            {line.reviewNote ? <p>{line.reviewNote}</p> : null}
            <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 1 }}>{t('Quantity ({unit})', { unit: line.unit })}
                <input inputMode="decimal" className="num" value={line.quantity} disabled={confirmed} onChange={(e) => change(line.id, 'quantity', e.target.value)} />
              </label>
              <label className="field" style={{ flex: 1 }}>{t('Agreed price (£ per {unit})', { unit: line.unit })}
                <input inputMode="decimal" className="num" value={line.pounds} disabled={confirmed} onChange={(e) => change(line.id, 'pounds', e.target.value)} />
              </label>
            </div>
            {turn ? (
              <button className="heard" type="button" disabled={!order.hasAudio} onClick={() => clip.play(turn.turn, turn.startMs, turn.endMs)}>
                {clip.playing === turn.turn ? <Pause size={24} weight="fill" aria-hidden="true" /> : <Play size={24} weight="fill" aria-hidden="true" />}
                <span><q>{turn.text}</q><span className="caption">{order.hasAudio ? t('Play this part of the call') : t('Recording deleted')}</span></span>
              </button>
            ) : null}
          </section>
        )
      })}

      <label className="field">{t('Delivery date')}
        <input type="date" value={date} disabled={confirmed} onChange={(e) => setDate(e.target.value)} />
      </label>

      <details>
        <summary style={{ fontWeight: 700, minHeight: 48, cursor: 'pointer' }}>{t('Full transcript')}</summary>
        <ol className="list">
          {order.turns.map((turn: any) => (
            <li key={turn.turn}><span><strong>{turn.role === 'supplier' ? t('Supplier') : turn.role === 'owner' ? t('You') : t('Speaker {speaker}', { speaker: turn.speaker ?? '' })}: </strong>{turn.text}</span></li>
          ))}
        </ol>
        {order.hasAudio ? <button className="btn text" type="button" onClick={removeRecording}>{t('Delete recording')}</button> : null}
      </details>

      <ErrorNote message={error} />
      {confirmed ? (
        <Dock pair>
          <button className="btn primary block" type="button" onClick={() => setEmailing(true)}><EnvelopeSimple size={24} aria-hidden="true" />{t('Email the confirmation')}</button>
          <a className="btn block" href={`#/staff/${order.id}`}>{t('Check in delivery')}</a>
        </Dock>
      ) : <Dock><button className="btn primary block" type="button" onClick={confirm}>{t('Confirm order')}</button></Dock>}
      {emailing ? <OrderEmailSheet orderId={order.id} onClose={() => setEmailing(false)} /> : null}
    </Screen>
  )
}
