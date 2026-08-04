import { useCallback, useRef, useState } from 'react';

import { batchGeocode, batchGeocodeDownload } from '../../../shared/api/client';
import type { BatchResult, BatchSource } from '../../../shared/api/types';
import BatchMapView from '../components/BatchMapView';

// A few thousand DOM-backed MapLibre markers noticeably bogs the browser
// down; skip the map above this and point at the download instead.
const MAX_MARKERS_FOR_MAP = 300;

export default function Batch() {
  const [email, setEmail] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [filePath, setFilePath] = useState('');
  const [pickedFile, setPickedFile] = useState<{ name: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [quota, setQuota] = useState<{ remaining: number; tier: number } | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasSource = Boolean(pickedFile) || filePath.trim().length > 0;
  const buildSource = useCallback((): BatchSource => {
    const base = pickedFile ? { fileContent: pickedFile.content } : { filePath: filePath.trim() };
    return { ...base, email: email.trim(), serviceKey: serviceKey.trim() };
  }, [pickedFile, filePath, email, serviceKey]);

  const handleChooseFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const content = await file.text();
    setPickedFile({ name: file.name, content });
    setResults(null);
  }, []);

  const handleBatchGeocode = useCallback(async () => {
    if (!email.trim()) {
      setError('Enter your account email first.');
      return;
    }
    if (!serviceKey.trim()) {
      setError('Enter your service key first.');
      return;
    }
    if (!hasSource) {
      setError('Enter a file path or choose a file first.');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    setQuota(null);
    try {
      const response = await batchGeocode(buildSource());
      setResults(response.results);
      setQuota({ remaining: response.remaining, tier: response.tier });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch geocoding failed.');
    } finally {
      setLoading(false);
    }
  }, [email, serviceKey, hasSource, buildSource]);

  const handleDownload = useCallback(async () => {
    if (!email.trim()) {
      setError('Enter your account email first.');
      return;
    }
    if (!serviceKey.trim()) {
      setError('Enter your service key first.');
      return;
    }
    if (!hasSource) {
      setError('Enter a file path or choose a file first.');
      return;
    }
    setDownloading(true);
    setError(null);
    try {
      const { blob, quota: quotaHeader } = await batchGeocodeDownload(buildSource());
      if (quotaHeader) setQuota(quotaHeader);
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
  }, [email, serviceKey, hasSource, buildSource]);

  const successCount = results ? results.filter((r) => r.success).length : 0;
  const successMarkers = (results ?? [])
    .filter((r): r is Extract<BatchResult, { success: true }> => r.success)
    .map((r) => ({ address: r.address, latitude: r.coordinates.latitude, longitude: r.coordinates.longitude }));

  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Batch geocoding</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Matches /geocode/batch — one address per line, checked against your account's monthly quota.
        Upload a file, or (if this app and geocoding-server share a filesystem) point at a
        server-side path.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 'var(--space-6)', alignItems: 'start' }}>
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
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input
                className="input"
                placeholder="C:\software\database\addresses.txt"
                value={pickedFile ? pickedFile.name : filePath}
                onChange={(e) => setFilePath(e.target.value)}
                disabled={Boolean(pickedFile)}
              />
              <button
                className="btn btn-secondary"
                onClick={() => (pickedFile ? setPickedFile(null) : fileInputRef.current?.click())}
              >
                {pickedFile ? 'Clear' : 'Choose File'}
              </button>
              <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleChooseFile} />
            </div>
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
              <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
                {successCount} of {results.length} succeeded
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result, index) => (
                      <tr key={index}>
                        <td>{result.address}</td>
                        <td>
                          {result.success ? (
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {result.coordinates.latitude.toFixed(6)}, {result.coordinates.longitude.toFixed(6)} ·{' '}
                              <span className="tag tag-accent">{result.rangeSide} side</span>
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
              {successMarkers.length > 0 && successMarkers.length < MAX_MARKERS_FOR_MAP && (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <BatchMapView markers={successMarkers} />
                </div>
              )}
              {successMarkers.length >= MAX_MARKERS_FOR_MAP && (
                <p className="text-muted" style={{ marginTop: 'var(--space-4)' }}>
                  Map skipped: {successMarkers.length} successful results is too many to render smoothly.
                  Use Download results to get the coordinates instead.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
