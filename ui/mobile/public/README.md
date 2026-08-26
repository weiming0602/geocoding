# public/

Expo serves this folder verbatim at the site root (dev server and web export alike).

`maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copies of the matching files in
`node_modules/maplibre-gl/dist/`. maplibre-gl (v6) fetches its web worker from
`/maplibre-gl-worker.mjs` at runtime; Metro has no route for that path and serves its HTML
fallback instead, which the browser rejects as an invalid module -- silently breaking every map
(`GeocodeMap.web.tsx`, `BatchGeocodeMap.web.tsx`) with no visible error beyond a console warning.
`maplibre-gl-worker.mjs` itself then does `import ... from "./maplibre-gl-shared.mjs"` -- the
worker file alone isn't enough; without this second file too, the worker script loads but fails
during its own module resolution, which surfaces as a sanitized, detail-free `ErrorEvent` (empty
message/filename) rather than the earlier MIME-type error, making it look like a different
problem when it's really the same one, one file short. Both files together are what make maps
actually render, not just show a basemap with no markers.

**Must be re-copied whenever the installed `maplibre-gl` version changes** (main thread and
worker need matching protocol versions):

```bash
cp node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs public/maplibre-gl-worker.mjs
cp node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs public/maplibre-gl-shared.mjs
```
