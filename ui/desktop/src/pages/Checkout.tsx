import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { DEFAULT_API_BASE_URL } from '../../../shared/api/client';
import { findTier, formatUsd } from '../../../shared/pricing';

// The app's PayPal Client ID (public by design -- meant to be embedded
// client-side, unlike the Client Secret, which only ever lives
// server-side in geocoding-server's .env). Defaults to the sandbox
// Client ID so a fresh checkout of this repo never accidentally takes
// real money; set VITE_PAYPAL_CLIENT_ID (e.g. in ui/desktop/.env.local,
// gitignored) to a live app's Client ID to go live.
const PAYPAL_CLIENT_ID =
  import.meta.env.VITE_PAYPAL_CLIENT_ID ||
  'AUDJ7TGH_-VU3s7R4O3XBDn80KhOZWab-25TanFeikBPx4hYA8aT_F9tqgaiwHmYwSRoJMxY9ODEiT3P';

// Purely cosmetic (which banner/wording to show) -- the server is what
// actually decides sandbox vs. live, based on which PAYPAL_API_BASE it
// was started with. Keep this in sync with that so the checkout page
// never tells a real paying customer "no real money moves".
const PAYPAL_ENV = import.meta.env.VITE_PAYPAL_ENV === 'live' ? 'live' : 'sandbox';

type Status = 'idle' | 'error' | 'success';

export default function Checkout() {
  const [params] = useSearchParams();
  const tier = findTier(Number(params.get('tier')));
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef(email);
  emailRef.current = email;

  useEffect(() => {
    if (!tier || !containerRef.current) return;

    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=USD`;
    script.onload = () => {
      const paypal = (window as any).paypal;
      paypal
        .Buttons({
          createOrder: (_data: unknown, actions: any) =>
            actions.order.create({
              purchase_units: [{ amount: { value: (tier.priceCents / 100).toFixed(2) } }],
            }),
          onApprove: async (data: { orderID: string }) => {
            const trimmedEmail = emailRef.current.trim();
            if (!trimmedEmail) {
              setStatus('error');
              setMessage('Enter your account email before paying.');
              return;
            }
            try {
              // Deliberately not calling actions.order.capture() here --
              // the server captures it (with the Client Secret), which is
              // what actually confirms the money moved instead of just
              // trusting the client's word for it.
              const response = await fetch(`${DEFAULT_API_BASE_URL}/billing/purchase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: trimmedEmail,
                  addressCount: tier.addressCount,
                  orderId: data.orderID,
                }),
              });
              const body = await response.json();
              if (!response.ok) {
                setStatus('error');
                setMessage(body.error ?? 'Purchase failed.');
                return;
              }
              setStatus('success');
              setServiceKey(body.serviceKey ?? '');
              setMessage(
                body.stubbed
                  ? `Done (test mode, no real charge) — ${body.tier.toLocaleString()} total monthly addresses now available for ${trimmedEmail}.`
                  : `Payment captured${PAYPAL_ENV === 'sandbox' ? ' (sandbox)' : ''} — ${body.tier.toLocaleString()} total monthly addresses now available for ${trimmedEmail}.`
              );
            } catch (err) {
              setStatus('error');
              setMessage(err instanceof Error ? err.message : 'Purchase failed.');
            }
          },
          onError: (err: unknown) => {
            setStatus('error');
            setMessage(err instanceof Error ? err.message : 'PayPal reported an error.');
          },
        })
        .render(containerRef.current);
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [tier]);

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
    <div style={{ maxWidth: 480 }}>
      <h1>Checkout</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        {tier.label} for {formatUsd(tier.priceCents)}.
      </p>

      <div className="card" style={{ background: 'var(--color-surface)', marginBottom: 'var(--space-4)' }}>
        <p className="card-body" style={{ margin: 0 }}>
          {PAYPAL_ENV === 'live' ? (
            <>
              <strong>This is a real charge.</strong> Completing checkout charges your PayPal
              account or card for the amount above — captured server-side once you approve it.
            </>
          ) : (
            <>
              <strong>Sandbox mode:</strong> this runs PayPal's real sandbox order flow, captured
              server-side — no real money moves, but the transaction itself is real (it'll show up
              in PayPal's sandbox dashboard). Your account's quota is topped up for real either way.
            </>
          )}
        </p>
      </div>

      <div className="field" style={{ marginBottom: 'var(--space-4)' }}>
        <label>Account email</label>
        <input
          className="input"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div ref={containerRef} />

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
                  flow if you lose it.
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
