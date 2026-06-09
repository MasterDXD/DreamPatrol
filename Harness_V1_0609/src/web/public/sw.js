/** @module web/public/sw */
'use strict';
/* global caches, self, fetch, Response */
const CACHE_NAME = 'harness-v2.72.1';
const SW_DEBUG = false;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=2.72.1',
  '/app.js?v=2.72.1',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

const API_CACHE_NAME = 'harness-api-v2.72.1';
const API_CACHE_TTL = 30000;
const MAX_API_ENTRIES = 100;

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    }).catch(function(err) {
      console.error('SW install: cache.addAll failed, skipping activation:', err);
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.allSettled(
        names.filter(function(name) {
          return name !== CACHE_NAME && name !== API_CACHE_NAME;
        }).map(function(name) {
          return caches.delete(name);
        }),
      );
    }).then(function() {
      return trimApiCache();
    }).then(function() {
      return self.clients.claim();
    }).catch(function(err) {
      if (SW_DEBUG) console.error('SW activate failed:', err);
    }),
  );
});

self.addEventListener('fetch', function(event) {
  let url;
  try {
    url = new URL(event.request.url);
  } catch (_e) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(event.request));
    return;
  }

  event.respondWith(handleStaticRequest(event.request));
});

function handleNavigationRequest(request) {
  return fetch(request).then(function(response) {
    if (response && response.status === 200) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(request, clone).catch(function(e) { if (SW_DEBUG) console.warn('SW nav cache.put failed:', e); });
      }).catch(function(e) { if (SW_DEBUG) console.warn('SW nav cache.open failed:', e); });
    }
    return response;
  }).catch(function() {
    return caches.match(request).then(function(cached) {
      if (cached) return cached;
      return caches.match('/index.html').then(function(fallback) {
        if (fallback) return fallback;
        return new Response('<!DOCTYPE html><html><body><h1>Offline</h1></body></html>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      });
    });
  });
}

function fetchAndUpdateCache(request) {
  return fetch(request).then(function(response) {
    if (response && response.status === 200) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(request, clone).catch(function(e) { if (SW_DEBUG) console.warn('SW cache.put failed:', e); });
      }).catch(function(e) { if (SW_DEBUG) console.warn('SW cache.open failed:', e); });
    }
    return response;
  }).catch(function(e) { if (SW_DEBUG) console.warn('SW fetchAndUpdateCache failed:', e); });
}

function handleStaticRequest(request) {
  return caches.match(request).then(function(cached) {
    if (cached) {
      fetchAndUpdateCache(request).catch(function(e) { if (SW_DEBUG) console.warn('SW background refresh failed:', e); });
      return cached;
    }
    return fetch(request).then(function(response) {
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(request, clone).catch(function(e) { if (SW_DEBUG) console.warn('SW cache.put failed:', e); });
        }).catch(function(e) { if (SW_DEBUG) console.warn('SW cache.open failed:', e); });
      }
      return response;
    }).catch(function() {
      if (request.mode === 'navigate') {
        return caches.match('/index.html');
      }
      return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    });
  });
}

function handleApiRequest(request) {
  if (request.method !== 'GET') return fetch(request);
  return fetch(request).then(function(response) {
    if (response && response.status === 200) {
      const cc = response.headers.get('cache-control');
      const shouldCache = !cc || !cc.toLowerCase().includes('no-store');
      if (shouldCache) {
        const clone = response.clone();
        caches.open(API_CACHE_NAME).then(function(cache) {
          const headers = new Headers();
          clone.headers.forEach(function(value, key) {
            headers.set(key, value);
          });
          headers.set('sw-cache-timestamp', Date.now().toString());
          const bodyPromise = clone.blob().then(function(blob) {
            const init = { status: clone.status, statusText: clone.statusText, headers: headers };
            return new Response(blob, init);
          });
          bodyPromise.then(function(cacheableResponse) {
            cache.put(request, cacheableResponse).catch(function(e) { if (SW_DEBUG) console.warn('SW API cache.put failed:', e); });
          }).catch(function(e) { if (SW_DEBUG) console.warn('SW API body promise failed:', e); });
        }).catch(function(e) { if (SW_DEBUG) console.warn('SW API cache.open failed:', e); });
      }
    }
    return response;
  }).catch(function() {
    return caches.match(request).then(function(cached) {
      if (cached) {
        const ts = parseInt(cached.headers.get('sw-cache-timestamp') || '0', 10);
        if (Date.now() - ts < API_CACHE_TTL) {
          return cached;
        }
        caches.open(API_CACHE_NAME).then(function(cache) { return cache.delete(request); }).catch(function(err) { if (SW_DEBUG) console.warn('SW cache delete error:', err); });
      }
      return new Response(JSON.stringify({ error: 'Network unavailable', offline: true }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });
}

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'PURGE_API_CACHE') {
    caches.delete(API_CACHE_NAME).catch(function(e) { if (SW_DEBUG) console.warn('SW cache.delete failed:', e); });
  }
  if (event.data && event.data.type === 'TRIM_CACHE') {
    trimApiCache().catch(function(e) { console.warn('SW trimApiCache failed:', e); });
  }
});

function trimApiCache() {
  return caches.open(API_CACHE_NAME).then(function(cache) {
    cache.keys().then(function(keys) {
      if (keys.length > MAX_API_ENTRIES) {
        const toDelete = keys.slice(0, keys.length - MAX_API_ENTRIES);
        toDelete.forEach(function(key) { cache.delete(key).catch(function(err) { console.warn('SW:cacheDelete', err); }); });
      }
      keys.forEach(function(key) {
        cache.match(key).then(function(cached) {
          if (cached) {
            const ts = parseInt(cached.headers.get('sw-cache-timestamp') || '0', 10);
            if (ts && Date.now() - ts > API_CACHE_TTL * 2) {
              cache.delete(key).catch(function(err) { if (SW_DEBUG) console.warn('SW cache delete error:', err); });
            }
          }
        }).catch(function(e) { if (SW_DEBUG) console.warn('SW trimApiCache match failed:', e); });
      });
    }).catch(function(e) { if (SW_DEBUG) console.warn('SW trimApiCache keys failed:', e); });
  }).catch(function(e) { if (SW_DEBUG) console.warn('SW trimApiCache open failed:', e); });
}
