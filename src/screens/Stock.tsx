import { useEffect, useState } from 'react'
import { ShoppingCart, Sparkle } from '@phosphor-icons/react'
import { api, niceDate } from '../lib/api'
import { t, tk } from '../lib/i18n'
import { CATEGORIES } from '../lib/categories'
import { Chip, Empty, ErrorNote, Loading, Screen, Sheet } from '../components/ui'
import { isPack, litresOf, PACKS, type Pack } from '../../shared/stock'
import { amount } from './Shopping'

const PACK_WORDS: Record<Pack, string> = { container: tk('Container'), box: tk('Box'), crate: tk('Crate') }
const PACK_SIZES: Record<Pack, string> = { container: '1 L', box: '5 L', crate: tk('6 boxes, 30 L') }
const litres = (value: number) => `${Number(value.toFixed(2))} L`
const packWord = (pack: string) => (isPack(pack) ? t(PACK_WORDS[pack]) : t('Weighed or measured'))

function PackTick({ value, chosen, label, size, onPick }: { value: string; chosen: string; label: string; size?: string; onPick: (value: string) => void }) {
  return (
    <label className="pack-tick">
      <input type="radio" name="pack" value={value} checked={chosen === value} onChange={() => onPick(value)} />
      <span>{label}</span>
      {size ? <small className="num">{size}</small> : null}
    </label>
  )
}

