import { Link, NavLink, useLocation } from 'react-router';
import type { ReactNode } from 'react';

import { isMobileDevice } from '../deviceDetection';
import { BrandMark, Icon, type IconName } from './icons';
import InstallAppBanner from './InstallAppBanner';
import MobileRedirectBanner, { MOBILE_APP_URL } from './MobileRedirectBanner';
import { GEOCODING_SITE_URL, ROAD_ALERTS_MOVED, ROAD_ALERTS_SITE_URL, SITE, siteUrl } from '../siteConfig';

// matchPrefixes: extra routes (beyond `to` itself) that should still
// highlight this entry -- Batch and Account both cover several pages
// that link to each other via their own page-level tab strip
// (BatchTabs.tsx/AccountTabs.tsx) rather than a nav dropdown, so the
// single nav entry for each needs to read as active from any of them.
// `href` instead of `to`: a link to the other Meridian site (see
// siteConfig.ts), rendered as a plain <a>, never highlighted as active.
type NavEntry = { to: string; label: string; icon: IconName; end?: boolean; matchPrefixes?: string[]; href?: string };

// Kept in sync with BatchTabs.tsx/AccountTabs.tsx/RoadAlertsTabs.tsx's own
// TABS lists by hand -- these are short and change rarely enough that a
// shared import would be more indirection than it's worth.
const BATCH_ROUTES = ['/batch', '/import-addresses', '/find-places'];
const ACCOUNT_ROUTES = ['/plan-quota', '/pricing', '/progress', '/api-docs', '/help'];
const ROAD_ALERTS_ROUTES = ['/road-alerts', '/road-alerts-home-board', '/road-alert-test', '/road-alerts-alarm-test', '/road-alerts-sandbox'];

// Find places and Import addresses both exist to feed Batch geocode an
// address list (their own "Send to Batch" actions); Plan & quota/
// Pricing/Progress/Help are account/info pages, not core geocoding
// tools; Hazards in the Neighborhood and Weighted Point Test are both lookup
// tools built on top of the same real Road Alerts data, not standalone
// destinations. None of these three groups needed a full nav dropdown --
// each group's pages already link to each other via a page-level tab
// strip, so the primary nav only needs one entry per group
// (matchPrefixes keeps it highlighted from any page in the group).
const GEOCODING_NAV_ENTRIES: NavEntry[] = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/geocode', label: 'Geocode', icon: 'geocode' },
  { to: '/reverse-geocode', label: 'Reverse geocode', icon: 'reverseGeocode' },
  { to: '/batch', label: 'Batch', icon: 'batch', matchPrefixes: BATCH_ROUTES },
  ROAD_ALERTS_MOVED
    ? { to: '/road-alerts', label: 'Road Alerts ↗', icon: 'roadAlerts', href: siteUrl(ROAD_ALERTS_SITE_URL, '/') }
    : { to: '/road-alerts', label: 'Road Alerts', icon: 'roadAlerts', matchPrefixes: ROAD_ALERTS_ROUTES },
  { to: '/plan-quota', label: 'Account', icon: 'planQuota', matchPrefixes: ACCOUNT_ROUTES },
];

// alerts.meridiangeocoding.com's own nav: Road Alerts is home (its other
// tools stay one click away via RoadAlertsTabs), plus the way back.
const ROAD_ALERTS_NAV_ENTRIES: NavEntry[] = [
  // Not the Neighborhood page -- it has its own entry right next to this one.
  { to: '/', label: 'Road Alerts', icon: 'roadAlerts', end: true, matchPrefixes: ROAD_ALERTS_ROUTES.filter((r) => r !== '/road-alerts-home-board') },
  { to: '/road-alerts-home-board', label: 'Hazards in the Neighborhood', icon: 'neighborhood' },
  { to: '/help', label: 'Help', icon: 'help' },
  { to: '/geocoding', label: 'Geocoding ↗', icon: 'geocode', href: GEOCODING_SITE_URL },
];

const NAV_ENTRIES = SITE === 'road-alerts' ? ROAD_ALERTS_NAV_ENTRIES : GEOCODING_NAV_ENTRIES;

// Footer links: the geocoding site's full set, or just what applies to
// Road Alerts on its own site.
const FOOTER_LINKS: [string, string][] =
  SITE === 'road-alerts'
    ? [
        ['/help', 'Help'],
        ['/privacy', 'Privacy Policy'],
        ['/terms', 'Terms of Use'],
      ]
    : [
        ['/pricing', 'Pricing'],
        ['/progress', 'Progress'],
        ['/api-docs', 'API Docs'],
        ['/help', 'Help'],
        ['/privacy', 'Privacy Policy'],
        ['/terms', 'Terms of Use'],
        ['/sitemap', 'Site Map'],
      ];

