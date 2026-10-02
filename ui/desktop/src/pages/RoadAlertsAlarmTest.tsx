import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import PageHeader from '../components/PageHeader';
import RoadAlertsTabs from '../components/RoadAlertsTabs';

// Debugging aid for "alarms aren't reliably firing": a one-click way to run
// the real fetch/match/chime/speech pipeline on demand, instead of either
// hand-typing lat/lng into the Road Alerts page's own manual-check card or
// waiting on real GPS movement to trigger it. Deliberately reuses that real
// path end to end (via the alarmTestCoords handoff RoadAlerts.tsx reads on
// mount) rather than faking a chime/list render here -- the point is to
// isolate whether the production path itself works, not to prove a mock does.
export default function RoadAlertsAlarmTest() {
  const navigate = useNavigate();
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAlarmTest = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setError('This browser does not support geolocation.');
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        navigate('/road-alerts', {
          state: {
            alarmTestCoords: {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              heading: typeof pos.coords.heading === 'number' && pos.coords.heading >= 0 ? pos.coords.heading : null,
            },
          },
        });
      },
      (err) => {
        setError(err.message || 'Could not get your current location.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [navigate]);

  return (
    <div>
      <PageHeader icon="roadAlerts">Raising Alarm</PageHeader>
      <RoadAlertsTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Step 1 of debugging why alarms aren't reliably firing: confirms the chime sound and the
        alert list both work. This grabs your real current location, then runs the exact same
        hazard check the Road Alerts page's own "Test a location manually" card does -- same
        fetch, same matching, same chime -- against whatever real hazards are actually near you
        right now, just triggered with one click instead of typing coordinates by hand.
      </p>

      <div className="card elev-sm" style={{ maxWidth: 480 }}>
        {error && (
          <p className="card-body" style={{ color: '#a4402a', margin: '0 0 var(--space-3)' }}>
            {error}
          </p>
        )}
        <button className="btn btn-primary" onClick={handleAlarmTest} disabled={locating}>
          {locating ? 'Finding your location…' : 'Alarm Test'}
        </button>
      </div>
    </div>
  );
}
