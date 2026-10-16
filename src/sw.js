// Service worker with three jobs:
//  1. Add the security headers a static host like GitHub Pages cannot set itself
//     (COOP/COEP make the page "cross-origin isolated", which the multithreaded
//     WebAssembly engine needs for SharedArrayBuffer).
//  2. Serve the large engine files (soffice.wasm / soffice.data), which are stored on the
//     server gzip-compressed and split into parts, decompressed in the browser.
//  3. Cache the app and engine files so the next visit starts instantly and works offline.
// User documents never pass through here: they are read from disk by the page and handed
// straight to the conversion worker.
'use strict';

const BUILD_ID = '@BUILD_ID@';
const ENGINE = /*@ENGINE_MANIFEST@*/ { id: 'dev', files: {} };

const APP_CACHE = `app-${BUILD_ID}`;
const ENGINE_CACHE = `engine-${ENGINE.id}`;

// connect-src 'self' is what guarantees that no document data can be sent to any other server.
const CSP_BASE =
  "default-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; " +
  "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The engine's runtime (Emscripten/embind) compiles WebAssembly and generates helper functions at
// runtime, so only the engine worker scripts may do that; the page itself may not.
const CSP_PAGE = `${CSP_BASE}; script-src 'self'`;
const CSP_ENGINE = `${CSP_BASE}; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`;

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([APP_CACHE, ENGINE_CACHE]);
      for (const key of await caches.keys()) {
        if (!keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // the app never loads anything from elsewhere

  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  const engineFile = ENGINE.files[path];
  if (engineFile) {
    event.respondWith(serveEngineFile(event, engineFile));
  } else {
    event.respondWith(serveAppFile(request, path.startsWith('engine/') ? CSP_ENGINE : CSP_PAGE));
  }
});

function withSecurityHeaders(response, csp) {
  // Opaque redirects and errors cannot be rebuilt; pass them through untouched.
  if (response.status === 0 || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set('Content-Security-Policy', csp);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Network first (so updates arrive immediately), cache as offline fallback.
async function serveAppFile(request, csp) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const key = new URL(request.url);
      key.search = '';
      await cache.put(key.href, response.clone());
    }
    return withSecurityHeaders(response, csp);
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return withSecurityHeaders(cached, csp);
    throw error;
  }
}

// Streams the compressed parts (from cache or network) through a gzip decompressor.
// Progress is broadcast to the page so it can show a download progress bar.
function serveEngineFile(event, file) {
  const channel = new BroadcastChannel('engine-download');
  let finished;
  event.waitUntil(new Promise((resolve) => (finished = resolve)));

  const compressed = new ReadableStream({
    async start(controller) {
      try {
        const cache = await caches.open(ENGINE_CACHE);
        let loaded = 0;
        for (const part of file.parts) {
          const partUrl = new URL(part.path, self.registration.scope).href;
          let response = await cache.match(partUrl);
          const fromCache = Boolean(response);
          if (!response) {
            response = await fetch(partUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${part.path}`);
          }
          const pending = fromCache ? null : cache.put(partUrl, response.clone());
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            channel.postMessage({ path: file.path, loaded, total: file.compressedSize });
            controller.enqueue(value);
          }
          if (pending) await pending;
        }
        controller.close();
      } catch (error) {
        channel.postMessage({ path: file.path, error: String(error) });
        try {
          controller.error(error);
        } catch {
          // the consumer already went away (e.g. the worker was terminated)
        }
      } finally {
        channel.close();
        finished();
      }
    },
  });

  const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': CSP_ENGINE, 'Content-Type': file.type };
  return new Response(compressed.pipeThrough(new DecompressionStream('gzip')), { headers });
}
