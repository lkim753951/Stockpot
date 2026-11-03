// Saves the app shell, so crisis cards still open when the wifi or the power is the problem.
const CACHE = 'stockpot-shell-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/')).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  // The owner's own crisis photos have to open with the wifi down too.
  if (url.pathname.startsWith('/api') && !url.pathname.startsWith('/api/crisis/photo/')) return

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request)
      .then((response) => {
        const copy = response.clone()
        void caches.open(CACHE).then((cache) => cache.put('/', copy))
        return response
      })
      .catch(() => caches.match('/')))
    return
  }

  if (/^\/(assets|fonts|brand|api\/crisis\/photo)\//.test(url.pathname)) {
    event.respondWith(caches.match(event.request).then((saved) => saved ?? fetch(event.request).then((response) => {
      const copy = response.clone()
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy))
      return response
    })))
  }
})
