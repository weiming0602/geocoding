import { useCallback, useState } from 'react';

import { geocode } from '../../../shared/api/client';
import MapView from '../components/MapView';
import { useRecentLookups } from '../state/RecentLookups';
import type { RecentLookup } from '../state/RecentLookups';

export default function Geocode() {
  const { recentLookups, addLookup } = useRecentLookups();
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecentLookup | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy coordinates');

  const runGeocode = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setError('Enter an address first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await geocode(trimmed);
      const lookup: RecentLookup = {
        address: trimmed,
        latitude: response.coordinates.latitude,
        longitude: response.coordinates.longitude,
        rangeSide: response.rangeSide,
      };
      setResult(lookup);
      addLookup(lookup);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Geocoding failed.');
    } finally {
      setLoading(false);
    }
  }, [addLookup]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    navigator.clipboard?.writeText(`${result.latitude}, ${result.longitude}`).then(() => {
      setCopyLabel('Copied');
      setTimeout(() => setCopyLabel('Copy coordinates'), 1400);
    });
  }, [result]);

  return (
    <div>
      <h1>Geocode</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Convert a street address to coordinates — matches /geocode.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-6)', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="field">
            <label>Address or place</label>
            <input
              className="input"
              placeholder="1600 Amphitheatre Pkwy, Mountain View"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runGeocode(address);
              }}
            />
          </div>
          <button className="btn btn-primary btn-block" onClick={() => runGeocode(address)} disabled={loading}>
            {loading ? 'Geocoding…' : 'Geocode'}
          </button>
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
                Nothing yet — geocode an address to see it here.
              </p>
            )}
            {recentLookups.map((lookup, index) => (
              <button
                key={index}
                className="card"
                style={{ textAlign: 'left', cursor: 'pointer', background: 'transparent', padding: 'var(--space-2) var(--space-3)' }}
                onClick={() => {
                  setAddress(lookup.address);
                  setResult(lookup);
                }}
              >
                <div style={{ fontSize: 13 }}>{lookup.address}</div>
                <div className="text-muted" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                  {lookup.latitude.toFixed(5)}, {lookup.longitude.toFixed(5)}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <MapView
            latitude={result?.latitude}
            longitude={result?.longitude}
            label={result ? `${result.address} (${result.rangeSide} side)` : undefined}
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
                  {result.latitude.toFixed(6)}, {result.longitude.toFixed(6)} ·{' '}
                  <span className="tag tag-accent">{result.rangeSide} side</span>
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
