import { useEffect, useState } from 'react';

import { getQuota } from '../../../shared/api/client';

// Placeholder page -- proves the API client is actually wired up to
// geocoding-server (not just present in the bundle) by making one real
// call on mount. Not the real Overview screen; see the design handoff's
// README for what that should look like once implemented, including
// which of its stat tiles are real vs. fictional.
export default function Overview() {
  const [status, setStatus] = useState('checking...');

  useEffect(() => {
    getQuota('demo@example.com')
      .then((quota) => setStatus(`connected -- demo@example.com: ${quota.usedThisPeriod}/${quota.tier} used`))
      .catch((err) => setStatus(`API call failed: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  return (
    <div>
      <h1>Overview</h1>
      <p>Scaffold placeholder -- not the real screen yet.</p>
      <p>
        <strong>API connectivity check:</strong> {status}
      </p>
    </div>
  );
}
