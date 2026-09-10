import { useCallback, useMemo, useState } from 'react';

import { getWeightedPointCandidates, registerRoadAlerts } from '../../../shared/api/client';
import type { WeightedPointCandidate } from '../../../shared/api/types';
import PageHeader from '../components/PageHeader';
import RoadAlertsSandboxMap, { type SandboxPoint } from '../components/RoadAlertsSandboxMap';

const QUALIFIED_COLOR = '#3fb1ce';
const CANDIDATE_COLOR = '#c9a227';

function timeAgoLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'time unknown';
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// A standalone lookup tool, not a sign-in: unlike RoadAlertsRegistration
// (used on the real Road Alerts page), this deliberately never touches
// roadAlertsStorage.ts's shared localStorage account -- typing an email
// here to check its weighted points shouldn't change which account the
// rest of the app considers "signed in".
export default function RoadAlertsTest() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState<WeightedPointCandidate[] | null>(null);
  const [tier, setTier] = useState<{ qualifyingWindowDays: number; minPingsToQualify: number } | null>(null);
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
      const result = await getWeightedPointCandidates({ email: account.email, serviceKey: account.serviceKey });
      setPoints(result.points);
      setTier(result.tier);
      setLookedUpEmail(account.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look up weighted points.');
      setPoints(null);
      setTier(null);
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
        color: p.qualified ? QUALIFIED_COLOR : CANDIDATE_COLOR,
        label: `${p.qualified ? 'Qualified' : 'Candidate'} (weight ${p.weight.toFixed(2)})${
          p.tlid ? ` -- TLID ${p.tlid}` : ''
        }`,
      })),
    [points]
  );

  const qualifiedCount = points?.filter((p) => p.qualified).length ?? 0;

  return (
    <div>
      <PageHeader icon="roadAlerts">Road Alert Test</PageHeader>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Look up every weighted-point candidate Road Alerts has tracked for an account while driving --
        both <em>qualified</em> points (pinged enough times within the account's own rolling window,
        shown in teal) and <em>candidates</em> still short of that bar (shown in amber). For reviewing
        the qualification logic itself, not a real driving feature.
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

      {points !== null && tier !== null && (
        <>
          <p className="text-muted" style={{ marginBottom: 'var(--space-3)' }}>
            {points.length === 0
              ? `No tracked points yet for ${lookedUpEmail}.`
              : `${qualifiedCount} of ${points.length} point${points.length === 1 ? '' : 's'} qualified for ${lookedUpEmail} -- needs ${
                  tier.minPingsToQualify
                } pings within a ${tier.qualifyingWindowDays}-day window.`}
          </p>
          <RoadAlertsSandboxMap points={mapPoints} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
            {points.map((point, i) => (
              <div key={i} className="card elev-sm">
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}
                >
                  <span className={`tag ${point.qualified ? 'tag-accent' : 'tag-neutral'}`}>
                    {point.qualified ? 'Qualified' : 'Candidate'}
                  </span>
                  <span className="card-kicker">last pinged {timeAgoLabel(point.lastPingedAt)}</span>
                </div>
                <p className="card-body" style={{ margin: 0 }}>
                  {point.windowPingCount} of {tier.minPingsToQualify} pings needed, within the current{' '}
                  {tier.qualifyingWindowDays}-day window (started {timeAgoLabel(point.windowStartedAt)}) -- weight{' '}
                  {point.weight.toFixed(2)}
                  {point.tlid ? `, TLID ${point.tlid}` : ''}.
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
