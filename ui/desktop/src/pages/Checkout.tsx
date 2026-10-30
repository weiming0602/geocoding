import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { completeCheckout, createCheckoutSession } from '../../../shared/api/client';
import { findTier, formatUsd } from '../../../shared/pricing';

// Purely cosmetic (which banner/wording to show) -- the server is what
// actually decides test vs. live, based on whether its STRIPE_SECRET_KEY
// is an `sk_test_` or `sk_live_` key. Keep this in sync with that so the
// checkout page never tells a real paying customer "no real money moves".
const STRIPE_ENV = import.meta.env.VITE_STRIPE_ENV === 'live' ? 'live' : 'test';

type Status = 'idle' | 'redirecting' | 'completing' | 'error' | 'success';

// Payment happens on Stripe's own hosted page: "Continue to payment" asks
// the server for a Checkout Session and redirects there, and Stripe sends
// the browser back here (same #/checkout?tier=... URL) with `session_id`
// (paid) or `canceled=1` (backed out) added. Back with a session id, the
// page asks the server to confirm the payment with Stripe and grant the
// quota -- never trusting the redirect itself as proof of payment.
export default function Checkout() {
  const [params] = useSearchParams();
  const tier = findTier(Number(params.get('tier')));
  const sessionId = params.get('session_id');
  const canceled = params.get('canceled') === '1';
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>(sessionId ? 'completing' : 'idle');
  const [message, setMessage] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [serviceKeyEmailed, setServiceKeyEmailed] = useState(false);
  // Completing twice is harmless (the server grants each session once),
  // but React's dev-mode double effect would otherwise race two calls and
  // could show the second's "not known if emailed" over the first's answer.
  const completedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || completedSessionRef.current === sessionId) return;
    completedSessionRef.current = sessionId;
    completeCheckout(sessionId)
      .then((body) => {
        setStatus('success');
        setServiceKey(body.serviceKey ?? '');
        setServiceKeyEmailed(Boolean(body.serviceKeyEmailed));
        setMessage(
          body.stubbed
            ? `Done (test mode, no real charge) — ${body.tier.toLocaleString()} total monthly addresses now available for ${body.email}.`
            : `Payment received${STRIPE_ENV === 'test' ? ' (Stripe test mode)' : ''} — ${body.tier.toLocaleString()} total monthly addresses now available for ${body.email}.`
        );
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Could not confirm the payment.');
      });
  }, [sessionId]);

  async function handlePay() {
    if (!tier) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setStatus('error');
      setMessage('Enter your account email before paying.');
      return;
    }
    setStatus('redirecting');
    setMessage('');
    try {
      const { url } = await createCheckoutSession({
        email: trimmedEmail,
        addressCount: tier.addressCount,
        returnUrl: `${window.location.origin}${window.location.pathname}#/checkout?tier=${tier.addressCount}`,
      });
      window.location.assign(url);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Could not start checkout.');
    }
  }

  if (!tier) {
    return (
      <div>
        <h1>Checkout</h1>
        <p>
          Unknown pricing tier. <Link to="/pricing">Back to pricing</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <h1>Checkout</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        {tier.label} for {formatUsd(tier.priceCents)}.
      </p>

      <div className="card" style={{ background: 'var(--color-surface)', marginBottom: 'var(--space-4)' }}>
        <p className="card-body" style={{ margin: 0 }}>
          {STRIPE_ENV === 'live' ? (
            <>
              <strong>This is a real charge.</strong> Continuing takes you to Stripe's secure
              checkout page to pay by card for the amount above; you'll come back here once it's
              done.
            </>
          ) : (
            <>
              <strong>Test mode:</strong> this runs Stripe's real checkout flow in test mode — no real
              money moves (pay with Stripe's test card 4242 4242 4242 4242, any future expiry, any
              CVC). Your account's quota is topped up for real either way.
            </>
          )}
        </p>
      </div>

      {status !== 'success' && status !== 'completing' && (
        <>
          {canceled && status === 'idle' && (
            <p className="card-body text-muted" style={{ marginBottom: 'var(--space-4)' }}>
              Checkout canceled — nothing was charged.
            </p>
          )}
          <div className="field" style={{ marginBottom: 'var(--space-4)' }}>
            <label>Account email</label>
            <input
              className="input"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <button className="btn btn-primary" onClick={handlePay} disabled={status === 'redirecting'}>
            {status === 'redirecting' ? 'Opening checkout…' : `Continue to payment — ${formatUsd(tier.priceCents)}`}
          </button>
        </>
      )}

      {status === 'completing' && (
        <p className="card-body" style={{ marginTop: 'var(--space-4)' }}>
          Confirming your payment…
        </p>
      )}
      {status === 'success' && (
        <>
          <p className="card-body" style={{ color: 'var(--color-accent)', marginTop: 'var(--space-4)' }}>
            {message}
          </p>
          {serviceKey && (
            <div
              className="card"
              style={{ background: 'var(--color-surface)', marginTop: 'var(--space-3)' }}
            >
              <div className="card-body">
                <p style={{ margin: '0 0 var(--space-2)' }}>
                  <strong>Your service key</strong> — save this now. You'll need to enter it, along
                  with your account email, every time you run batch geocoding. There's no recovery
                  flow if you lose it.{' '}
                  {serviceKeyEmailed
                    ? "We've also emailed it to you, so it's not just on this screen."
                    : "We couldn't confirm it was emailed to you, so this screen is the only copy right now — save it before you navigate away."}
                </p>
                <code
                  style={{
                    display: 'block',
                    padding: 'var(--space-2)',
                    background: 'var(--color-bg)',
                    wordBreak: 'break-all',
                  }}
                >
                  {serviceKey}
                </code>
              </div>
            </div>
          )}
        </>
      )}
      {status === 'error' && (
        <p className="card-body" style={{ color: '#a4402a', marginTop: 'var(--space-4)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
