import { useCallback, useState } from 'react';

import { geocode } from '../../../shared/api/client';
import type { AccountCredentials } from '../../../shared/api/client';
import MapView from '../components/MapView';
import PageHeader from '../components/PageHeader';
import { useRecentLookups } from '../state/RecentLookups';
import type { RecentLookup } from '../state/RecentLookups';

// Remembered in this browser only, the same way the /owner page keeps its
// passcode -- so a signed-in user doesn't retype the key for every lookup.
const ACCOUNT_STORAGE_KEY = 'meridian.geocodeAccount';

function loadAccount(): AccountCredentials {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) ?? 'null');
    if (saved && typeof saved.email === 'string' && typeof saved.serviceKey === 'string') return saved;
  } catch {
    // Storage blocked or unreadable -- start blank.
  }
  return { email: '', serviceKey: '' };
}

function saveAccount(account: AccountCredentials) {
  try {
    if (account.email || account.serviceKey) localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  } catch {
    // Not remembered; the lookup itself still works.
  }
}

export default function Geocode() {
  const { recentLookups, addLookup } = useRecentLookups();
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecentLookup | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy coordinates');
  const [account, setAccount] = useState<AccountCredentials>(loadAccount);
  const signedIn = account.email.trim() !== '' && account.serviceKey.trim() !== '';

  const updateAccount = (change: Partial<AccountCredentials>) => {
    const next = { ...account, ...change };
    setAccount(next);
    saveAccount(next);
  };

  const runGeocode = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setError('Enter an address first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await geocode(trimmed, undefined, account);
      const lookup: RecentLookup = {
        address: trimmed,
        latitude: response.coordinates.latitude,
        longitude: response.coordinates.longitude,
        rangeSide: response.source === 'interpolation' ? response.rangeSide : undefined,
        approximate: response.source === 'interpolation' && response.approximate === true ? true : undefined,
        correctedZip: response.correctedZip,
        correctedStreet: response.source === 'llm_assisted' ? response.correctedStreet : undefined,
      };
      setResult(lookup);
      addLookup(lookup);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Geocoding failed.');
    } finally {
      setLoading(false);
    }
  }, [addLookup, account]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    navigator.clipboard?.writeText(`${result.latitude}, ${result.longitude}`).then(() => {
      setCopyLabel('Copied');
      setTimeout(() => setCopyLabel('Copy coordinates'), 1400);
    });
  }, [result]);

  return (
    <div>
      <PageHeader icon="geocode">Geocode</PageHeader>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Convert a street address to coordinates — matches /geocode.
      </p>

      <div className="form-map-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="field">
            <label>Address or place</label>
            <input
              className="input"
              placeholder="e.g. 997 Pequawket Trl, Standish, ME 04091"
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

          <details open={signedIn || undefined}>
            <summary className="text-muted" style={{ cursor: 'pointer', fontSize: 13 }}>
              {signedIn ? `Signed in as ${account.email.trim()}` : 'Use your account (AI spelling correction)'}
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
              <div className="field">
                <label>Account email</label>
                <input
                  className="input"
                  placeholder="you@company.com"
                  value={account.email}
                  onChange={(e) => updateAccount({ email: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Service key</label>
                <input
                  className="input"
                  placeholder="mk_..."
                  value={account.serviceKey}
                  onChange={(e) => updateAccount({ serviceKey: e.target.value })}
                />
                <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Optional. With both filled in, each found address uses one from your plan, and a
                  misspelled street gets an AI-assisted retry. Remembered in this browser; clear the
                  fields to stop.
                </p>
              </div>
            </div>
          </details>

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
            label={result ? `${result.address}${result.rangeSide ? ` (${result.rangeSide} side)` : ''}` : undefined}
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
                  {result.latitude.toFixed(6)}, {result.longitude.toFixed(6)}
                  {result.rangeSide && (
                    <>
                      {' · '}
                      <span className="tag tag-accent">{result.rangeSide} side</span>
                    </>
                  )}
                  {result.approximate && (
                    <>
                      {' · '}
                      <span className="tag" title="No street segment's address range includes this number; placed between the two nearest ones.">
                        approximate
                      </span>
                    </>
                  )}
                  {result.correctedStreet && (
                    <>
                      {' · '}
                      <span className="tag tag-accent" title="Not found as written; AI read it as this street.">
                        AI-corrected: {result.correctedStreet}
                      </span>
                    </>
                  )}
                  {result.correctedZip && (
                    <>
                      {' · '}
                      <span className="tag" title="Found in the town you named; the ZIP you gave belongs to a different area.">
                        ZIP corrected: {result.correctedZip}
                      </span>
                    </>
                  )}
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
