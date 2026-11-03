import { t } from './i18n'

/** Stockpot's own pot, with a face. The steam rises and the eyes look about while it works. */
export function Mascot({ size = 40, thinking = false, tone = 'brand' }: { size?: number; thinking?: boolean; tone?: 'brand' | 'light' }) {
  return (
    <svg className={`mascot${thinking ? ' thinking' : ''}${tone === 'light' ? ' light' : ''}`} viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={thinking ? t('Stockpot is thinking') : 'Stockpot'}>
      <g className="mascot-steam">
        <rect x="18" y="13" width="7" height="9" rx="3.5" />
        <rect x="28.5" y="8" width="7" height="14" rx="3.5" />
        <rect x="39" y="3" width="7" height="19" rx="3.5" />
      </g>
      <g className="mascot-pot">
        <rect x="8" y="25" width="48" height="5" rx="2.5" />
        <rect x="3" y="35" width="10" height="6" rx="3" />
        <rect x="51" y="35" width="10" height="6" rx="3" />
        <path d="M11 32H53V47A9 9 0 0 1 44 56H20A9 9 0 0 1 11 47Z" />
      </g>
      <g className="mascot-face">
        <circle className="mascot-eye" cx="24" cy="41" r="3.2" />
        <circle className="mascot-eye" cx="40" cy="41" r="3.2" />
        <path d="M27 47.5Q32 51.5 37 47.5" fill="none" strokeWidth="2.4" strokeLinecap="round" />
      </g>
    </svg>
  )
}
