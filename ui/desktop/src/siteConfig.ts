// One codebase, two sites (same pattern as VITE_API_BASE_URL in main.tsx):
//   - the geocoding site, meridiangeocoding.com (the default build), and
//   - the Road Alerts site, alerts.meridiangeocoding.com, built with
//     `npm run build:alerts` / `npm run dev:alerts` (Vite mode
//     "road-alerts", which loads .env.road-alerts -> VITE_APP=road-alerts).
// Both talk to the same API (api.meridiangeocoding.com), whose
// /road-alerts* and /road-signals* paths nginx can route to the separate
// Road Alerts process -- see ops/nginx-api.conf.example.

export type SiteKind = 'geocoding' | 'road-alerts';

export const SITE: SiteKind = import.meta.env.VITE_APP === 'road-alerts' ? 'road-alerts' : 'geocoding';

function withoutTrailingSlash(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

// Where Road Alerts lives once it has its own site. Set this on the
// GEOCODING build only after alerts.meridiangeocoding.com is live: until
// then it's empty and the geocoding site keeps serving Road Alerts itself,
// exactly as before the split -- so deploying this code changes nothing
// on its own.
export const ROAD_ALERTS_SITE_URL = withoutTrailingSlash(import.meta.env.VITE_ROAD_ALERTS_URL as string | undefined);

// The Road Alerts site's link back to geocoding.
export const GEOCODING_SITE_URL =
  withoutTrailingSlash(import.meta.env.VITE_GEOCODING_URL as string | undefined) || 'https://www.meridiangeocoding.com';

// Every Road Alerts page's route -- shared by both sites' routing.
export const ROAD_ALERTS_PATHS = [
  '/road-alerts',
  '/road-alerts-home-board',
  '/road-alert-test',
  '/road-alerts-alarm-test',
  '/road-alerts-sandbox',
];

/** True when this geocoding build should send Road Alerts visitors to their own site. */
export const ROAD_ALERTS_MOVED = SITE === 'geocoding' && ROAD_ALERTS_SITE_URL !== '';

/** A hash-router URL on another site, e.g. siteUrl('https://alerts…', '/road-alerts') -> 'https://alerts…/#/road-alerts'. */
export function siteUrl(base: string, path: string): string {
  return `${base}/#${path}`;
}
