import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';

import { getRoadAlertsTestTools } from '../../../shared/api/client';
import { Icon } from './icons';

// Road Alerts, Hazards in the Neighborhood, and Weighted Point Test all live under
// one "Road Alerts" nav entry (see Layout.tsx) rather than three separate
// top-level items -- same reasoning as BatchTabs.tsx: none of these are
// standalone destinations on their own, so all three render this same tab
// strip at the top to stay one click apart regardless of which one you
// landed on.
const TABS = [
  { to: '/road-alerts', label: 'Road Alerts', icon: 'roadAlerts' as const },
  { to: '/road-alerts-home-board', label: 'Hazards in the Neighborhood', icon: 'neighborhood' as const },
  { to: '/road-alert-test', label: 'Weighted Point Test', icon: 'weightedPoints' as const },
  { to: '/road-alerts-alarm-test', label: 'Raising Alarm', icon: 'roadAlerts' as const },
];

// The sandbox (test hazards/points, simulated drives) only works where
// the server has its developer test tools switched on -- so its tab only
// appears there, never on production. Asked once per page load and shared
// by every tab strip, rather than once per Road Alerts page visited.
const SANDBOX_TAB = { to: '/road-alerts-sandbox', label: 'Sandbox', icon: 'findPlaces' as const };
let sandboxAvailable: Promise<boolean> | null = null;
function isSandboxAvailable(): Promise<boolean> {
  sandboxAvailable ??= getRoadAlertsTestTools()
    .then((tools) => tools.testRoadSignals || tools.testWeightedPoints)
    .catch(() => false);
  return sandboxAvailable;
}

/** Test-only: forget the cached answer so each test asks again. */
export function resetSandboxAvailabilityForTests(): void {
  sandboxAvailable = null;
}

export default function RoadAlertsTabs() {
  const [showSandbox, setShowSandbox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isSandboxAvailable().then((available) => {
      if (!cancelled) setShowSandbox(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tabs = showSandbox ? [...TABS, SANDBOX_TAB] : TABS;
  return (
    <nav className="page-tabs page-tabs-compact" aria-label="Road Alerts tools">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `page-tab${isActive ? ' active' : ''}`}>
          <Icon name={tab.icon} size={12} />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
