import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addTestRoadSignal,
  addTestWeightedPoint,
  clearTestRoadSignals,
  clearTestWeightedPoints,
  getTestRoadSignals,
  getTestWeightedPoints,
  getWeightedPoints,
} from '../../../shared/api/client';
import type { RoadSignal, RoadSignalSeverity } from '../../../shared/api/types';
import { findAlertsForWeightedPoints, type WeightedPoint } from '../../../shared/roadAlertsMatching';
import RoadAlertsSandboxMap, { type SandboxPoint } from '../components/RoadAlertsSandboxMap';
import RoadAlertsRegistration from '../components/RoadAlertsRegistration';
import PageHeader from '../components/PageHeader';
import { getStoredAccount, type StoredRoadAlertsAccount } from '../roadAlertsStorage';

type Mode = 'point' | 'hazard' | 'driver';

const SEVERITY_OPTIONS: { value: RoadSignalSeverity; label: string }[] = [
  { value: 'serious', label: 'Serious' },
  { value: 'need_to_know', label: 'Need to know' },
  { value: 'proximity', label: 'Proximity' },
  { value: 'fun_to_know', label: 'Fun to know' },
];

// A weight comfortably above roadAlertsMatching.ts's DEFAULT_MATCH_OPTIONS
// minWeight (0) -- a hand-placed test point should always be usable
// immediately, unlike a real one, which has to actually earn its
// qualifying window (see weightedPoints.js).
const TEST_POINT_WEIGHT = 5;

export default function RoadAlertsSandbox() {
  const [account, setAccount] = useState<StoredRoadAlertsAccount | null>(() => getStoredAccount());
  const [mode, setMode] = useState<Mode>('point');
  const [realPoints, setRealPoints] = useState<WeightedPoint[]>([]);
  const [testPoints, setTestPoints] = useState<WeightedPoint[]>([]);
  const [testSignals, setTestSignals] = useState<RoadSignal[]>([]);
  const [driverPosition, setDriverPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [pendingHazardClick, setPendingHazardClick] = useState<{ latitude: number; longitude: number } | null>(null);
  const [hazardRoadway, setHazardRoadway] = useState('');
  const [hazardDescription, setHazardDescription] = useState('');
  const [hazardSeverity, setHazardSeverity] = useState<RoadSignalSeverity>('need_to_know');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    setTestPoints(
      test.weightedPoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude, weight: p.weight, tlid: p.tlid ?? undefined }))
    );
    setTestSignals(signals.signals);
  }, []);

  useEffect(() => {
    if (account) refresh(account);
  }, [account, refresh]);

  const handleMapClick = useCallback(
    async (coordinates: { latitude: number; longitude: number }) => {
      if (!account) return;
      setError(null);
      if (mode === 'driver') {
        setDriverPosition(coordinates);
        return;
      }
      if (mode === 'point') {
        setLoading(true);
        try {
          await addTestWeightedPoint({ ...coordinates, email: account.email, serviceKey: account.serviceKey, weight: TEST_POINT_WEIGHT });
          await refresh(account);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not add a test weighted point.');
        } finally {
          setLoading(false);
        }
        return;
      }
      // mode === 'hazard' -- opens the inline form below instead of
      // posting immediately, since a hazard needs a severity/description
      // a plain click can't supply.
      setPendingHazardClick(coordinates);
    },
    [account, mode, refresh]
  );

  const handleCreateHazard = useCallback(async () => {
    if (!account || !pendingHazardClick) return;
    setLoading(true);
    setError(null);
    try {
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
      await refresh(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add a test hazard.');
    } finally {
      setLoading(false);
    }
  }, [account, pendingHazardClick, hazardRoadway, hazardDescription, hazardSeverity, refresh]);

  const handleClearTestPoints = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      await clearTestWeightedPoints(account);
      await refresh(account);
    } finally {
      setLoading(false);
    }
  }, [account, refresh]);

  const handleClearTestSignals = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      await clearTestRoadSignals(account);
      await refresh(account);
    } finally {
      setLoading(false);
    }
  }, [account, refresh]);

  const triggeredAlerts = useMemo(() => {
    if (!driverPosition) return [];
    return findAlertsForWeightedPoints(driverPosition, [...realPoints, ...testPoints], testSignals);
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
      label: `Test weighted point (weight ${p.weight.toFixed(2)})`,
    }));
    const signals = testSignals.map((s) => ({
      latitude: s.latitude ?? 0,
      longitude: s.longitude ?? 0,
      color: '#e0392b',
      label: `Test hazard: ${s.description ?? s.roadway ?? s.severity}`,
    }));
    return [...real, ...test, ...signals];
  }, [realPoints, testPoints, testSignals]);

  if (!account) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <PageHeader icon="roadAlerts">Road Alerts sandbox</PageHeader>
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          Sign in with a Road Alerts account to use the sandbox.
        </p>
        <RoadAlertsRegistration onRegistered={setAccount} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader icon="roadAlerts">Road Alerts sandbox</PageHeader>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Not a real driving feature -- a hidden test console for reviewing weighted points on a map and hand-placing
        fake weighted points/hazards to check whether alert matching actually works. The two "test" actions below
        only do anything when this server has <code>ALLOW_TEST_WEIGHTED_POINTS</code>/
        <code>ALLOW_TEST_ROAD_SIGNALS</code> set (never true on production) -- otherwise they fail quietly, same as
        a 404.
      </p>

      <div className="seg" style={{ marginBottom: 'var(--space-4)' }}>
        <label className="seg-opt">
          <input type="radio" name="sandboxMode" checked={mode === 'point'} onChange={() => setMode('point')} />
          Add test weighted point
        </label>
        <label className="seg-opt">
          <input type="radio" name="sandboxMode" checked={mode === 'hazard'} onChange={() => setMode('hazard')} />
          Add test hazard
        </label>
        <label className="seg-opt">
          <input type="radio" name="sandboxMode" checked={mode === 'driver'} onChange={() => setMode('driver')} />
          Simulate driver position
        </label>
      </div>

      {error && (
        <p className="card-body" style={{ color: '#a4402a', marginBottom: 'var(--space-3)' }}>
          {error}
        </p>
      )}

      <RoadAlertsSandboxMap points={mapPoints} driverPosition={driverPosition} onMapClick={handleMapClick} />

      {pendingHazardClick && (
        <div className="card elev-sm" style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)' }}>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 13 }}>
            New test hazard at {pendingHazardClick.latitude.toFixed(5)}, {pendingHazardClick.longitude.toFixed(5)}
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
            <input
              className="input"
              placeholder="Roadway (optional)"
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

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={handleClearTestPoints} disabled={loading}>
          Clear test weighted points
        </button>
        <button className="btn btn-secondary" onClick={handleClearTestSignals} disabled={loading}>
          Clear test hazards
        </button>
        {driverPosition && (
          <button className="btn btn-secondary" onClick={() => setDriverPosition(null)}>
            Clear driver position
          </button>
        )}
      </div>

      {driverPosition && (
        <div className="card elev-sm" style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)' }}>
          <div className="card-title" style={{ marginBottom: 'var(--space-2)' }}>
            {triggeredAlerts.length === 0
              ? 'No alerts would trigger from this position'
              : `${triggeredAlerts.length} alert${triggeredAlerts.length === 1 ? '' : 's'} would trigger`}
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

      <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-4)', fontSize: 12 }} className="text-muted">
        <span>🔵 teal = real weighted point</span>
        <span>🟣 purple = test weighted point</span>
        <span>🔴 red = test hazard</span>
        <span>🔵 large blue = simulated driver</span>
      </div>
    </div>
  );
}
