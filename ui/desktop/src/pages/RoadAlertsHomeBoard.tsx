import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, getRoadSignals, getWeightedPoints, reverseGeocode } from '../../../shared/api/client';
import { HAZARD_CATEGORY_ICONS, HAZARD_CATEGORY_LABELS } from '../../../shared/hazardCategories';
import type { RoadSignal, RoadSignalSeverity } from '../../../shared/api/types';
import PageHeader from '../components/PageHeader';
import RoadAlertsRegistration from '../components/RoadAlertsRegistration';
import RoadAlertsSandboxMap, { type SandboxPoint } from '../components/RoadAlertsSandboxMap';
import RoadAlertsTabs from '../components/RoadAlertsTabs';
import { clearStoredAccount, getStoredAccount, type StoredRoadAlertsAccount } from '../roadAlertsStorage';

// Same radius RoadAlerts.tsx polls with while driving -- there's no
// reason a passive board centered on a fixed area needs a different one.
const RADIUS_METERS = 10000;

const SEVERITY_LABELS: Record<RoadSignalSeverity, string> = {
  serious: 'Serious',
  need_to_know: 'Need to know',
  proximity: 'Proximity',
  fun_to_know: 'Fun to know',
};

const SEVERITY_TAG_CLASS: Record<RoadSignalSeverity, string> = {
  serious: 'tag-danger',
  need_to_know: 'tag-accent',
  proximity: 'tag-accent-2',
  fun_to_know: 'tag-neutral',
};

function freshnessLabel(signal: RoadSignal): string {
  const raw = signal.lastUpdatedAt || signal.createdAt;
  if (!raw) return 'time unknown';
  const ms = Date.now() - new Date(raw).getTime();
  if (Number.isNaN(ms)) return 'time unknown';
  if (ms < 60_000) return 'updated just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days}d ago`;
}

// There's no stored "home address" anywhere in this app (see
// RoadAlertsTest.tsx's own lack of one) -- the centroid of an account's
// own qualified weighted points (real, repeated driving locations) is
// the best proxy for "where this person lives" without asking them to
// type an address anywhere.
function centroid(points: { latitude: number; longitude: number }[]): { latitude: number; longitude: number } {
  const total = points.reduce(
    (acc, p) => ({ latitude: acc.latitude + p.latitude, longitude: acc.longitude + p.longitude }),
    { latitude: 0, longitude: 0 }
  );
  return { latitude: total.latitude / points.length, longitude: total.longitude / points.length };
}