export default function Layout({ children }: { children: ReactNode }) {
  // Showing both banners would be a contradictory pitch to the same
  // mobile visitor ("install this page" vs. "go use a different app")
  // -- the redirect banner only wins that slot once a real mobile URL
  // is actually configured; otherwise install-as-PWA stays the only
  // option, same as before this existed.
  const showMobileRedirect = Boolean(MOBILE_APP_URL) && isMobileDevice();

  // Unlike MobileRedirectBanner (which stays off entirely with no real
  // VITE_MOBILE_APP_URL set -- no mobile deployment exists yet), this
  // footer toggle also falls back to the local Expo web dev server in
  // dev builds only (import.meta.env.DEV, Vite's own flag -- stripped
  // out of a production build automatically, so this default can't leak
  // into a real deploy even if VITE_MOBILE_APP_URL is forgotten there).
  // Anyone, not just a detected mobile device, can use it to jump over
  // and try the other app while both are running locally.
  const mobileAppUrl = MOBILE_APP_URL || (import.meta.env.DEV ? 'http://localhost:8081' : undefined);

  const location = useLocation();

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'var(--font-body)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* A giant, half-cropped BrandMark sitting fixed in the corner --
          quiet enough (7% opacity, neutral text color, no fill -- just
          the same outline strokes the real logo uses) to read as texture
          behind the page rather than a second logo competing with the
          real one in the nav. Fixed (not absolute) so it stays put as a
          backdrop while the page scrolls, like wallpaper rather than
          part of the document; a deliberate tilt gives it some life
          instead of sitting dead-center-symmetrical. No z-index -- a
          fixed-position element with a *negative* z-index and no
          positioned ancestor establishing its own stacking context
          renders behind the root stacking context entirely (invisible),
          not just behind sibling content; default z-index:auto plus DOM
          order (this div first) already paints it behind the nav/content
          that follow it. pointerEvents: 'none' so it never intercepts a
          click meant for whatever's drawn over it. */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          right: '-320px',
          bottom: '-320px',
          width: 800,
          height: 800,
          color: 'var(--color-text)',
          opacity: 0.07,
          transform: 'rotate(-22deg)',
          pointerEvents: 'none',
        }}
      >
        <BrandMark size={800} />
      </div>

      {showMobileRedirect ? <MobileRedirectBanner /> : <InstallAppBanner />}
      <nav className="nav">
        <div className="nav-brand">
          <BrandMark size={38} />
          {SITE === 'road-alerts' ? 'Meridian Road Alerts' : 'Meridian'}
        </div>
        <div className="nav-links">
          {NAV_ENTRIES.map((entry) =>
            entry.href ? (
              <a key={entry.to} href={entry.href} className="nav-item">
                <span className="nav-item-tile">
                  <Icon name={entry.icon} size={12} />
                </span>
                {entry.label}
              </a>
            ) : (
              <NavLink
                key={entry.to}
                to={entry.to}
                end={entry.end}
                className={({ isActive }) => {
                  const active = isActive || Boolean(entry.matchPrefixes?.includes(location.pathname));
                  return `nav-item${active ? ' active' : ''}`;
                }}
              >
                <span className="nav-item-tile">
                  <Icon name={entry.icon} size={12} />
                </span>
                {entry.label}
              </NavLink>
            )
          )}
        </div>
      </nav>
      <div
        style={{
          flex: 1,
          maxWidth: '1240px',
          width: '100%',
          margin: '0 auto',
          padding: 'var(--space-8) var(--space-6)',
          boxSizing: 'border-box',
        }}
      >
        {children}
      </div>

      <footer
        style={{
          borderTop: '1px solid var(--color-divider)',
          padding: 'var(--space-6) var(--space-4)',
        }}
      >
        <div
          style={{
            maxWidth: '1240px',
            width: '100%',
            margin: '0 auto',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--space-4)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <BrandMark size={20} />
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)' }}>
              Meridian
            </span>
          </div>
          {mobileAppUrl && (
            <a href={mobileAppUrl} className="btn btn-ghost" style={{ fontSize: 13, padding: '4px 10px' }}>
              📱 Switch to mobile app
            </a>
          )}
        </div>

        {/* Every footer link in one row, separated from the brand row
            above by a divider -- previously split into two separate rows
            (site links, then a second "legal strip" for Privacy/Terms/
            Site Map), which repeated the same row structure twice for no
            real reason once the tagline/duplicate copyright above it were
            trimmed down. */}
        <div
          style={{
            maxWidth: '1240px',
            width: '100%',
            margin: 'var(--space-4) auto 0',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--color-divider)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
          }}
        >
          <span className="text-muted" style={{ fontSize: 12 }}>
            &copy; {new Date().getFullYear()} Meridian. All rights reserved.
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', fontSize: 12, flexWrap: 'wrap' }}>
            {FOOTER_LINKS.map(([to, label]) => (
              <Link key={to} to={to} className="text-muted">
                {label}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
