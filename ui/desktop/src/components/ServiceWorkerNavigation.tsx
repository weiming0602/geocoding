import { useEffect } from 'react';
import { useNavigate } from 'react-router';

// Must render inside <Router> -- useNavigate needs that context. sw.js's
// notificationclick handler postMessages an already-open tab rather than
// using Client.navigate() (unsupported in Safari's service worker, this
// app's main target on iOS); this is the other half of that handoff.
export default function ServiceWorkerNavigation() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'road-alerts-notification-click' && typeof event.data.path === 'string') {
        navigate(event.data.path);
      }
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [navigate]);

  return null;
}
