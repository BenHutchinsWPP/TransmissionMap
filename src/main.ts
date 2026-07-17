// src/main.js — Vite entry point
// Imports CSS, registers service worker, and kicks off the app.
import 'maplibre-gl/dist/maplibre-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { init } from '../assets/ui/ui.js';

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
