# ui/desktop

React web app for the geocoding platform, calling the same
`geocoding-server` API as `ui/mobile`. **Scaffold only** — routing and
the API client are wired up and proven working; no real screen UI is
implemented yet (see the design handoff for what each screen should
look like, and the screen-by-screen implementation plan for build order).

## Stack

- Vite + React 19 + TypeScript
- `react-router` for routing (hash-based, so no server-side routing
  config is needed for a plain static deploy)
- `maplibre-gl` directly (no React wrapper) — same library `ui/mobile`
  already uses for its own web build, just without react-native-web
- Vitest + React Testing Library for tests
- Design tokens: `src/styles.css`, copied from the Meridian design
  handoff's `styles.css` — treat that as the source of truth for colors/
  type/spacing, not hand-copied hex codes

## Commands

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest run
npm run build    # tsc -b && vite build
```

## Structure

```
src/
  main.tsx        entry point
  App.tsx         routes + nav
  pages/          one file per screen (all placeholders right now)
  styles.css      Meridian design tokens
```

## Shared code

Imports from `../shared` (relative path, no package alias) for the API
client, response types, and coordinate parsing — see `ui/shared`'s own
package.json for why map integration code (maplibre-gl-typed) is
deliberately *not* shared the same way.
