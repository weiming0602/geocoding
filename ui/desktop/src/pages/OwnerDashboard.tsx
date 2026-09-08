import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, getTransactions } from '../../../shared/api/client';
import type { Transaction } from '../../../shared/api/types';
import { useRecentLookups } from '../state/RecentLookups';

// Gated by a shared admin passcode (ADMIN_PASSCODE on the server) since
// real transaction data lands here -- see the module-level comment this
// replaced, which warned that this page's old "just not linked in the
// nav" obscurity wasn't a real security boundary. There's still no login
// system anywhere in this app (see CLAUDE.md), so this is the simplest
// real gate available, same trust model as a batch service key: one
// shared secret, remembered in this browser's localStorage after entry.
const STORAGE_KEY = 'meridianAdminPasscode';

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  );
}

export default function OwnerDashboard() {
  const { recentLookups } = useRecentLookups();

  const [passcodeInput, setPasscodeInput] = useState('');
  const [passcode, setPasscode] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getTransactions(key);
      setTransactions(result.transactions);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect passcode.');
        localStorage.removeItem(STORAGE_KEY);
        setPasscode(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not load transactions.');
      }
      setTransactions(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (passcode) load(passcode);
  }, [passcode, load]);

  const handleUnlock = () => {
    const trimmed = passcodeInput.trim();
    if (!trimmed) return;
    localStorage.setItem(STORAGE_KEY, trimmed);
    setPasscode(trimmed);
  };

  const handleSignOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPasscode(null);
    setTransactions(null);
    setPasscodeInput('');
  };

  const todaysTransactions = useMemo(
    () => (transactions ?? []).filter((t) => isToday(t.createdAt)),
    [transactions]
  );
  const todaysRevenueCents = todaysTransactions.reduce((sum, t) => sum + t.priceCents, 0);

  if (!passcode) {
    return (
      <div>
        <h1>Owner dashboard</h1>
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          Not linked anywhere in the app -- bookmark this page if you want to check back on it.
          Owner/manager only: enter the admin passcode to view transactions.
        </p>
        <div className="card elev-sm" style={{ maxWidth: 480 }}>
          <div className="field">
            <label>Admin passcode</label>
            <input
              className="input"
              type="password"
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleUnlock();
              }}
              autoFocus
            />
          </div>
          {error && (
            <p className="card-body" style={{ color: '#a4402a', margin: '0 0 var(--space-3)' }}>
              {error}
            </p>
          )}
          <button className="btn btn-primary" onClick={handleUnlock}>
            Unlock
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-2)',
        }}
      >
        <h1 style={{ margin: 0 }}>Owner dashboard</h1>
        <button className="btn btn-secondary" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Not linked anywhere in the app -- bookmark this page if you want to check back on it.
      </p>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}
      >
        <div className="card elev-sm">
          <div className="card-kicker">Transactions today</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            {transactions === null ? '…' : todaysTransactions.length}
          </div>
          <div className="card-meta">Completed purchases since midnight, this browser's local time</div>
        </div>
        <div className="card elev-sm">
          <div className="card-kicker">Revenue today</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            {transactions === null ? '…' : formatPrice(todaysRevenueCents)}
          </div>
          <div className="card-meta">Sum of today's completed purchases</div>
        </div>
        <div className="card elev-sm">
          <div className="card-kicker">Batch jobs running</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            N/A
          </div>
          <div className="card-meta">Batch runs synchronously — no queue</div>
        </div>
        <div className="card elev-sm">
          <div className="card-kicker">Quota remaining</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-heading-weight)', fontSize: 24 }}>
            —
          </div>
          <div className="card-meta">Check a specific account on Plan &amp; quota</div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-3)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        <h4 style={{ margin: 0 }}>
          Transactions{' '}
          {transactions !== null && (
            <span className="text-muted" style={{ fontWeight: 400 }}>
              ({transactions.length} total, {formatPrice(transactions.reduce((sum, t) => sum + t.priceCents, 0))})
            </span>
          )}
        </h4>
        <button className="btn btn-secondary" onClick={() => load(passcode)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="card-body" style={{ color: '#a4402a', marginBottom: 'var(--space-3)' }}>
          {error}
        </p>
      )}

      <div style={{ overflowX: 'auto', marginBottom: 'var(--space-6)' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Email</th>
              <th>Order ID</th>
              <th>Addresses</th>
              <th>Price</th>
              <th>New tier</th>
            </tr>
          </thead>
          <tbody>
            {transactions !== null && transactions.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted">
                  No transactions yet.
                </td>
              </tr>
            )}
            {(transactions ?? []).map((t) => (
              <tr key={t.id}>
                <td className="text-muted">{new Date(t.createdAt).toLocaleString()}</td>
                <td>{t.email}</td>
                <td className="text-muted">{t.orderId}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{t.addressCount.toLocaleString()}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPrice(t.priceCents)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{t.tier.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 style={{ marginBottom: 'var(--space-3)' }}>Recent activity (this browser only)</h4>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Coordinates</th>
              <th>Side</th>
            </tr>
          </thead>
          <tbody>
            {recentLookups.length === 0 && (
              <tr>
                <td colSpan={3} className="text-muted">
                  Nothing yet this session — try Geocode or Reverse geocode.
                </td>
              </tr>
            )}
            {recentLookups.map((lookup, index) => (
              <tr key={index}>
                <td>{lookup.address}</td>
                <td className="text-muted" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                  {lookup.latitude.toFixed(5)}, {lookup.longitude.toFixed(5)}
                </td>
                <td>
                  <span className="tag tag-accent">{lookup.rangeSide}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
