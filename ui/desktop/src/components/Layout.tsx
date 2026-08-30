import { Link, NavLink } from 'react-router';
import type { ReactNode } from 'react';

import { isMobileDevice } from '../deviceDetection';
import { BrandMark, Icon, type IconName } from './icons';
import InstallAppBanner from './InstallAppBanner';
import MobileRedirectBanner, { MOBILE_APP_URL } from './MobileRedirectBanner';

const NAV_LINKS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/geocode', label: 'Geocode', icon: 'geocode' },
  { to: '/reverse-geocode', label: 'Reverse geocode', icon: 'reverseGeocode' },
  { to: '/find-places', label: 'Find places', icon: 'findPlaces' },
  { to: '/road-alerts', label: 'Road Alerts', icon: 'roadAlerts' },
  { to: '/import-addresses', label: 'Import addresses', icon: 'importAddresses' },
  { to: '/batch', label: 'Batch', icon: 'batch' },
  { to: '/plan-quota', label: 'Plan & quota', icon: 'planQuota' },
  { to: '/pricing', label: 'Pricing', icon: 'pricing' },
  { to: '/progress', label: 'Progress', icon: 'progress' },
  { to: '/help', label: 'Help', icon: 'help' },
];

export default function Layout({ children }: { children: ReactNode }) {
  // Showing both banners would be a contradictory pitch to the same
  // mobile visitor ("install this page" vs. "go use a different app")
  // -- the redirect banner only wins that slot once a real mobile URL
  // is actually configured; otherwise install-as-PWA stays the only
  // option, same as before this existed.
  const showMobileRedirect = Boolean(MOBILE_APP_URL) && isMobileDevice();

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
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-item-tile">
                <Icon name={link.icon} size={12} />
              </span>
              {link.label}
            </NavLink>
          ))}
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
          <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: 13 }}>
            <Link to="/pricing" className="text-muted">
              Pricing
            </Link>
            <Link to="/progress" className="text-muted">
              Progress
            </Link>
            <Link to="/help" className="text-muted">
              Help
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
