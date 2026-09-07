type SiteMapLink = { to: string; label: string; description: string };

const TOOLS: SiteMapLink[] = [
  { to: '/', label: 'Overview', description: "What Meridian is and where to start." },
  { to: '/geocode', label: 'Geocode', description: 'Address → coordinates.' },
  { to: '/reverse-geocode', label: 'Reverse geocode', description: 'Coordinates → address.' },
  { to: '/batch', label: 'Batch geocode', description: 'Geocode a whole list of addresses at once.' },
  { to: '/import-addresses', label: 'Import addresses', description: 'Turn a messy spreadsheet export into a clean address list for Batch.' },
  { to: '/find-places', label: 'Find places', description: 'Search for a kind of place nearby and export the results as an address list.' },
  { to: '/road-alerts', label: 'Road Alerts', description: 'Live traffic hazards near you, spoken aloud as you approach.' },
];

const ACCOUNT: SiteMapLink[] = [
  { to: '/plan-quota', label: 'Plan & quota', description: 'Check how much of your monthly Batch geocoding quota you have left.' },
  { to: '/pricing', label: 'Pricing', description: 'Buy additional monthly Batch geocoding quota.' },
  { to: '/progress', label: 'Progress', description: "A running record of what's shipped so far." },
  { to: '/help', label: 'Help', description: 'How Meridian actually works, plus a way to send us feedback.' },
];

const LEGAL: SiteMapLink[] = [
  { to: '/privacy', label: 'Privacy Policy', description: 'What we collect and what we do with it.' },
  { to: '/terms', label: 'Terms of Use', description: 'The basics of using Meridian.' },
  { to: '/sitemap', label: 'Site Map', description: 'This page.' },
];

function SiteMapSection({ title, links }: { title: string; links: SiteMapLink[] }) {
  return (
    <div style={{ marginBottom: 'var(--space-6)' }}>
      <h2 style={{ marginBottom: 'var(--space-3)' }}>{title}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {links.map((link) => (
          <div key={link.to}>
            <a href={`#${link.to}`} style={{ fontWeight: 600 }}>
              {link.label}
            </a>
            <p className="text-muted" style={{ margin: '2px 0 0', fontSize: 14 }}>
              {link.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SiteMap() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Site Map</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Every page in Meridian, in one place.
      </p>

      <SiteMapSection title="Tools" links={TOOLS} />
      <SiteMapSection title="Account" links={ACCOUNT} />
      <SiteMapSection title="Legal" links={LEGAL} />
    </div>
  );
}
