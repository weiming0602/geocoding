import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import type { ReactNode } from 'react';

import { isMobileDevice } from '../deviceDetection';
import { BrandMark, Icon, type IconName } from './icons';
import InstallAppBanner from './InstallAppBanner';
import MobileRedirectBanner, { MOBILE_APP_URL } from './MobileRedirectBanner';

type NavSubLink = { to: string; label: string; icon: IconName };
type NavEntry =
  // matchPrefixes: extra routes (beyond `to` itself) that should still
  // highlight this entry -- only Batch needs this, since Import
  // addresses/Find places moved from a nav dropdown (see BATCH_ROUTES
  // below) to BatchTabs.tsx's page-level tab strip, but the single
  // "Batch" nav entry should still read as active from any of the three.
  | { kind: 'link'; to: string; label: string; icon: IconName; end?: boolean; matchPrefixes?: string[] }
  | { kind: 'group'; label: string; icon: IconName; items: NavSubLink[] };

// Kept in sync with BatchTabs.tsx's own TABS list by hand -- both are
// short and change rarely enough that a shared import would be more
// indirection than it's worth.
const BATCH_ROUTES = ['/batch', '/import-addresses', '/find-places'];

// Find places and Import addresses both exist to feed Batch geocode an
// address list (their own "Send to Batch" actions), not standalone
// destinations -- switching between all three lives in BatchTabs.tsx's
// page-level tab strip (rendered at the top of each of the three pages)
// rather than a nav dropdown, so this is a single link, not a group.
// The account/info pages still get the dropdown treatment: none of them
// are a core geocoding tool, so they don't need equal billing with
// Geocode/Reverse geocode/Batch/Road Alerts in the primary nav, and
// (unlike Batch's three pages) they don't already link to each other.
const NAV_ENTRIES: NavEntry[] = [
  { kind: 'link', to: '/', label: 'Overview', icon: 'overview', end: true },
  { kind: 'link', to: '/geocode', label: 'Geocode', icon: 'geocode' },
  { kind: 'link', to: '/reverse-geocode', label: 'Reverse geocode', icon: 'reverseGeocode' },
  { kind: 'link', to: '/batch', label: 'Batch', icon: 'batch', matchPrefixes: BATCH_ROUTES },
  { kind: 'link', to: '/road-alerts', label: 'Road Alerts', icon: 'roadAlerts' },
  { kind: 'link', to: '/road-alert-test', label: 'Road Alert Test', icon: 'roadAlerts' },
  {
    kind: 'group',
    label: 'Account',
    icon: 'planQuota',
    items: [
      { to: '/plan-quota', label: 'Plan & quota', icon: 'planQuota' },
      { to: '/pricing', label: 'Pricing', icon: 'pricing' },
      { to: '/progress', label: 'Progress', icon: 'progress' },
      { to: '/help', label: 'Help', icon: 'help' },
    ],
  },
];

// A single nav entry covering several related pages (e.g. every page
// that feeds into Batch geocode) -- a trigger button styled like a
// plain nav-item plus a floating panel of the real sub-page links.
// Stays highlighted whenever the current route matches any of its
// items, closes on an outside click/Escape/navigating, so collapsing
// three-plus pages into one nav entry doesn't cost the "you are here"
// signal a plain top-level link gives for free.
function NavGroup({ label, icon, items }: { label: string; icon: IconName; items: NavSubLink[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const isActive = items.some((item) => location.pathname === item.to);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="nav-dropdown" ref={containerRef}>
      <button
        type="button"
        className={`nav-item nav-item-dropdown-trigger${isActive ? ' active' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="nav-item-tile">
          <Icon name={icon} size={12} />
        </span>
        {label}
        <span className="nav-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="nav-dropdown-panel" role="menu">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              role="menuitem"
              className={({ isActive }) => `nav-dropdown-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-item-tile">
                <Icon name={item.icon} size={12} />
              </span>
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

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
          <BrandMark size={32} />
          Meridian
        </div>
        <div className="nav-links">
          {NAV_ENTRIES.map((entry) =>
            entry.kind === 'group' ? (
              <NavGroup key={entry.label} label={entry.label} icon={entry.icon} items={entry.items} />
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
            <span className="text-muted" style={{ fontSize: 13 }}>
              &copy; {new Date().getFullYear()} Meridian. Built for Maine &amp; New Hampshire.
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', fontSize: 13 }}>
            <Link to="/pricing" className="text-muted">
              Pricing
            </Link>
            <Link to="/progress" className="text-muted">
              Progress
            </Link>
            <Link to="/help" className="text-muted">
              Help
            </Link>
            {mobileAppUrl && (
              <a href={mobileAppUrl} className="btn btn-ghost" style={{ fontSize: 13, padding: '4px 10px' }}>
                📱 Switch to mobile app
              </a>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
