import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { batchGeocode, batchGeocodeDownload } from '../../../shared/api/client';
import type { BatchResult, BatchSource } from '../../../shared/api/types';
import { guessRole } from '../../../shared/importAddresses';
import BatchMapView from '../components/BatchMapView';
import PageHeader from '../components/PageHeader';
import { useMapMarkerCap } from '../useMapMarkerCap';

type ForwardedFile = { fileContent: string; fileName?: string; ids?: string[] };

// Minimal RFC 4180 quoting -- wraps a field in quotes (doubling any
// quotes inside it) whenever it contains a comma, quote, or newline;
// left alone otherwise. Good enough for values coming out of a CSV/
// Excel import in the first place.
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Splits a line into exactly two fields at its first comma -- the
// second field is left as one opaque string even when it itself
// contains more commas, which a real address always does ("123 Main
// St, Standish, ME 04091"). Deliberately not full CSV-quote parsing:
// no quoting to type by hand, since the id column is never going to
// contain a comma itself.
function splitAtFirstComma(line: string): [string, string] {
  const index = line.indexOf(',');
  if (index === -1) return [line, ''];
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

// A directly-picked file is normally just one address per line (what
// the server's own parseAddresses expects) -- but since a plain address
// already contains commas itself, there's no safe way to *infer* an
// id,address file from commas alone. Instead this looks at the header
// row's first field using the same guessRole heuristic Import Addresses
// already uses ("id", "record id", "customer_id", "uuid", "ref#", etc.,
// case-insensitive) -- an unambiguous, deliberate opt-in a plain
// address list will never collide with. Requires id first, address
// second (rest of the line) -- only handles this simple shape; a file
// with street/city/state/zip split across separate columns still needs
// Import Addresses' full mapping step. Anything that doesn't match is
// treated as a plain address list, unchanged from before.
function parsePickedFile(raw: string): { content: string; ids: string[] | null } {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { content: raw, ids: null };

  const [headerId, headerAddress] = splitAtFirstComma(lines[0]);
  if (guessRole(headerId) !== 'id' || guessRole(headerAddress) === 'id') {
    return { content: raw, ids: null };
  }

  const ids: string[] = [];
  const addresses: string[] = [];
  for (const line of lines.slice(1)) {
    const [id, address] = splitAtFirstComma(line);
    ids.push(id);
    addresses.push(address);
  }
  return { content: addresses.join('\n'), ids };
}

export default function Batch() {
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [filePath, setFilePath] = useState('');
  // Populated on mount when arriving via Import Addresses' "Send to
  // Batch geocode" button (navigate('/batch', { state: {...} })) --
  // the lazy initializer only runs once, so it won't re-trigger on a
  // later re-render or a plain back-navigation without that state.
  const [pickedFile, setPickedFile] = useState<{ name: string; content: string } | null>(() => {
    const state = location.state as ForwardedFile | null;
    if (!state?.fileContent) return null;
    return { name: state.fileName ?? 'imported-addresses.txt', content: state.fileContent };
  });
  // Captured once on the same mount as pickedFile's initializer, and
  // deliberately independent of it afterward -- clearing the picked file
  // (e.g. to try a different source) shouldn't also hide the way back to
  // Import Addresses, since the whole point is letting someone go back
  // and adjust their filtered selection before committing to a run.
  const [arrivedFromImport] = useState(() => Boolean((location.state as ForwardedFile | null)?.fileContent));
  // The ID column mapped in Import Addresses (if any), one per selected
  // row, in the same order as the address lines sent in fileContent --
  // initialized once from that navigation state alongside pickedFile/
  // arrivedFromImport, but (unlike those) reassigned whenever the user
  // picks a new file directly (see handleChooseFile) -- both to support
  // an id,address file picked without going through Import Addresses,
  // and so a stale id list from an earlier file can't wrongly appear to
  // "match" a completely different one now loaded.
  const [forwardedIds, setForwardedIds] = useState<string[] | null>(
    () => (location.state as ForwardedFile | null)?.ids ?? null
  );
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [quota, setQuota] = useState<{ remaining: number; tier: number } | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Highlighting only, set from either direction (a row click or a
  // marker click) -- see BatchMapView's own selectedIndex comment.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // Row-click direction only -- pans/zooms the map. nonce forces a
  // re-fire even when the same row is clicked twice in a row.
  const [focusRequest, setFocusRequest] = useState<{ index: number; nonce: number } | null>(null);
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const mapWrapperRef = useRef<HTMLDivElement>(null);

  const hasSource = Boolean(pickedFile) || filePath.trim().length > 0;
  const buildSource = useCallback((): BatchSource => {
    const base = pickedFile ? { fileContent: pickedFile.content } : { filePath: filePath.trim() };
    return { ...base, email: email.trim(), serviceKey: serviceKey.trim() };
  }, [pickedFile, filePath, email, serviceKey]);

  const handleChooseFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const raw = await file.text();
    const { content, ids } = parsePickedFile(raw);
    setPickedFile({ name: file.name, content });
    setForwardedIds(ids);
    setResults(null);
  }, []);

  const handleBatchGeocode = useCallback(async () => {
    // No client-side check that email/serviceKey are non-empty -- the
    // server decides whether an empty one is acceptable (see
    // ALLOW_TEST_EMPTY_SERVICE_KEY in CLAUDE.md) and returns a clear
    // error either way.
    if (!hasSource) {
      setError('Enter a file path or choose a file first.');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    setQuota(null);
    setSelectedIndex(null);
    setFocusRequest(null);
    try {
      const response = await batchGeocode(buildSource());
      setResults(response.results);
      // Omitted entirely (not just zero) when the request ran in test
      // mode with no email -- no account/quota was involved.
      if (typeof response.tier === 'number' && typeof response.remaining === 'number') {
        setQuota({ remaining: response.remaining, tier: response.tier });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch geocoding failed.');
    } finally {
      setLoading(false);
    }
  }, [hasSource, buildSource]);

  const handleDownload = useCallback(async () => {
    if (!hasSource) {
      setError('Enter a file path or choose a file first.');
      return;
    }
    setDownloading(true);
    setError(null);
    setQuota(null);
    try {
      const { blob, quota: quotaHeader } = await batchGeocodeDownload(buildSource());
      setQuota(quotaHeader);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'batch-geocode-results.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloading(false);
    }
  }, [hasSource, buildSource]);

  const successCount = results ? results.filter((r) => r.success).length : 0;
  const successMarkers = useMemo(
    () =>
      (results ?? [])
        .map((r, resultIndex) => ({ r, resultIndex }))
        .filter((x): x is { r: Extract<BatchResult, { success: true }>; resultIndex: number } => x.r.success)
        .map(({ r, resultIndex }) => ({
          address: r.address,
          latitude: r.coordinates.latitude,
          longitude: r.coordinates.longitude,
          resultIndex,
        })),
    [results]
  );

  // Connection-adaptive render cap -- purely a map-rendering performance
  // guard, evaluated live from the browser's Network Information API (see
  // useMapMarkerCap.ts). Never affects the results table or CSV/ZIP
  // export, which stay complete and uncapped.
  const mapMarkerCap = useMapMarkerCap();
  const mapMarkers = useMemo(() => {
    if (successMarkers.length <= mapMarkerCap) return successMarkers;
    const capped = successMarkers.slice(0, mapMarkerCap);
    // Keep the selected/focused marker visible even if it'd otherwise fall
    // outside the cap slice -- clicking a table row shouldn't silently show
    // nothing on the map.
    if (selectedIndex !== null && !capped.some((m) => m.resultIndex === selectedIndex)) {
      const selectedMarker = successMarkers.find((m) => m.resultIndex === selectedIndex);
      if (selectedMarker) {
        capped[capped.length - 1] = selectedMarker;
      }
    }
    return capped;
  }, [successMarkers, mapMarkerCap, selectedIndex]);
  const mapMarkersCapped = mapMarkers.length < successMarkers.length;

  const handleSelectRow = useCallback((index: number) => {
    setSelectedIndex(index);
    setFocusRequest({ index, nonce: Date.now() });
    mapWrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const handleMarkerClick = useCallback((index: number) => {
    setSelectedIndex(index);
    rowRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // Only trust forwardedIds if it lines up 1:1 with results -- a
  // mismatch shouldn't ever happen (results come back in the same order
  // addresses were sent), but silently zipping mismatched arrays would
  // attach the wrong ID to a row, which is worse than just not showing
  // one at all.
  const idsMatchResults = forwardedIds !== null && results !== null && forwardedIds.length === results.length;

  const handleDownloadCsv = useCallback(() => {
    if (!results || !idsMatchResults || !forwardedIds) return;
    const header = ['#', 'ID', 'Address', 'Success', 'Latitude', 'Longitude', 'Side', 'Error'];
    const lines = [header.join(',')];
    results.forEach((result, i) => {
      const row = result.success
        ? [
            String(i + 1),
            forwardedIds[i],
            result.address,
            'true',
            String(result.coordinates.latitude),
            String(result.coordinates.longitude),
            result.source === 'interpolation' ? result.rangeSide : '',
            '',
          ]
        : [String(i + 1), forwardedIds[i], result.address, 'false', '', '', '', result.error];
      lines.push(row.map(csvField).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'batch-geocode-results.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  }, [results, idsMatchResults, forwardedIds]);

  return (
    <div>
      <PageHeader icon="batch">Batch geocoding</PageHeader>
      <p className="text-muted" style={{ marginBottom: arrivedFromImport ? 'var(--space-3)' : 'var(--space-6)' }}>
        Matches /geocode/batch — one address per line, checked against your account's monthly quota.
        Upload a file, or (if this app and geocoding-server share a filesystem) point at a
        server-side path.
      </p>

      {arrivedFromImport && (
        <p style={{ marginBottom: 'var(--space-6)' }}>
          <Link to="/import-addresses" className="btn btn-secondary">
            ← Back to Import Addresses
          </Link>
        </p>
      )}

      <div className="form-map-layout">
        <div className="card elev-sm">
          <div className="field">
            <label>Account email</label>
            <input
              className="input"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Service key</label>
            <input
              className="input"
              placeholder="mk_..."
              value={serviceKey}
              onChange={(e) => setServiceKey(e.target.value)}
            />
            <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
              Sent to you when you purchased your plan. Both the email and this key are required to
              run batch geocoding.
            </p>
          </div>

          <div className="field">
            <label>Resource file (one address per line)</label>
            <button
              className="btn btn-primary btn-block"
              onClick={() => (pickedFile ? setPickedFile(null) : fileInputRef.current?.click())}
            >
              {pickedFile ? `Clear "${pickedFile.name}"` : 'Choose File'}
            </button>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleChooseFile} />

            {/* De-emphasized on purpose -- this only works when the app and
                geocoding-server share a filesystem (a same-host dev/test
                setup), which is never true for a real hosted customer, so it
                shouldn't compete visually with Choose File above. */}
            <p className="text-muted" style={{ fontSize: 11, margin: 'var(--space-3) 0 4px' }}>
              Advanced: if this app and geocoding-server share a filesystem, point at a
              server-side path instead --
            </p>
            <input
              className="input"
              style={{ fontSize: 12 }}
              placeholder="C:\software\database\addresses.txt"
              value={pickedFile ? pickedFile.name : filePath}
              onChange={(e) => setFilePath(e.target.value)}
              disabled={Boolean(pickedFile)}
            />

            <a
              href="/batch-address-template.txt"
              download
              className="text-muted"
              style={{ fontSize: 12, display: 'inline-block', marginTop: 'var(--space-2)' }}
            >
              Download a template file
            </a>
          </div>

          <div
            className="card-body"
            style={{
              background: 'var(--color-surface)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
              fontFamily: 'monospace',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            91 Chestnut St, Portland, ME 04101{'\n'}13 Deerfield Dr, Brunswick, ME 04011{'\n'}997
            Pequawket Trl, Standish, ME 04091
          </div>
          <button className="btn btn-primary btn-block" onClick={handleBatchGeocode} disabled={loading || downloading}>
            {loading ? 'Geocoding…' : 'Batch geocode'}
          </button>
          <button className="btn btn-secondary btn-block" onClick={handleDownload} disabled={loading || downloading}>
            {downloading ? 'Preparing…' : 'Download results (ZIP)'}
          </button>
          {quota && (
            <p className="card-body" style={{ marginTop: 'var(--space-2)' }}>
              {typeof quota === 'string'
                ? `Used ${quota} this period`
                : `${quota.remaining.toLocaleString()} of ${quota.tier.toLocaleString()} remaining this period`}
            </p>
          )}
          {error && (
            <p className="card-body" style={{ color: '#a4402a', marginTop: 'var(--space-2)' }}>
              {error}
            </p>
          )}
        </div>

        <div>
          {results && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
                <div className="card-title" style={{ marginBottom: 0 }}>
                  {successCount} of {results.length} succeeded
                </div>
                {idsMatchResults && (
                  <button className="btn btn-secondary" onClick={handleDownloadCsv}>
                    Download results as CSV (with ID)
                  </button>
                )}
              </div>
              {forwardedIds && !idsMatchResults && (
                <p className="card-body" style={{ color: '#a4402a', marginBottom: 'var(--space-3)' }}>
                  The imported ID column couldn't be matched to these results one-to-one, so it's
                  been left out of this run's output.
                </p>
              )}
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {idsMatchResults && <th>ID</th>}
                      <th>Address</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result, index) => (
                      <tr
                        key={index}
                        ref={(el) => {
                          rowRefs.current[index] = el;
                        }}
                        onClick={() => result.success && handleSelectRow(index)}
                        style={{
                          cursor: result.success ? 'pointer' : undefined,
                          borderLeft:
                            selectedIndex === index ? '3px solid var(--color-accent)' : '3px solid transparent',
                          background: selectedIndex === index ? 'var(--color-surface)' : undefined,
                        }}
                      >
                        <td className="text-muted">{index + 1}</td>
                        {idsMatchResults && forwardedIds && <td className="text-muted">{forwardedIds[index]}</td>}
                        <td>{result.address}</td>
                        <td>
                          {result.success ? (
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {result.coordinates.latitude.toFixed(6)}, {result.coordinates.longitude.toFixed(6)}
                              {result.source === 'interpolation' && (
                                <>
                                  {' · '}
                                  <span className="tag tag-accent">{result.rangeSide} side</span>
                                </>
                              )}
                            </span>
                          ) : (
                            <span style={{ color: '#a4402a' }}>{result.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {successMarkers.length > 0 && (
                <div ref={mapWrapperRef} style={{ marginTop: 'var(--space-4)' }}>
                  {mapMarkersCapped && (
                    <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-2)' }}>
                      Showing {mapMarkerCap.toLocaleString()} of {successMarkers.length.toLocaleString()} results on
                      the map (based on your connection) — full results are in the table above and any CSV/ZIP
                      export.
                    </p>
                  )}
                  <BatchMapView
                    markers={mapMarkers}
                    selectedIndex={selectedIndex}
                    focusRequest={focusRequest}
                    onMarkerClick={handleMarkerClick}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
