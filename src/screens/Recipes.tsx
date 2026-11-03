import { useEffect, useMemo, useState } from 'react'
import { CaretRight, CookingPot, MagnifyingGlass } from '@phosphor-icons/react'
import { api } from '../api'
import { t } from '../i18n'
import { Empty, ErrorNote, Loading, Screen } from '../ui'

/** Saved in kilos and litres, read in grams and millilitres. */
function amount(line: any) {
  if (line.unit === 'each') return `${Number(line.quantity.toFixed(2))}`
  if (line.quantity < 1) return `${Math.round(line.quantity * 1000)} ${line.unit === 'kg' ? 'g' : 'ml'}`
  return `${Number(line.quantity.toFixed(2))} ${line.unit}`
}

function useRecipes() {
  const [recipes, setRecipes] = useState<any[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('/api/staff/recipes').then(setRecipes).catch((e) => setError(e.message)) }, [])
  return { recipes, error }
}

export function StaffRecipes() {
  const { recipes, error } = useRecipes()
  const [search, setSearch] = useState('')
  const shown = useMemo(() => recipes?.filter((recipe) => recipe.name.toLowerCase().includes(search.trim().toLowerCase())), [recipes, search])
  return (
    <Screen title={t('Recipes')} lead={t('What goes in each dish, for one portion.')}>
      <ErrorNote message={error} />
      {!recipes && !error ? <Loading /> : null}
      {recipes?.length === 0 ? <Empty title={t('No recipes yet.')}><p className="muted">{t('The owner adds these in Settings.')}</p></Empty> : null}
      {recipes?.length ? (
        <label className="search">
          <MagnifyingGlass size={22} aria-hidden="true" />
          <input aria-label={t('Find a dish')} placeholder={t('Find a dish')} value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      ) : null}
      {shown?.length ? (
        <ul className="feature-list">
          {shown.map((recipe) => (
            <li key={recipe.id}>
              <a className="feature-row" href={`#/staff/recipes/${recipe.id}`}>
                <CookingPot size={24} aria-hidden="true" />
                <strong>{recipe.name}</strong>
                <CaretRight className="note" size={20} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </Screen>
  )
}

export function StaffRecipe({ id }: { id: string }) {
  const { recipes, error } = useRecipes()
  const recipe = recipes?.find((candidate) => String(candidate.id) === id)
  if (!recipe) return <Screen title={t('Recipes')}><ErrorNote message={error} />{recipes ? null : <Loading />}</Screen>
  return (
    <Screen title={recipe.name} lead={t('For one portion.')}>
      {recipe.photo ? <img className="evidence" src={`/api/staff/recipe-photo/${recipe.photo}`} alt={recipe.name} /> : null}
      {recipe.lines.length ? (
        <section className="stack">
          <h2>{t('Ingredients')}</h2>
          <ul className="list">
            {recipe.lines.map((line: any) => <li key={line.name}><span>{line.name}</span><strong className="num">{amount(line)}</strong></li>)}
          </ul>
        </section>
      ) : null}
      {recipe.method ? <section className="stack"><h2>{t('How to make it')}</h2><p className="method">{recipe.method}</p></section> : null}
      {!recipe.lines.length && !recipe.method ? <p className="muted">{t('The owner has not added this recipe yet.')}</p> : null}
      <a className="btn block" href="#/staff/recipes">{t('All recipes')}</a>
    </Screen>
  )
}
