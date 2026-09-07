import { NavLink } from 'react-router';

import { Icon } from './icons';

// Plan & quota/Pricing/Progress/Help are account/info pages, not core
// geocoding tools -- same reasoning as BatchTabs.tsx, and the same fix:
// a page-level tab strip instead of a nav dropdown for switching
// between them, so all four render this at the top.
const TABS = [
  { to: '/plan-quota', label: 'Plan & quota', icon: 'planQuota' as const },
  { to: '/pricing', label: 'Pricing', icon: 'pricing' as const },
  { to: '/progress', label: 'Progress', icon: 'progress' as const },
  { to: '/help', label: 'Help', icon: 'help' as const },
];

export default function AccountTabs() {
  return (
    <nav className="page-tabs" aria-label="Account">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `page-tab${isActive ? ' active' : ''}`}>
          <Icon name={tab.icon} size={14} />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
