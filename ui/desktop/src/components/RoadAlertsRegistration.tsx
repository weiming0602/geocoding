import { useCallback, useState } from 'react';

import { registerRoadAlerts } from '../../../shared/api/client';
import { setStoredAccount, type StoredRoadAlertsAccount } from '../roadAlertsStorage';

type Props = {
  onRegistered: (account: StoredRoadAlertsAccount) => void;
  // Shown after a stale/invalid stored account was cleared -- distinct
  // from a plain first-time registration, so the copy can say why this
  // form is back instead of the page just working.
  reason?: string | null;
};

export default function RoadAlertsRegistration({ onRegistered, reason }: Props) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter an email address.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await registerRoadAlerts(trimmed);
      const account = { email: result.email, serviceKey: result.serviceKey };
      setStoredAccount(account);
      onRegistered(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  }, [email, onRegistered]);

  return (
    <div className="card elev-sm" style={{ maxWidth: 440 }}>
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>Register to get started</h2>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Free while we're testing this feature — no payment required.
      </p>

      {reason && (
        <div className="card" style={{ background: 'var(--color-surface)', marginBottom: 'var(--space-4)' }}>
          <p className="card-body" style={{ margin: 0 }}>
            {reason}
          </p>
        </div>
      )}

      <div className="card" style={{ background: 'var(--color-surface)', marginBottom: 'var(--space-4)' }}>
        <p className="card-body" style={{ margin: 0 }}>
          Just an email — no password. You'll get a service key back (also emailed to you); this
          browser remembers it so you won't need to re-enter it every visit. Registering again later
          with the same email re-sends your existing key, so it's safe to use as a recovery step if
          you ever need it.
        </p>
      </div>

      <div className="field">
        <label>Email</label>
        <input
          className="input"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRegister();
          }}
          disabled={loading}
        />
      </div>

      {error && (
        <p className="card-body" style={{ color: '#a4402a', margin: '0 0 var(--space-3)' }}>
          {error}
        </p>
      )}

      <button className="btn btn-primary btn-block" onClick={handleRegister} disabled={loading}>
        {loading ? 'Registering…' : 'Register'}
      </button>
    </div>
  );
}
