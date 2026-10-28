import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  addTestRoadSignal,
  addTestWeightedPoint,
  clearTestRoadSignals,
  clearTestWeightedPoints,
  deleteTestRoadSignal,
  deleteTestWeightedPoint,
  geocode,
  getTestDriveRoute,
  getTestRoadSignals,
  getTestWeightedPoints,
  getWeightedPoints,
} from '../../../shared/api/client';
import type { Coordinates, RoadSignal, RoadSignalSeverity, TestWeightedPoint } from '../../../shared/api/types';
import { METERS_PER_SECOND_PER_MPH } from '../../../shared/driveSimulation';
import { parseCoordinateInput } from '../../../shared/parseCoordinateInput';
import { findAlertsForWeightedPoints, type WeightedPoint } from '../../../shared/roadAlertsMatching';
import RoadAlertsSandboxMap, { type SandboxPoint } from '../components/RoadAlertsSandboxMap';
import RoadAlertsRegistration from '../components/RoadAlertsRegistration';
import PageHeader from '../components/PageHeader';
import RoadAlertsTabs from '../components/RoadAlertsTabs';
import { getStoredAccount, type StoredRoadAlertsAccount } from '../roadAlertsStorage';
import type { SimulatedDriveState } from './RoadAlerts';

type Mode = 'point' | 'hazard' | 'driver' | 'driveStart' | 'driveTarget';

const SEVERITY_OPTIONS: { value: RoadSignalSeverity; label: string }[] = [
  { value: 'serious', label: 'Serious' },
  { value: 'need_to_know', label: 'Need to know' },
  { value: 'proximity', label: 'Proximity' },
  { value: 'fun_to_know', label: 'Fun to know' },
];

// A weight comfortably above roadAlertsMatching.ts's DEFAULT_MATCH_OPTIONS
// minWeight (0) -- a hand-placed test point should always be usable
// immediately, unlike a real one, which has to actually earn its
// qualifying window (see weightedPoints.js). Editable per point below.
const DEFAULT_TEST_POINT_WEIGHT = '5';

const FAST_FORWARD_OPTIONS = [1, 2, 5, 10];

type DriveRoute = {
  usesWeightedPoints: boolean;
  coordinates: [number, number][];
  distanceMeters: number;
  start: Coordinates;
  end: Coordinates;
};

function formatCoordinates({ latitude, longitude }: Coordinates): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/** "lat, lng" as typed, or else an address geocoded through Meridian's own /geocode. */
async function resolvePlace(text: string, what: string): Promise<Coordinates> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`Enter a ${what} address or "lat, lng".`);
  const coordinates = parseCoordinateInput(trimmed);
  if (coordinates) return coordinates;
  try {
    return (await geocode(trimmed)).coordinates;
  } catch (err) {
    throw new Error(`Couldn't find the ${what} "${trimmed}": ${err instanceof Error ? err.message : 'geocode failed'}`);
  }
}

