import { NavLink } from 'react-router';
import type { ReactNode } from 'react';

import { isMobileDevice } from '../deviceDetection';
import InstallAppBanner from './InstallAppBanner';
import MobileRedirectBanner, { MOBILE_APP_URL } from './MobileRedirectBanner';

const NAV_LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/geocode', label: 'Geocode' },
  { to: '/reverse-geocode', label: 'Reverse geocode' },
  { to: '/batch', label: 'Batch' },
  { to: '/plan-quota', label: 'Plan & quota' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/progress', label: 'Progress' },
  { to: '/help', label: 'Help' },
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
      {showMobileRedirect ? <MobileRedirectBanner /> : <InstallAppBanner />}
      <nav className="nav">
        <div className="nav-brand">Meridian</div>
        {NAV_LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            style={({ isActive }) => (isActive ? { color: 'var(--color-accent)' } : undefined)}
          >
            {link.label}
          </NavLink>
        ))}
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
