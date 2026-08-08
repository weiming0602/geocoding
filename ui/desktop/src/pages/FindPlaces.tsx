import { useCallback, useState } from 'react';

import { searchPlaces } from '../../../shared/api/client';
import type { PlaceResult } from '../../../shared/api/types';
import MapView from '../components/MapView';

const RADIUS_OPTIONS = [
  { label: '1 km', meters: 1000 },
  { label: '5 km', meters: 5000 },
  { label: '10 km', meters: 10000 },
  { label: '25 km', meters: 25000 },
];

export default function FindPlaces() {
  const [query, setQuery] = useState('');
  const [center, setCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [radiusMeters, setRadiusMeters] = useState(RADIUS_OPTIONS[1].meters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setError('Enter what you’re looking for first.');
      return;
    }
    if (!center) {
      setError('Click a point on the map to search near.');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const response = await searchPlaces({
        query: query.trim(),
        latitude: center.latitude,
        longitude: center.longitude,
        radiusMeters,
      });
      setResults(response.results);
      setSkipped(response.skipped);
      setTruncated(response.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, [query, center, radiusMeters]);

  const handleDownload = useCallback(() => {
    if (!results || results.length === 0) return;
    const content = results.map((r) => r.address).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'places-addresses.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  }, [results]);

  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Find places</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Search for a kind of place (via OpenStreetMap) near a point you click on the map, then
        download the results as an address list ready for{' '}
        <a href="#/batch">Batch geocode</a>.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        This search itself doesn't use Meridian's own geocoding — it's powered by public
        OpenStreetMap data, matched against whatever you type (e.g. "pizza", "hardware store",
        "asian restaurant"). What you get back is a plain address list, which you can then run
        through Batch geocode for precise, Meridian-computed coordinates.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 'var(--space-6)', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="field">
            <label>What are you looking for?</label>
            <input
              className="input"
              placeholder="e.g. pizza, hardware store"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Search radius</label>
            <select
              className="input"
              value={radiusMeters}
              onChange={(e) => setRadiusMeters(Number(e.target.value))}
            >
              {RADIUS_OPTIONS.map((opt) => (
                <option key={opt.meters} value={opt.meters}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
            {center
              ? `Searching near ${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`
              : 'Click a point on the map to set where to search near.'}
          </p>

          <button className="btn btn-primary btn-block" onClick={handleSearch} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>

          {error && (
            <p className="card-body" style={{ color: '#a4402a', margin: 0 }}>
              {error}
            </p>
          )}

          {results && (
            <>
              <div className="card-title">
                {results.length} result{results.length === 1 ? '' : 's'} with a usable address
              </div>
              {skipped > 0 && (
                <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                  {skipped} more matched but didn't have enough of a street address to geocode.
                </p>
              )}
              {truncated && (
                <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                  Capped at {results.length} results — try a smaller radius for a more complete list.
                </p>
              )}
              <button
                className="btn btn-secondary btn-block"
                onClick={handleDownload}
                disabled={results.length === 0}
              >
                Download address list (.txt)
              </button>
            </>
          )}
        </div>

        <div>
          <MapView
            latitude={center?.latitude}
            longitude={center?.longitude}
            label={center ? 'Search center' : undefined}
            onMapClick={setCenter}
          />

          {results && results.length > 0 && (
            <div style={{ marginTop: 'var(--space-4)', overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Address</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result, index) => (
                    <tr key={index}>
                      <td>{result.name}</td>
                      <td className="text-muted">{result.address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