export default function RoadAlertsSandbox() {
  const navigate = useNavigate();
  const [account, setAccount] = useState<StoredRoadAlertsAccount | null>(() => getStoredAccount());
  const [mode, setMode] = useState<Mode>('point');
  const [realPoints, setRealPoints] = useState<WeightedPoint[]>([]);
  const [testPoints, setTestPoints] = useState<TestWeightedPoint[]>([]);
  const [testSignals, setTestSignals] = useState<RoadSignal[]>([]);
  const [driverPosition, setDriverPosition] = useState<Coordinates | null>(null);
  const [pendingHazardClick, setPendingHazardClick] = useState<Coordinates | null>(null);
  const [hazardRoadway, setHazardRoadway] = useState('');
  const [hazardDescription, setHazardDescription] = useState('');
  const [hazardSeverity, setHazardSeverity] = useState<RoadSignalSeverity>('need_to_know');
  const [newPointWeight, setNewPointWeight] = useState(DEFAULT_TEST_POINT_WEIGHT);
  const [focusPoint, setFocusPoint] = useState<Coordinates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [driveStart, setDriveStart] = useState('');
  const [driveTarget, setDriveTarget] = useState('');
  const [speedMph, setSpeedMph] = useState('35');
  const [fastForward, setFastForward] = useState(1);
  const [driveRoute, setDriveRoute] = useState<DriveRoute | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const refresh = useCallback(async (acct: StoredRoadAlertsAccount) => {
    const { email, serviceKey } = acct;
    // Each call is independent and best-effort -- e.g. the real
    // endpoint always exists, but the two test ones 404 (and should
    // just show up empty, not break the page) whenever this server
    // doesn't have ALLOW_TEST_WEIGHTED_POINTS/ALLOW_TEST_ROAD_SIGNALS
    // set, which is exactly the case on production.
    const [real, test, signals] = await Promise.all([
      getWeightedPoints({ email, serviceKey }).catch(() => ({ weightedPoints: [] })),
      getTestWeightedPoints({ email, serviceKey }).catch(() => ({ weightedPoints: [] })),
      getTestRoadSignals({ email, serviceKey }).catch(() => ({ signals: [] })),
    ]);
    setRealPoints(real.weightedPoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude, weight: p.weight, tlid: p.tlid ?? undefined })));
    setTestPoints(test.weightedPoints);
    setTestSignals(signals.signals);
  }, []);

  useEffect(() => {
    if (account) refresh(account);
  }, [account, refresh]);

  // Wraps a create/delete call: loading flag, error message, then a
  // refresh so the map and lists reflect what the server now has.
  const mutate = useCallback(
    async (action: () => Promise<unknown>, failureMessage: string) => {
      if (!account) return;
      setLoading(true);
      setError(null);
      try {
        await action();
        await refresh(account);
      } catch (err) {
        setError(err instanceof Error ? err.message : failureMessage);
      } finally {
        setLoading(false);
      }
    },
    [account, refresh]
  );

  const handleMapClick = useCallback(
    async (coordinates: Coordinates) => {
      if (!account) return;
      setError(null);
      if (mode === 'driver') {
        setDriverPosition(coordinates);
        return;
      }
      if (mode === 'driveStart' || mode === 'driveTarget') {
        (mode === 'driveStart' ? setDriveStart : setDriveTarget)(formatCoordinates(coordinates));
        setDriveRoute(null);
        return;
      }
      if (mode === 'point') {
        const weight = Number(newPointWeight);
        if (newPointWeight.trim() === '' || Number.isNaN(weight)) {
          setError('Weight must be a number, e.g. 5.');
          return;
        }
        await mutate(
          () => addTestWeightedPoint({ ...coordinates, email: account.email, serviceKey: account.serviceKey, weight }),
          'Could not add a test weighted point.'
        );
        return;
      }
      // mode === 'hazard' -- opens the inline form below instead of
      // posting immediately, since a hazard needs a severity/description
      // a plain click can't supply.
      setPendingHazardClick(coordinates);
    },
    [account, mode, newPointWeight, mutate]
  );

  const handleCreateHazard = useCallback(async () => {
    if (!account || !pendingHazardClick) return;
    await mutate(async () => {
      await addTestRoadSignal({
        ...pendingHazardClick,
        email: account.email,
        serviceKey: account.serviceKey,
        roadway: hazardRoadway.trim() || undefined,
        description: hazardDescription.trim() || undefined,
        severity: hazardSeverity,
      });
      setPendingHazardClick(null);
      setHazardRoadway('');
      setHazardDescription('');
    }, 'Could not add a test hazard.');
  }, [account, pendingHazardClick, hazardRoadway, hazardDescription, hazardSeverity, mutate]);

  const handlePreviewRoute = useCallback(async () => {
    if (!account) return;
    setError(null);
    setRouteLoading(true);
    try {
      const start = await resolvePlace(driveStart, 'start');
      const end = await resolvePlace(driveTarget, 'target');
      const route = await getTestDriveRoute({ email: account.email, serviceKey: account.serviceKey, start, end });
      setDriveRoute({
        coordinates: route.geometry.coordinates,
        distanceMeters: route.distanceMeters,
        usesWeightedPoints: route.usesWeightedPoints === true,
        start,
        end,
      });
    } catch (err) {
      setDriveRoute(null);
      setError(err instanceof Error ? err.message : 'Could not build a route.');
    } finally {
      setRouteLoading(false);
    }
  }, [account, driveStart, driveTarget]);

  const speedMps = Number(speedMph) * METERS_PER_SECOND_PER_MPH;
  // Below Road Alerts' own MOVING_SPEED_THRESHOLD_MPS (~7.8 mph) a drive
  // would never be detected as movement, so it would never poll at all.
  const speedValid = Number.isFinite(speedMps) && Number(speedMph) >= 10 && Number(speedMph) <= 90;

  const handleStartDrive = useCallback(() => {
    if (!driveRoute || !speedValid) return;
    const simulatedDrive: SimulatedDriveState = {
      coordinates: driveRoute.coordinates,
      speedMps: speedMps * fastForward,
      label: `${driveStart.trim()} → ${driveTarget.trim()}`,
    };
    navigate('/road-alerts', { state: { simulatedDrive } });
  }, [driveRoute, speedValid, speedMps, fastForward, driveStart, driveTarget, navigate]);

  const triggeredAlerts = useMemo(() => {
    if (!driverPosition) return [];
    const testAsWeighted = testPoints.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      weight: p.weight,
      tlid: p.tlid ?? undefined,
    }));
    return findAlertsForWeightedPoints(driverPosition, [...realPoints, ...testAsWeighted], testSignals);
  }, [driverPosition, realPoints, testPoints, testSignals]);

  const mapPoints = useMemo<SandboxPoint[]>(() => {
    const real = realPoints.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      color: '#3fb1ce',
      label: `Real weighted point (weight ${p.weight.toFixed(2)})`,
    }));
    const test = testPoints.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      color: '#8b5cf6',
      label: `Test weighted point #${p.id} (weight ${p.weight.toFixed(2)})`,
    }));
    const signals = testSignals.map((s) => ({
      latitude: s.latitude ?? 0,
      longitude: s.longitude ?? 0,
      color: '#e0392b',
      label: `Test hazard ${s.id}: ${s.description ?? s.roadway ?? s.severity}`,
    }));
    // Start/target dots: from the previewed route once there is one,
    // otherwise as soon as the box holds coordinates (a map click fills it
    // with "lat, lng") -- an address only gets a dot once Preview has looked
    // it up. Not fitted to, so a click doesn't move the camera.
    const typedPlace = (text: string) => {
      const trimmed = text.trim();
      return trimmed ? parseCoordinateInput(trimmed) : null;
    };
    const startDot = driveRoute?.start ?? typedPlace(driveStart);
    const targetDot = driveRoute?.end ?? typedPlace(driveTarget);
    const endpoints = [
      ...(startDot ? [{ ...startDot, color: '#2e9e5b', label: 'Simulated drive start', skipFit: true }] : []),
      ...(targetDot ? [{ ...targetDot, color: '#222222', label: 'Simulated drive target', skipFit: true }] : []),
    ];
    // Shown the moment the map is clicked in hazard mode -- the hazard
    // itself isn't saved until "Create hazard" (it needs a severity), and
    // without this a click left no visible trace at all.
    const pending = pendingHazardClick
      ? [{ ...pendingHazardClick, color: '#f4a29a', label: 'New test hazard (not saved yet)', skipFit: true }]
      : [];
    return [...real, ...test, ...signals, ...endpoints, ...pending];
  }, [realPoints, testPoints, testSignals, driveRoute, driveStart, driveTarget, pendingHazardClick]);

  if (!account) {
    return (
      // Left-aligned like the other Road Alerts tabs (not centered): only
      // the registration card itself is kept narrow.
      <div>
        <PageHeader icon="roadAlerts">Road Alerts sandbox</PageHeader>
        <RoadAlertsTabs />
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          Sign in with a Road Alerts account to use the sandbox.
        </p>
        <div style={{ maxWidth: 480 }}>
          <RoadAlertsRegistration onRegistered={setAccount} />
        </div>
      </div>
    );
  }

  const estimatedMinutes =
    driveRoute && speedValid ? driveRoute.distanceMeters / (speedMps * fastForward) / 60 : null;

  return (
    <div>
      <PageHeader icon="roadAlerts">Road Alerts sandbox</PageHeader>
      <RoadAlertsTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Not a real driving feature -- a hidden test console for hand-placing fake weighted points/hazards and
        simulating a drive past them, to check whether alerting actually works. The test actions below only do
        anything when this server has <code>ALLOW_TEST_WEIGHTED_POINTS</code>/<code>ALLOW_TEST_ROAD_SIGNALS</code>{' '}
        set (never true on production) -- otherwise they fail quietly, same as a 404.
      </p>

      <div className="seg" style={{ marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        {(
          [
            ['point', 'Add test weighted point'],
            ['hazard', 'Add test hazard'],
            ['driver', 'Simulate driver position'],
            ['driveStart', 'Set drive start'],
            ['driveTarget', 'Set drive target'],
          ] as [Mode, string][]
        ).map(([value, label]) => (
          <label key={value} className="seg-opt">
            <input type="radio" name="sandboxMode" checked={mode === value} onChange={() => setMode(value)} />
            {label}
          </label>
        ))}
      </div>

      {mode === 'point' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', fontSize: 13 }}>
          <label htmlFor="sandboxPointWeight">Weight for new points</label>
          <input
            id="sandboxPointWeight"
            className="input"
            value={newPointWeight}
            onChange={(e) => setNewPointWeight(e.target.value)}
            style={{ maxWidth: 80 }}
          />
          <span className="text-muted">then click the map</span>
        </div>
      )}

      {error && (
        <p className="card-body" style={{ color: '#a4402a', marginBottom: 'var(--space-3)' }}>
          {error}
        </p>
      )}

      {mode === 'hazard' && !pendingHazardClick && (
        <p className="text-muted" style={{ margin: '0 0 var(--space-3)', fontSize: 13 }}>
          Click the map where the hazard is -- a form for its severity and description opens here.
        </p>
      )}

      {pendingHazardClick && (
        <div className="card elev-sm" style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)' }}>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 13 }}>
            New test hazard at {formatCoordinates(pendingHazardClick)} (light red dot) -- add details, then Create
            hazard. Click the map again to move it.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
            <input
              className="input"
              placeholder="Roadway (optional)"
              autoFocus
              value={hazardRoadway}
              onChange={(e) => setHazardRoadway(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            <input
              className="input"
              placeholder="Description (optional)"
              value={hazardDescription}
              onChange={(e) => setHazardDescription(e.target.value)}
              style={{ maxWidth: 260 }}
            />
            <select
              className="input"
              value={hazardSeverity}
              onChange={(e) => setHazardSeverity(e.target.value as RoadSignalSeverity)}
              style={{ maxWidth: 160 }}
            >
              {SEVERITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="btn btn-primary" onClick={handleCreateHazard} disabled={loading}>
              Create hazard
            </button>
            <button className="btn btn-secondary" onClick={() => setPendingHazardClick(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <RoadAlertsSandboxMap
        points={mapPoints}
        driverPosition={driverPosition}
        onMapClick={handleMapClick}
        focusPoint={focusPoint}
        routeLine={driveRoute?.coordinates ?? null}
      />

      <div className="card elev-sm" style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)' }}>
        <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
          Simulate a drive
        </div>
        <p className="card-body" style={{ margin: '0 0 var(--space-2)', fontSize: 13 }}>
          Type an address or <code>lat, lng</code> (or pick "Set drive start/target" above and click the map), preview
          the street route, drop test hazards along it, then drive it: the Road Alerts page replays the route as fake
          GPS fixes through its real alerting code -- chime, speech, list and all.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
          <input
            className="input"
            placeholder="Start, e.g. 43.65910, -70.25530"
            value={driveStart}
            onChange={(e) => {
              setDriveStart(e.target.value);
              setDriveRoute(null);
            }}
          />
          <input
            className="input"
            placeholder="Target address, e.g. 28 Federal St, Brunswick, ME 04011"
            value={driveTarget}
            onChange={(e) => {
              setDriveTarget(e.target.value);
              setDriveRoute(null);
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)', fontSize: 13 }}>
          <label htmlFor="sandboxSpeed">Speed (mph)</label>
          <input id="sandboxSpeed" className="input" value={speedMph} onChange={(e) => setSpeedMph(e.target.value)} style={{ maxWidth: 70 }} />
          <label htmlFor="sandboxFastForward">Fast-forward</label>
          <select
            id="sandboxFastForward"
            className="input"
            value={fastForward}
            onChange={(e) => setFastForward(Number(e.target.value))}
            style={{ maxWidth: 90 }}
          >
            {FAST_FORWARD_OPTIONS.map((factor) => (
              <option key={factor} value={factor}>
                {factor}×
              </option>
            ))}
          </select>
          {!speedValid && <span style={{ color: '#a4402a' }}>Speed must be 10-90 mph.</span>}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={handlePreviewRoute} disabled={routeLoading}>
            {routeLoading ? 'Finding route…' : 'Preview route'}
          </button>
          <button className="btn btn-primary" onClick={handleStartDrive} disabled={!driveRoute || !speedValid}>
            Drive it on Road Alerts
          </button>
          {driveRoute && (
            <span className="text-muted" style={{ fontSize: 13 }}>
              {(driveRoute.distanceMeters / 1000).toFixed(1)} km
              {estimatedMinutes !== null && ` -- about ${Math.max(1, Math.round(estimatedMinutes))} min at this speed`}
              {driveRoute.usesWeightedPoints && ' -- ★ via your weighted points (usual roads)'}
            </span>
          )}
        </div>
        <p className="text-muted" style={{ margin: 'var(--space-2) 0 0', fontSize: 12 }}>
          Shortest legal path over our TIGER streets, obeying one-way streets from OpenStreetMap (© OpenStreetMap
          contributors; no speed data), except that a route through your weighted points -- your usual roads, real or
          test (purple dots) -- is preferred unless it's about 3x longer. A test route, not navigation. Road Alerts
          checks for hazards about every 15 real seconds, so at high fast-forward it
          covers more road between checks.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <div className="card elev-sm" style={{ padding: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <div className="card-title" style={{ margin: 0 }}>
              Test hazards ({testSignals.length})
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => mutate(() => clearTestRoadSignals(account), 'Could not clear test hazards.')}
              disabled={loading || testSignals.length === 0}
            >
              Clear all
            </button>
          </div>
          {testSignals.length === 0 && <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>None yet.</p>}
          {testSignals.map((signal) => (
            <div key={signal.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: '4px 0', fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                <strong>{signal.description ?? signal.roadway ?? '(no description)'}</strong> -- {signal.severity}
                {signal.latitude != null && signal.longitude != null && (
                  <span className="text-muted"> @ {formatCoordinates({ latitude: signal.latitude, longitude: signal.longitude })}</span>
                )}
              </span>
              {signal.latitude != null && signal.longitude != null && (
                <button
                  className="btn btn-secondary"
                  onClick={() => setFocusPoint({ latitude: signal.latitude!, longitude: signal.longitude! })}
                >
                  Show
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={() =>
                  mutate(
                    () => deleteTestRoadSignal({ email: account.email, serviceKey: account.serviceKey, id: signal.id }),
                    'Could not delete that test hazard.'
                  )
                }
                disabled={loading}
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        <div className="card elev-sm" style={{ padding: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <div className="card-title" style={{ margin: 0 }}>
              Test weighted points ({testPoints.length})
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => mutate(() => clearTestWeightedPoints(account), 'Could not clear test weighted points.')}
              disabled={loading || testPoints.length === 0}
            >
              Clear all
            </button>
          </div>
          {testPoints.length === 0 && <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>None yet.</p>}
          {testPoints.map((point) => (
            <div key={point.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: '4px 0', fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                <strong>#{point.id}</strong> weight {point.weight}
                <span className="text-muted"> @ {formatCoordinates(point)}</span>
              </span>
              <button className="btn btn-secondary" onClick={() => setFocusPoint({ latitude: point.latitude, longitude: point.longitude })}>
                Show
              </button>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  mutate(
                    () => deleteTestWeightedPoint({ email: account.email, serviceKey: account.serviceKey, id: point.id }),
                    'Could not delete that test weighted point.'
                  )
                }
                disabled={loading}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>

      {driverPosition && (
        <div className="card elev-sm" style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <div className="card-title" style={{ margin: 0 }}>
              {triggeredAlerts.length === 0
                ? 'No alerts would trigger from this position'
                : `${triggeredAlerts.length} alert${triggeredAlerts.length === 1 ? '' : 's'} would trigger`}
            </div>
            <button className="btn btn-secondary" onClick={() => setDriverPosition(null)}>
              Clear driver position
            </button>
          </div>
          {triggeredAlerts.map((alert) => (
            <div key={alert.signal.id} className="card-body" style={{ padding: '4px 0' }}>
              <strong>{alert.signal.description ?? alert.signal.roadway ?? alert.signal.severity}</strong> -- via
              weighted point ({alert.matchedPoint.latitude.toFixed(5)}, {alert.matchedPoint.longitude.toFixed(5)}),{' '}
              {Math.round(alert.distanceAlongPathMeters)}m along the path
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-4)', fontSize: 12, flexWrap: 'wrap' }} className="text-muted">
        <span>🔵 teal = real weighted point</span>
        <span>🟣 purple = test weighted point</span>
        <span>🔴 red = test hazard</span>
        <span>🔵 large blue = simulated driver</span>
        <span>🟢 green / ⚫ black = drive start / target</span>
      </div>
    </div>
  );
}