function CountSheet({ item, owner, onClose, onChange }: { item: any; owner: boolean; onClose: () => void; onChange: (next: any) => void }) {
  const each = item.unit === 'each'
  const [pack, setPack] = useState<string>(each ? 'unit' : item.count?.pack ?? 'box')
  const [count, setCount] = useState('')
  const [density, setDensity] = useState(item.density === null ? '' : String(item.density))
  const [busy, setBusy] = useState(false)
  const [estimating, setEstimating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The first count of an ingredient asks for its density, once, and a count saves whether or not an answer comes.
  useEffect(() => {
    if (each || item.density !== null) return
    setEstimating(true)
    api('/api/stock/estimate', { body: { itemId: item.id } })
      .then((next) => { onChange(next); const found = next.items.find((row: any) => row.id === item.id); if (found?.density !== null) setDensity(String(found.density)) })
      .catch((problem) => setError((problem as Error).message))
      .finally(() => setEstimating(false))
  }, [])

  const number = count.trim() === '' ? NaN : Number(count)
  const known = Number.isFinite(number) && number >= 0
  const volume = known && isPack(pack) ? litresOf(number, pack) : null
  const weight = volume !== null && item.density !== null ? volume * item.density : null

  const save = async () => {
    setBusy(true)
    setError(null)
    try { onChange(await api(`/api/stock/${item.id}/count`, { body: { count: number, pack } })); onClose() } catch (problem) { setError((problem as Error).message); setBusy(false) }
  }
  const saveDensity = async () => {
    const value = density.trim() === '' ? null : Number(density)
    if (value === item.density) return
    setError(null)
    try { onChange(await api(`/api/stock/${item.id}/density`, { body: { density: value } })) } catch (problem) { setError((problem as Error).message) }
  }

  return (
    <Sheet title={item.name} onClose={onClose}>
      {each ? null : (
        <fieldset className="pack-ticks">
          <legend>{t('Counting in')}</legend>
          {(Object.keys(PACKS) as Pack[]).map((key) => <PackTick key={key} value={key} chosen={pack} label={t(PACK_WORDS[key])} size={t(PACK_SIZES[key])} onPick={setPack} />)}
          <PackTick value="unit" chosen={pack} label={item.unit === 'kg' ? t('Weighed') : t('Measured')} size={item.unit} onPick={setPack} />
        </fieldset>
      )}
      <label className="field">{each ? t('How many?') : t('How many? 1.5 is fine for a part-full one.')}
        <input type="number" inputMode="decimal" min="0" step="0.1" value={count} onChange={(event) => setCount(event.target.value)} />
      </label>
      {volume !== null ? (
        <p className="count-sum num">
          <strong>{t('{count} × {pack} = {litres}', { count: number, pack: t(PACK_WORDS[pack as Pack]), litres: litres(volume) })}</strong>
          {weight !== null ? <span>{t('About {weight}', { weight: amount(weight, 'kg') })}</span> : null}
        </p>
      ) : null}
      {each ? null : (
        <>
          {owner ? (
            <label className="field">{t('Density, kg a litre')}
              <input type="number" inputMode="decimal" min="0.02" max="2" step="0.01" value={density} onChange={(event) => setDensity(event.target.value)} onBlur={saveDensity} />
            </label>
          ) : null}
          <p className="caption">
            {estimating ? t('Estimating the density…')
              : item.density === null ? t('No density yet, so this count is kept in litres.')
                : item.densitySource === 'ai' ? t('AI estimate: {density} kg a litre. Weights are approximate.', { density: item.density })
                  : t("The owner's figure: {density} kg a litre.", { density: item.density })}
          </p>
        </>
      )}
      <ErrorNote message={error} />
      <button className="btn primary block" type="button" disabled={busy || !known} onClick={save}>{t('Save count')}</button>
    </Sheet>
  )
}

export function Stock({ owner = false }: { owner?: boolean }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [estimating, setEstimating] = useState(false)
  useEffect(() => { api('/api/stock').then(setData).catch((problem) => setError((problem as Error).message)) }, [])
  if (!data) return <Screen title={t('Stock')}><ErrorNote message={error} />{error ? null : <Loading />}</Screen>

  const open = data.items.find((item: any) => item.id === openId)
  const missing = data.items.filter((item: any) => item.unit !== 'each' && item.density === null).length
  const estimate = async () => {
    setEstimating(true)
    setError(null)
    try { setData(await api('/api/stock/estimate', { body: {} })) } catch (problem) { setError((problem as Error).message) }
    setEstimating(false)
  }

  return (
    <Screen title={t('Stock')} lead={t('Count what you have. Stockpot works out the litres and the rough weight.')}>
      {owner ? (
        <div className="stock-actions">
          <a className="btn" href="#/shopping"><ShoppingCart size={20} aria-hidden="true" />{t('Shopping list')}</a>
          {missing ? <button className="btn" type="button" disabled={estimating} onClick={estimate}><Sparkle size={20} aria-hidden="true" />{estimating ? t('Estimating the density…') : t('Estimate densities')}</button> : null}
        </div>
      ) : null}
      <ErrorNote message={openId ? null : error} />
      {data.items.length ? CATEGORIES.map((category) => {
        const rows = data.items.filter((item: any) => item.category === category)
        if (!rows.length) return null
        return (
          <section className="stack shop-group" key={category}>
            <h3>{t(category)} <span className="num muted">{rows.length}</span></h3>
            <ul className="shop-list">
              {rows.map((item: any) => (
                <li key={item.id}>
                  <button type="button" className="shop-row" onClick={() => setOpenId(item.id)}>
                    <span className="shop-name">{item.name}
                      <small>{item.count ? t('{count} × {pack}, {date}', { count: item.count.value, pack: packWord(item.count.pack), date: niceDate(item.count.at) }) : t('Not counted yet')}</small>
                    </span>
                    <span className="shop-qty num">
                      {item.stock !== null ? `${item.unit === 'kg' ? '≈ ' : ''}${amount(item.stock, item.unit)}` : item.litres !== null ? litres(item.litres) : '–'}
                      {item.count && !item.fresh ? <Chip tone="due">{t('Count again')}</Chip> : item.order ? <small>{t('Order {amount}', { amount: amount(item.order, item.unit) })}</small> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      }) : <Empty title={t('No ingredients yet')}>{t('Add your recipes and each ingredient appears here to count.')}</Empty>}
      {open ? <CountSheet key={open.id} item={open} owner={owner} onClose={() => setOpenId(null)} onChange={setData} /> : null}
    </Screen>
  )
}
