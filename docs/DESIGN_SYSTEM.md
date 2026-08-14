# Design system — "Classical"

> Reconstructed from `ui/desktop/src/styles.css` (the stated source of
> truth) and its plain-data mirror `ui/shared/theme.ts` (which exists
> because React Native's `StyleSheet` can't consume CSS custom
> properties at all).

## Intent

Serif headings (Cormorant Garamond) over a warm, neutral body face
(Lora), a single warm-gold accent plus a genuinely different second
hue (deep teal, not another shade of brown) for real two-color
contrast, and restrained editorial styling — the goal is a geocoding
product that reads as a considered, trustworthy service, not a generic
dashboard template. There is no icon usage anywhere in either app by
design; distinction comes from typography, color, and layout, not
iconography.

## Tokens

Desktop consumes these as CSS custom properties (`:root` in
`styles.css`); mobile consumes the identical values as plain
TypeScript constants (`ui/shared/theme.ts`), kept in sync **by hand** —
there's no build step generating one from the other.

### Color

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#f3f2f2` | Page background |
| `surface` | `#eae9e9` | Raised/secondary surfaces |
| `text` | `#201f1d` | Body text |
| `accent` | `#b68235` | Primary accent (warm gold) |
| `accent-2` | `#3a7d68` | Secondary accent (deep teal) |
| `divider` | `color-mix(text 16%, transparent)` | Hairline borders |
| `neutral-100…900` | tonal ramp | Generated in OKLCH on one shared lightness scale, so the same step of any role matches the others in visual value |
| `accent-100…900` | tonal ramp | Same treatment, for the primary accent |
| `error-text` | `#a4402a` | Error copy |

### Typography

| Token | Value |
| --- | --- |
| `font-heading` | "Cormorant Garamond", weight 600 (semibold is the ceiling — bold was tried and retired; it only works at small interface sizes, and display text goes *lighter*, to the normal cut) |
| `font-body` | "Lora", 400/600 |
| Base body | 17px / 1.6 line-height |
| Headings | `h1` 48px → `h6` 14px, a fixed type scale, `-0.015em` letter-spacing throughout |

### Spacing, radius, motion

| Token | Value |
| --- | --- |
| `space-1…8` | 4.6 / 9.2 / 13.8 / 18.4 / 27.6 / 36.8px — a single 4.6px-based scale, not a round-number one |
| `radius-sm/md/lg` | 6 / 10 / 18px |
| `transition-fast` | 150ms ease |
| `shadow-sm/md/lg` | Ink-tinted soft shadows (light theme) — `color-mix` against a near-black, not a flat `rgba(0,0,0,…)` |

## Component vocabulary (desktop)

Plain CSS classes on plain HTML — no component library, no CSS-in-JS.

- **`.btn`** + a variant (`btn-primary` / `btn-secondary` / `btn-ghost` /
  `btn-icon`) + optional `btn-block`. Hover lifts 1px and adds a soft
  shadow; active settles back down.
- **`.card`** (+ `elev-sm/md/lg`) — the base content container: a
  bordered box with `card-kicker` (small caps label), `card-title`,
  `card-body`, `card-meta`. Used for everything from pricing tiers to
  the homepage's task grid to a single result row.
- **`.tag`** (+ `tag-accent` / `tag-accent-2` / `tag-neutral` /
  `tag-outline`) — small pill labels ("Most popular", "In progress").
- **`.nav`** — the site header: brand + links, `display: flex`. Below a
  720px breakpoint, links collapse into a `.nav-links` dropdown panel
  behind a hamburger `.nav-toggle` button (the one CSS breakpoint in the
  whole stylesheet — added after the original all-links-in-one-row
  layout was found to overflow the viewport by roughly 2x at real phone
  widths, not just wrap unattractively).

Most page-level layout otherwise uses **inline `style` props** directly
in JSX (grids via `repeat(auto-fit, minmax(…))` so multi-column
sections reflow without a dedicated breakpoint) rather than additional
utility classes — the stylesheet's own component vocabulary stays
small and reusable, and one-off page layout stays local to the page
that needs it.

## Cross-platform parity, and where it deliberately isn't 1:1

Both apps implement the same screens against the same API client and
the same token values, but the *platform-idiomatic* choice wins over
pixel parity every time:

| Concern | Desktop | Mobile |
| --- | --- | --- |
| Navigation | `react-router`, a real URL per screen | No router at all — a hand-rolled `useState<Screen>` tab switcher in `App.tsx`; every screen fully unmounts on switch, so state that must survive a visit (the Import Addresses wizard, a batch forwarded from it) is lifted into `App.tsx` itself |
| Interactive map | Real MapLibre map everywhere | Native builds: display-only, a deep-link "Open in Maps" button (no maplibre/expo-maps native setup exists); the **web** build of the same app gets the real map |
| Per-column filter dropdowns (Import Addresses) | Yes, one dropdown per low-cardinality column | Deliberately left out in favor of a status filter + search box — one dropdown per column would mean a modal per column on a small screen |
| List rendering | Plain DOM, browser handles virtualization concerns implicitly | Plain `.map()` inside `ScrollView`, no `FlatList` anywhere — sample size is capped smaller (50 vs desktop's 100) specifically because nothing here virtualizes |
| Column-role picker (Import Addresses) | Native `<select>` | A `Modal`-based picker — no native `<select>` equivalent exists in React Native |

## Why a shared `theme.ts` exists at all

`ui/shared` otherwise holds only genuinely platform-agnostic logic (API
client, types, coordinate parsing) — `theme.ts` is the one exception,
justified specifically because it has zero dependencies (plain strings
and numbers) and so carries none of the "distinct type identity"
problem that keeps map-related code duplicated per app instead of
shared (see [ARCHITECTURE.md](ARCHITECTURE.md)).
