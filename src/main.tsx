import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { loadLanguage, useLanguage } from './lib/i18n'

/** A new language draws everything again from the top, including words fetched from the server. */
function Root() {
  const language = useLanguage()
  return <App key={language} />
}

void loadLanguage().then(() => createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>))

// Keeps the app shell on the device, so crisis cards open with the wifi down.
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js')
