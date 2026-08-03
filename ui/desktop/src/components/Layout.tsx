import { NavLink } from 'react-router';
import type { ReactNode } from 'react';

const NAV_LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/geocode', label: 'Geocode' },
  { to: '/reverse-geocode', label: 'Reverse geocode' },
  { to: '/batch', label: 'Batch' },
  { to: '/plan-quota', label: 'Plan & quota' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/help', label: 'Help' },
];

export default function Layout({ children }: { children: ReactNode }) {
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
