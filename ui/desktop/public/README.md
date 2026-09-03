# public/

Vite copies this folder verbatim into `dist/` at the site root, for both `npm run dev` and
`npm run build`.

`maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` are copies of the matching files in
`node_modules/maplibre-gl/dist/`. maplibre-gl (v6) fetches its web worker from
`/maplibre-gl-worker.mjs` at runtime; a production static-site host has no route for that path
and falls back to serving `index.html` instead (confirmed via `curl -I` returning `200 OK` with
`Content-Type: text/html`), which the browser rejects as an invalid module -- silently breaking
every GeoJSON/vector layer (Batch geocode's map markers) with no visible error beyond a console
warning, while raster base-map tiles keep working fine (they don't need the worker at all). Same
root cause `ui/mobile/public/README.md` already documented for Metro's dev server; this app hit
it in production instead, since `vite.config.ts`'s `optimizeDeps.exclude: ['maplibre-gl']` papers
over the equivalent problem for `npm run dev` but has no effect on the real `vite build` output.

**Must be re-copied whenever the installed `maplibre-gl` version changes** (main thread and
worker need matching protocol versions):

```bash
cp node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs public/maplibre-gl-worker.mjs
cp node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs public/maplibre-gl-shared.mjs
```
