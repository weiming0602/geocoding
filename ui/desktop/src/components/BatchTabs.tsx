import { NavLink } from 'react-router';

import { Icon } from './icons';

// Find places and Import addresses both exist to feed Batch geocode an
// address list (their own "Send to Batch" actions), not standalone
// destinations -- rather than a nav dropdown for the choice (see
// Layout.tsx), all three pages render this same tab strip at the top so
// switching between them stays one click away regardless of which one
// you landed on.
const TABS = [
  { to: '/batch', label: 'Batch geocode', icon: 'batch' as const },
  { to: '/import-addresses', label: 'Import addresses', icon: 'importAddresses' as const },
  { to: '/find-places', label: 'Find places', icon: 'findPlaces' as const },
];

export default function BatchTabs() {
  return (
    <nav className="page-tabs" aria-label="Batch tools">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `page-tab${isActive ? ' active' : ''}`}>
          <Icon name={tab.icon} size={14} />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
