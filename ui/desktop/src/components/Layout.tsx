import { useState } from 'react';
import { NavLink } from 'react-router';
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

  // Only matters below the CSS breakpoint (see .nav-toggle/.nav-links in
  // styles.css) -- above it .nav-links is always visible regardless of
  // this, so there's no need to reset it on resize.
  const [menuOpen, setMenuOpen] = useState(false);

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
      {showMobileRedirect ? <MobileRedirectBanner /> : <InstallAppBanner />}
      <nav className="nav">
        <div className="nav-brand">
          <BrandMark size={26} />
          Meridian
        </div>
        <button
          type="button"
          className="nav-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="nav-links"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            {menuOpen ? (
              <path
                d="M3 3 L15 15 M15 3 L3 15"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M2 4.5 H16 M2 9 H16 M2 13.5 H16"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>
        <div id="nav-links" className={`nav-links${menuOpen ? ' nav-links-open' : ''}`}>
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-item-tile">
                <Icon name={link.icon} size={16} />
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
    </div>
  );
}
