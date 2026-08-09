import { useCallback, useState } from 'react';

import { getQuota } from '../../../shared/api/client';
import type { QuotaStatus } from '../../../shared/api/types';

export default function PlanQuota() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  const handleCheck = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter an account email first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setQuota(await getQuota(trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checking quota failed.');
      setQuota(null);
    } finally {
      setLoading(false);
    }
  }, [email]);

  const usedFraction = quota ? Math.min(1, quota.usedThisPeriod / quota.tier) : 0;

  return (
    <div>
      <h1>Plan &amp; quota</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Usage resets on the 1st of each calendar month, per account email.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        <div className="card elev-sm">
          <div className="field">
            <label>Account email</label>
            <input
              className="input"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCheck();
              }}
            />
          </div>
          <button className="btn btn-primary btn-block" onClick={handleCheck} disabled={loading}>
            {loading ? 'Checking…' : 'Check quota'}
          </button>
          {error && (
            <p className="card-body" style={{ color: '#a4402a', margin: 0 }}>
              {error}
            </p>
          )}

          {quota && (
            <>
              <div className="hr" />
              <div className="card-kicker">Current period</div>
              <div className="card-title">
                {quota.usedThisPeriod.toLocaleString()} / {quota.tier.toLocaleString()} requests
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: 'var(--color-divider)',
                  margin: 'var(--space-2) 0',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${usedFraction * 100}%`,
                    background: 'var(--color-accent-500)',
                  }}
                />
              </div>
              <div className="card-meta">Resets {quota.periodStart}</div>
              <button
                className="btn btn-secondary"
                style={{ marginTop: 'var(--space-2)' }}
                onClick={() =>
                  alert('There is no self-service upgrade yet — contact your administrator to request a higher tier.')
                }
              >
                Request quota increase
              </button>
            </>
          )}
        </div>

        <div className="card elev-sm">
          <div className="card-kicker">Requests, last 7 days</div>
          <p className="card-body" style={{ marginTop: 'var(--space-2)' }}>
            Not tracked yet — geocoding-server doesn't log per-day request history, so this chart
            can't be shown honestly. Only the current-period total (left) is real data.
          </p>
        </div>
      </div>

      <div className="card" style={{ background: 'var(--color-surface)' }}>
        <p className="card-body" style={{ margin: 0 }}>
          Usage is tracked per account email, not per API key — quota checks key off the address you
          enter above.
        </p>
      </div>
    </div>
  );
}
