import { t } from './i18n'

const url = (name: string) => `/api/staff/delivery-media/${name}`

/** Pictures of a delivery, with who added each one. */
export function MediaGrid({ media }: { media: any[] }) {
  if (!media?.length) return null
  return (
    <ul className="media-grid">
      {media.map((row) => (
        <li key={row.id}>
          {row.video
            ? <video src={url(row.video)} poster={url(row.file)} controls playsInline preload="none" aria-label={t('Video of {name}', { name: t('the delivery') })} />
            : <a href={url(row.file)} target="_blank" rel="noreferrer"><img src={url(row.file)} alt={t('Photo of {name}', { name: t('the delivery') })} loading="lazy" /></a>}
          {row.counted !== null && row.counted !== undefined ? <small>{t('SAM counted {count}', { count: row.counted })}</small> : null}
          {row.addedBy ? <small>{row.addedBy}</small> : null}
        </li>
      ))}
    </ul>
  )
}
