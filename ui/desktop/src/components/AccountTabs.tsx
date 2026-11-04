import { NavLink } from 'react-router';

import { Icon, type IconName } from './icons';

// Plan & quota/Pricing/Progress/Help are account/info pages, not core
// geocoding tools -- same reasoning as BatchTabs.tsx, and the same fix:
// a page-level tab strip instead of a nav dropdown for switching
// between them, so all four render this at the top.
// ownerOnly: shown only in a browser that has unlocked the owner pages
// (the admin passcode the /owner dashboard remembers) -- everyone else
// never sees the tab. The data itself is gated server-side either way.
const TABS: { to: string; label: string; icon: IconName; ownerOnly?: boolean }[] = [
  { to: '/plan-quota', label: 'Plan & quota', icon: 'planQuota' as const },
  { to: '/pricing', label: 'Pricing', icon: 'pricing' as const },
  { to: '/progress', label: 'Progress', icon: 'progress' as const },
  { to: '/api-docs', label: 'API Docs', icon: 'help' as const },
  { to: '/help', label: 'Help', icon: 'help' as const },
  { to: '/training-data', label: 'Training data', icon: 'findPlaces' as const, ownerOnly: true },
];

export const ADMIN_PASSCODE_STORAGE_KEY = 'meridianAdminPasscode';

function isOwnerBrowser(): boolean {
  try {
    return Boolean(localStorage.getItem(ADMIN_PASSCODE_STORAGE_KEY));
  } catch {
    return false;
  }
}

export default function AccountTabs() {
  const owner = isOwnerBrowser();
  return (
    <nav className="page-tabs" aria-label="Account">
      {TABS.filter((tab) => owner || !tab.ownerOnly).map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `page-tab${isActive ? ' active' : ''}`}>
          <Icon name={tab.icon} size={14} />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
