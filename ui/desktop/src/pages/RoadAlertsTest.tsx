import { useCallback, useMemo, useState } from 'react';

import { getWeightedPoints, registerRoadAlerts } from '../../../shared/api/client';
import type { WeightedPointRecord } from '../../../shared/api/types';
import PageHeader from '../components/PageHeader';
import RoadAlertsSandboxMap, { type SandboxPoint } from '../components/RoadAlertsSandboxMap';
import RoadAlertsTabs from '../components/RoadAlertsTabs';

// A standalone lookup tool, not a sign-in: unlike RoadAlertsRegistration
// (used on the real Road Alerts page), this deliberately never touches
// roadAlertsStorage.ts's shared localStorage account -- typing an email
// here to check its weighted points shouldn't change which account the
// rest of the app considers "signed in".
export default function RoadAlertsTest() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState<WeightedPointRecord[] | null>(null);
  const [lookedUpEmail, setLookedUpEmail] = useState<string | null>(null);

  const handleLookup = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter an email address.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Idempotent: an already-registered email gets its existing service
      // key back, never a new one -- this is what authorizes the lookup
      // below, same as the real Road Alerts page's own sign-in.
      const account = await registerRoadAlerts(trimmed);
      const result = await getWeightedPoints({ email: account.email, serviceKey: account.serviceKey });
      setPoints(result.weightedPoints);
      setLookedUpEmail(account.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look up weighted points.');
      setPoints(null);
      setLookedUpEmail(null);
    } finally {
      setLoading(false);
    }
  }, [email]);

  const mapPoints = useMemo<SandboxPoint[]>(
    () =>
      (points ?? []).map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        color: '#3fb1ce',
        label: `Weighted point (weight ${p.weight.toFixed(2)})${p.tlid ? ` -- TLID ${p.tlid}` : ''}`,
      })),
    [points]
  );

  return (
    <div>
      <PageHeader icon="roadAlerts">Weighted Point Test</PageHeader>
      <RoadAlertsTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Look up the real weighted points Road Alerts has collected for an account while driving --
        for reviewing what's accumulated so far, not a real driving feature. Only <em>qualified</em>{' '}
        points show up here (pinged enough times within a rolling week); a point still being tracked
        but not yet qualified won't appear yet.
      </p>

      <div className="card elev-sm" style={{ maxWidth: 480, marginBottom: 'var(--space-4)' }}>
        <div className="field">
          <label>Email</label>
          <input
            className="input"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleLookup();
            }}
            disabled={loading}
          />
        </div>

        {error && (
          <p className="card-body" style={{ color: '#a4402a', margin: '0 0 var(--space-3)' }}>
            {error}
          </p>
        )}

        <button className="btn btn-primary" onClick={handleLookup} disabled={loading}>
          {loading ? 'Looking up…' : 'Show weighted points'}
        </button>
      </div>

      {points !== null && (
        <>
          <p className="text-muted" style={{ marginBottom: 'var(--space-3)' }}>
            {points.length === 0
              ? `No qualified weighted points yet for ${lookedUpEmail}.`
              : `${points.length} weighted point${points.length === 1 ? '' : 's'} for ${lookedUpEmail}.`}
          </p>
          <RoadAlertsSandboxMap points={mapPoints} />
        </>
      )}
    </div>
  );
}