// Uses the same signed-in account as the main Road Alerts tab (see
// roadAlertsStorage.ts) rather than asking for an email every visit --
// the three Road Alerts sub-tabs now read as one feature (RoadAlertsTabs),
// so switching between them shouldn't mean signing in again each time.
export default function RoadAlertsHomeBoard() {
  const [account, setAccount] = useState<StoredRoadAlertsAccount | null>(() => getStoredAccount());
  const [registrationReason, setRegistrationReason] = useState<string | null>(null);
  // Starts true when already signed in -- the load effect below fires
  // immediately on mount in that case, so this avoids a one-frame flash
  // of "not enough driving history" before that fetch actually runs.
  const [loading, setLoading] = useState(() => Boolean(getStoredAccount()));
  const [error, setError] = useState<string | null>(null);
  const [homeArea, setHomeArea] = useState<{ latitude: number; longitude: number } | null>(null);
  const [signals, setSignals] = useState<RoadSignal[] | null>(null);
  const [partial, setPartial] = useState(false);
  // Keyed by signal.id. Reverse geocoding happens after the signals
  // themselves render (a roadway/city is already shown from the 511
  // record itself) -- an unresolved or failed lookup falls back to that
  // existing display rather than blocking the list.
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  const loadHomeBoard = useCallback(async (current: StoredRoadAlertsAccount) => {
    setLoading(true);
    setError(null);
    setSignals(null);
    setHomeArea(null);
    setAddresses({});
    setSelectedSignalId(null);
    try {
      const { weightedPoints } = await getWeightedPoints({ email: current.email, serviceKey: current.serviceKey });
      if (weightedPoints.length === 0) {
        return;
      }
      const area = centroid(weightedPoints);
      const result = await getRoadSignals({
        latitude: area.latitude,
        longitude: area.longitude,
        radiusMeters: RADIUS_METERS,
        email: current.email,
        serviceKey: current.serviceKey,
      });
      setHomeArea(area);
      setSignals(result.signals);
      setPartial(result.partial);

      const withCoordinates = result.signals.filter(
        (s): s is RoadSignal & { latitude: number; longitude: number } =>
          typeof s.latitude === 'number' && typeof s.longitude === 'number'
      );
      if (withCoordinates.length > 0) {
        setAddressesLoading(true);
        const resolved = await Promise.allSettled(
          withCoordinates.map((s) => reverseGeocode({ latitude: s.latitude, longitude: s.longitude }))
        );
        const nextAddresses: Record<string, string> = {};
        resolved.forEach((settled, i) => {
          if (settled.status === 'fulfilled') nextAddresses[withCoordinates[i].id] = settled.value.address;
        });
        setAddresses(nextAddresses);
        setAddressesLoading(false);
      }
    } catch (err) {
      // A stale/invalid stored service key (account deleted, key rotated)
      // -- same recovery as RoadAlerts.tsx's own 404/401 handling.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
        clearStoredAccount();
        setAccount(null);
        setRegistrationReason("We couldn't verify your Road Alerts account -- please register again below.");
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not look up the home board.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Runs once on mount if already signed in, and again whenever a fresh
  // registration completes below -- never on every render, since
  // loadHomeBoard's identity is stable (useCallback with no deps).
  useEffect(() => {
    if (account) loadHomeBoard(account);
  }, [account, loadHomeBoard]);

  const handleUseDifferentEmail = useCallback(() => {
    clearStoredAccount();
    setRegistrationReason(null);
    setAccount(null);
  }, []);

  const mapPoints = useMemo<SandboxPoint[]>(
    () =>
      (signals ?? [])
        .filter((s): s is RoadSignal & { latitude: number; longitude: number } =>
          typeof s.latitude === 'number' && typeof s.longitude === 'number'
        )
        .map((s) => ({
          latitude: s.latitude,
          longitude: s.longitude,
          color: '#a4402a',
          label: `${HAZARD_CATEGORY_LABELS[s.hazardCategory]}${s.roadway ? ` -- ${s.roadway}` : ''}`,
        })),
    [signals]
  );

  const selectedSignal = signals?.find((s) => s.id === selectedSignalId) ?? null;
  const focusPoint =
    selectedSignal && typeof selectedSignal.latitude === 'number' && typeof selectedSignal.longitude === 'number'
      ? { latitude: selectedSignal.latitude, longitude: selectedSignal.longitude }
      : null;

  if (!account) {
    return (
      <div>
        <PageHeader icon="neighborhood">Hazards in the Neighborhood</PageHeader>
        <RoadAlertsTabs />
        <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
          All current hazards near where your account lives -- inferred from the center of your qualified
          weighted points, the routine, repeated locations Road Alerts has learned from actual driving.
        </p>
        <RoadAlertsRegistration onRegistered={setAccount} reason={registrationReason} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader icon="neighborhood">Hazards in the Neighborhood</PageHeader>
      <RoadAlertsTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        All current hazards near where {account.email} lives -- inferred from the center of its
        qualified weighted points, not a typed-in address. An account needs at least one qualified
        weighted point before a home area can be identified.
      </p>

      {error && (
        <p className="card-body" style={{ color: '#a4402a', marginBottom: 'var(--space-3)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <button className="btn btn-primary" onClick={() => loadHomeBoard(account)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button className="btn btn-ghost" onClick={handleUseDifferentEmail}>
          Not you? Use a different email
        </button>
      </div>

      {!loading && signals === null && !error && (
        <p className="text-muted">
          Not enough driving history yet to identify a home area for {account.email} -- drive past the
          same spots a few more times so a weighted point can qualify.
        </p>
      )}

      {homeArea && signals && (
        <>
          {partial && (
            <p className="card-meta" style={{ marginBottom: 'var(--space-4)' }}>
              One or more 511 networks are temporarily unavailable -- showing partial results.
            </p>
          )}
          <h5 className="text-muted" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {signals.length} alert{signals.length === 1 ? '' : 's'} near your home area
          </h5>
          <RoadAlertsSandboxMap points={mapPoints} driverPosition={homeArea} focusPoint={focusPoint} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
            {signals.map((signal) => {
              const hasCoordinates = typeof signal.latitude === 'number' && typeof signal.longitude === 'number';
              const selected = signal.id === selectedSignalId;
              return (
                <div
                  key={signal.id}
                  className="card elev-sm"
                  onClick={hasCoordinates ? () => setSelectedSignalId(signal.id) : undefined}
                  style={{
                    cursor: hasCoordinates ? 'pointer' : undefined,
                    outline: selected ? '2px solid var(--color-accent-500, #3fb1ce)' : undefined,
                  }}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}
                  >
                    <span className="card-kicker">
                      {signal.city ?? signal.county ?? 'location unknown'}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <span className={`tag ${SEVERITY_TAG_CLASS[signal.severity]}`}>
                        {SEVERITY_LABELS[signal.severity]}
                      </span>
                      <span className="card-kicker">{freshnessLabel(signal)}</span>
                    </span>
                  </div>
                  <div className="card-title" style={{ fontSize: 17 }}>
                    <span
                      role="img"
                      aria-label={HAZARD_CATEGORY_LABELS[signal.hazardCategory]}
                      title={HAZARD_CATEGORY_LABELS[signal.hazardCategory]}
                      style={{ marginRight: 6 }}
                    >
                      {HAZARD_CATEGORY_ICONS[signal.hazardCategory]}
                    </span>
                    {signal.roadway ?? 'Unknown road'}
                    {signal.direction ? ` (${signal.direction})` : ''}
                  </div>
                  {hasCoordinates && (
                    <p className="card-meta" style={{ margin: '0 0 var(--space-2)' }}>
                      {addresses[signal.id] ?? (addressesLoading ? 'Looking up address…' : null)}
                    </p>
                  )}
                  <p className="card-body">{signal.speech.brief}</p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
