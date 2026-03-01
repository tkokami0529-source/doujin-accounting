const CACHE_NAME = 'doujinpos-v8';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
];

// URLs that should always go network-first (auth, payments, APIs)
const NETWORK_FIRST_PATTERNS = [
  'firebasejs',
  'firestore',
  'googleapis.com',
  'firebase',
  'identitytoolkit',
  'securetoken',
  'accounts.google.com',
  'stripe.com',
  'js.stripe.com',
  'checkout.stripe.com',
  'cloudfunctions.net',
  'run.app',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Network-first for Firebase, Auth, Stripe, and Cloud Functions
  if (NETWORK_FIRST_PATTERNS.some((p) => url.includes(p))) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Stale-while-revalidate for app assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
