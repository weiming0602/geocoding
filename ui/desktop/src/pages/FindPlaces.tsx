import { useCallback, useRef, useState } from 'react';

import { searchPlaces } from '../../../shared/api/client';
import type { PlaceResult } from '../../../shared/api/types';
import FindPlacesMapView from '../components/FindPlacesMapView';
import PageHeader from '../components/PageHeader';

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
  // Highlighting only, set from either direction (a row click or a
  // marker click) -- see BatchMapView's selectedIndex comment.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // Row-click direction only -- pans/zooms the map. nonce forces a
  // re-fire even when the same row is clicked twice in a row.
  const [focusRequest, setFocusRequest] = useState<{ index: number; nonce: number } | null>(null);
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const mapWrapperRef = useRef<HTMLDivElement>(null);

  // "barber shop near Brunswick, Maine" resolves its own center
  // server-side (via Nominatim) -- only queries without a "near" clause
  // need a map click first.
  const hasNearClause = /\bnear\b/i.test(query);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setError('Enter what you’re looking for first.');
      return;
    }
    if (!hasNearClause && !center) {
      setError('Click a point on the map to search near, or add "near <place>" to your search.');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    setSelectedIndex(null);
    setFocusRequest(null);
    try {
      const response = await searchPlaces({
        query: query.trim(),
        latitude: center?.latitude,
        longitude: center?.longitude,
        radiusMeters,
      });
      setResults(response.results);
      setSkipped(response.skipped);
      setTruncated(response.truncated);
      // Reflects where a "near <place>" query actually landed -- moves
      // the map/marker to match without the user having to click or pan.
      if (response.center) setCenter(response.center);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, [query, hasNearClause, center, radiusMeters]);

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

  // Defensive: a place without a usable coordinate has no marker to plot
  // -- filtered out here (after indexing, so resultIndex still lines up
  // with the results array) rather than ever handing maplibre a NaN
  // LngLat, which throws and blanks the whole page (no error boundary).
  const places = (results ?? [])
    .map((r, resultIndex) => ({
      name: r.name,
      address: r.address,
      latitude: r.latitude,
      longitude: r.longitude,
      resultIndex,
    }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

  const handleSelectRow = useCallback((index: number) => {
    setSelectedIndex(index);
    setFocusRequest({ index, nonce: Date.now() });
    mapWrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const handlePlaceClick = useCallback((index: number) => {
    setSelectedIndex(index);
    rowRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <div>
      <PageHeader icon="findPlaces">Find places</PageHeader>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Search for a kind of place (via OpenStreetMap) near a point you click on the map -- or
        just type where, e.g. "barber shop near Brunswick, Maine" -- then download the results as
        an address list ready for <a href="#/batch">Batch geocode</a>.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        This search itself doesn't use Meridian's own geocoding — it's powered by public
        OpenStreetMap data, matched against whatever you type (e.g. "pizza", "hardware store",
        "asian restaurant"). Adding "near &lt;place&gt;" looks that place up via OSM's own
        place-name search (Nominatim, also free/public) instead of requiring a map click. What you
        get back is a plain address list, which you can then run through Batch geocode for
        precise, Meridian-computed coordinates.
      </div>

      <div className="form-map-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="field">
            <label>What are you looking for?</label>
            <input
              className="input"
              placeholder='e.g. "pizza" or "barber shop near Brunswick, ME"'
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
              : hasNearClause
                ? 'Will look up that location when you hit Search.'
                : 'Click a point on the map, or add "near <place>" to your search.'}
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
          <div ref={mapWrapperRef}>
            <FindPlacesMapView
              center={center}
              onCenterClick={setCenter}
              places={places}
              selectedIndex={selectedIndex}
              focusRequest={focusRequest}
              onPlaceClick={handlePlaceClick}
            />
          </div>

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
                    <tr
                      key={index}
                      ref={(el) => {
                        rowRefs.current[index] = el;
                      }}
                      onClick={() => handleSelectRow(index)}
                      style={{
                        cursor: 'pointer',
                        borderLeft:
                          selectedIndex === index ? '3px solid var(--color-accent)' : '3px solid transparent',
                        background: selectedIndex === index ? 'var(--color-surface)' : undefined,
                      }}
                    >
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
