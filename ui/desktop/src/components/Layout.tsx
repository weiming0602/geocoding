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
    </div>
  );
}
