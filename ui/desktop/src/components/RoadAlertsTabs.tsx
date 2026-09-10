import { NavLink } from 'react-router';

import { Icon } from './icons';

// Road Alerts, Hazards Near Home, and Weighted Point Test all live under
// one "Road Alerts" nav entry (see Layout.tsx) rather than three separate
// top-level items -- same reasoning as BatchTabs.tsx: none of these are
// standalone destinations on their own, so all three render this same tab
// strip at the top to stay one click apart regardless of which one you
// landed on.
const TABS = [
  { to: '/road-alerts', label: 'Road Alerts', icon: 'roadAlerts' as const },
  { to: '/road-alerts-home-board', label: 'Hazards Near Home', icon: 'roadAlerts' as const },
  { to: '/road-alert-test', label: 'Weighted Point Test', icon: 'roadAlerts' as const },
];

export default function RoadAlertsTabs() {
  return (
    <nav className="page-tabs" aria-label="Road Alerts tools">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `page-tab${isActive ? ' active' : ''}`}>
          <Icon name={tab.icon} size={14} />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
