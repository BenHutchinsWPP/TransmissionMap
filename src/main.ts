// src/main.ts — Vite entry point
// Imports CSS, records the page-lifecycle line, registers service worker, and kicks off the app.
import 'maplibre-gl/dist/maplibre-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { initPageLifecycle } from '../assets/session-snapshot.js';
import { init } from '../assets/ui/ui.js';

// First, before any app code: what the previous page in this tab did, for File ▸ Diagnostics….
initPageLifecycle();

// Register the SW in production only. In dev it caches CSS/JS Cache-First and
// serves stale assets across reloads (edits appear to do nothing) — so in dev
// we actively unregister any SW left over from a previous prod-like session.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(console.warn);
  } else {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
  }
}

init();

// Dev only: `window.tm`, the view API for the console. Dynamic so prod drops it.
if (import.meta.env.DEV) void import('../assets/dev-console.js');
