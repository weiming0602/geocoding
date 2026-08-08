import { useCallback, useState } from 'react';

import { reverseGeocode } from '../../../shared/api/client';
import MapView from '../components/MapView';
import { useRecentLookups } from '../state/RecentLookups';
import type { RecentLookup } from '../state/RecentLookups';

type ReverseResult = RecentLookup & { distanceMeters: number };

export default function ReverseGeocode() {
  const { recentLookups, addLookup } = useRecentLookups();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReverseResult | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy coordinates');

  const handleMapClick = useCallback(
    async ({ latitude, longitude }: { latitude: number; longitude: number }) => {
      setLoading(true);
      setError(null);
      try {
        const response = await reverseGeocode({ latitude, longitude });
        const lookup: ReverseResult = {
          address: response.address,
          latitude: response.matchedCoordinates.latitude,
          longitude: response.matchedCoordinates.longitude,
          rangeSide: response.side,
          distanceMeters: response.distanceMeters,
        };
        setResult(lookup);
        addLookup(lookup);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Reverse geocoding failed.');
      } finally {
        setLoading(false);
      }
    },
    [addLookup]
  );

  const handleCopy = useCallback(() => {
    if (!result) return;
    navigator.clipboard?.writeText(`${result.latitude}, ${result.longitude}`).then(() => {
      setCopyLabel('Copied');
      setTimeout(() => setCopyLabel('Copy coordinates'), 1400);
    });
  }, [result]);

  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Reverse geocode</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Click a point on the map to get its nearest address — matches /reverse-geocode.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        Lost in an unfamiliar city? This is exactly what reverse geocoding is for. A visitor
        standing on an unfamiliar street doesn't know the address — but their phone knows its own
        coordinates. Send us that location and we'll tell you exactly where you're standing, down
        to the nearest street and side.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-6)', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="card" style={{ background: 'var(--color-surface)' }}>
            <p className="card-body" style={{ margin: 0 }}>
              {loading ? 'Resolving…' : 'Click anywhere on the map to reverse-geocode that point.'}
            </p>
          </div>
          {error && (
            <p className="card-body" style={{ color: '#a4402a', margin: 0 }}>
              {error}
            </p>
          )}

          <div className="hr" />
          <h5 className="text-muted" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Recent lookups
          </h5>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {recentLookups.length === 0 && (
              <p className="card-body" style={{ margin: 0 }}>
                Nothing yet — click the map to see a result here.
              </p>
            )}
            {recentLookups.map((lookup, index) => (
              <div key={index} className="card" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                <div style={{ fontSize: 13 }}>{lookup.address}</div>
                <div className="text-muted" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                  {lookup.latitude.toFixed(5)}, {lookup.longitude.toFixed(5)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <MapView
            latitude={result?.latitude}
            longitude={result?.longitude}
            label={result ? `${result.address} (${result.rangeSide} side)` : undefined}
            onMapClick={handleMapClick}
          />

          {result && (
            <div
              className="card elev-sm"
              style={{ marginTop: 'var(--space-4)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div>
                <div className="card-kicker">Result</div>
                <div className="card-title">{result.address}</div>
                <div className="card-meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {result.latitude.toFixed(6)}, {result.longitude.toFixed(6)} · {result.distanceMeters.toFixed(1)} m to
                  street · <span className="tag tag-accent">{result.rangeSide} side</span>
                </div>
              </div>
              <button className="btn btn-ghost" onClick={handleCopy}>
                {copyLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
