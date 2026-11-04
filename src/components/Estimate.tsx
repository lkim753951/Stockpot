import { useEffect, useState } from 'react'
import { Sparkle } from '@phosphor-icons/react'
import { api, pounds } from '../lib/api'
import { t } from '../lib/i18n'
import { Chip, ErrorNote, Tile } from './ui'

export interface EstimateDish { name: string; pricePence: number | null; lines: Array<{ name: string; quantity: number | string; unit: string }> }

/** What the estimate is asked about. Empty rows are left out, and quantities go as numbers. */
export const estimateBody = (dish: EstimateDish) => ({
  name: dish.name, pricePence: dish.pricePence,
  lines: dish.lines.filter((line) => line.name.trim() && Number(line.quantity) > 0).map((line) => ({ name: line.name, quantity: Number(line.quantity), unit: line.unit })),
})

export const estimateDish = (dish: EstimateDish) => api('/api/setup/dishes/estimate', { body: estimateBody(dish) })

/** Small amounts read better in grams and millilitres, as on the rest of the menu screen. */
function amount(line: any) {
  const quantity = Number(line.quantity)
  if (line.unit === 'each') return `${Number(quantity.toFixed(2))} ${t('each')}`
  if ((line.unit === 'kg' || line.unit === 'l') && quantity < 1) return `${Number((quantity * 1000).toFixed(1))} ${line.unit === 'kg' ? 'g' : 'ml'}`
  return `${Number(quantity.toFixed(2))} ${line.unit}`
}

/** One line for a dish on a list: cost, margin and the price for an 80% margin. */
export function estimateLine(result: any) {
  const cost = result.complete ? pounds(result.costPence) : t('At least {cost}', { cost: pounds(result.costPence) })
  const parts = [t('AI estimate: food cost {cost} a portion.', { cost })]
  if (result.marginPercent !== null) parts.push(`${t('Margin')}: ${result.marginPercent}%.`)
  if (result.suggestedPricePence !== null) parts.push(`${t('Menu price for an {margin}% margin', { margin: result.suggestedMargin })}: ${pounds(result.suggestedPricePence)}.`)
  return parts.join(' ')
}

/**
 * Food cost, margin and a suggested price, before the restaurant has real prices. Prices it has paid are used first.
 * Nothing here is saved: the owner chooses whether to use the suggested price or recipe.
 */
export function EstimatePanel({ dish, onUsePrice, onUseRecipe }: { dish: EstimateDish; onUsePrice?: (pence: number) => void | Promise<void>; onUseRecipe?: (lines: Array<{ name: string; quantity: string; unit: string }>) => void }) {
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A changed recipe or price makes an old estimate wrong, so it goes.
  const asked = JSON.stringify(estimateBody(dish))
  useEffect(() => { setResult(null) }, [asked])
  const run = async () => {
    setBusy(true)
    setError(null)
    try { setResult(await estimateDish(dish)) } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  const use = async (pence: number) => {
    setBusy(true)
    setError(null)
    try { await onUsePrice!(pence) } catch (problem) { setError((problem as Error).message) } finally { setBusy(false) }
  }
  return (
    <section className="stack" aria-label={t('AI cost estimate')}>
      <h3>{t('AI cost estimate')}</h3>
      {result ? null : <p className="caption">{t('No prices yet? Stockpot can estimate the food cost from typical UK wholesale prices, and suggest a menu price for an 80% margin.')}</p>}
      <button className="btn block" type="button" disabled={busy || !dish.name.trim()} onClick={run}><Sparkle size={22} aria-hidden="true" />{busy ? t('Estimating') : t('Estimate cost with AI')}</button>
      <ErrorNote message={error} />
      {result ? (
        <>
          {result.suggestedRecipe ? <p className="notice">{t('There is no recipe yet, so this uses a typical recipe for one portion. Check it before you use it.')}</p> : null}
          <div className="tiles">
            <Tile label={t('Estimated food cost a portion')} value={result.complete ? pounds(result.costPence) : t('At least {cost}', { cost: pounds(result.costPence) })} />
            <Tile label={t('Margin')} value={result.marginPercent === null ? t('Not known') : `${result.marginPercent}%`} note={result.pricePence ? pounds(result.pricePence) : undefined} />
          </div>
          <ul className="list">
            <li><span>{t('Menu price for an {margin}% margin', { margin: result.suggestedMargin })}</span><strong className="num">{result.suggestedPricePence === null ? t('Not known') : pounds(result.suggestedPricePence)}</strong></li>
          </ul>
          {onUsePrice && result.suggestedPricePence !== null && (!result.pricePence || result.suggestedPricePence > result.pricePence) ? (
            <button className="btn primary block" type="button" disabled={busy} onClick={() => use(result.suggestedPricePence)}>{t('Use {price} as the menu price', { price: pounds(result.suggestedPricePence) })}</button>
          ) : null}
          <details className="worked" open={result.suggestedRecipe}>
            <summary>{t('See the ingredients')}</summary>
            <ul className="list">
              {result.lines.map((line: any, index: number) => (
                <li key={`${line.name}${index}`}>
                  <span>{line.name}<span className="when"><br />{amount(line)}{line.pencePerUnit === null ? '' : `, ${t('{price} a {unit}', { price: pounds(line.pencePerUnit), unit: line.priceUnit === 'each' ? t('each') : line.priceUnit })}`}</span></span>
                  <span className="num cost-cell">
                    {line.costPence === null ? <Chip tone="attention">{t('No price yet')}</Chip> : <strong>{line.costPence < 0.5 ? t('Under 1p') : pounds(line.costPence)}</strong>}
                    {line.source ? <span className="when"><br />{line.source === 'paid' ? t('Your price') : t('AI estimate')}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          {onUseRecipe && result.suggestedRecipe ? (
            <button className="btn block" type="button" onClick={() => onUseRecipe(result.lines.map((line: any) => ({ name: line.name, quantity: String(line.quantity), unit: line.unit })))}>{t('Use these ingredients as the recipe')}</button>
          ) : null}
          <p className="caption">{t('AI estimates use typical UK wholesale prices before VAT. They are a guide, and they are never saved. Prices from your receipts replace them.')}</p>
        </>
      ) : null}
    </section>
  )
}
