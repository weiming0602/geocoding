import { useEffect } from 'react';

/**
 * Sends the visitor to another site (replacing this history entry, so
 * Back doesn't bounce them straight here again), with a plain link as a
 * fallback in case the redirect is blocked. Used for old bookmarks of
 * pages that moved between meridiangeocoding.com and
 * alerts.meridiangeocoding.com -- see siteConfig.ts.
 */
export default function ExternalRedirect({ to, label }: { to: string; label: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <p className="text-muted">
      {label} has moved to <a href={to}>{to}</a>.
    </p>
  );
}
