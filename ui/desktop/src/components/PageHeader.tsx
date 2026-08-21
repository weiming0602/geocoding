import type { ReactNode } from 'react';

import { Icon, type IconName } from './icons';

// Every page-header tile is amber (the "current page" color) -- this is
// always the page you're already on, so it's always the active one; see
// Layout.tsx's nav-item tiles for the teal default/amber-active split.
export default function PageHeader({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
      <div
        style={{
          width: 52,
          height: 52,
          flex: 'none',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--color-icon-active)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={28} />
      </div>
      <h1 style={{ margin: 0 }}>{children}</h1>
    </div>
  );
}
