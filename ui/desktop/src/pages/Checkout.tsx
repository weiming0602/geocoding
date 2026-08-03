import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { DEFAULT_API_BASE_URL } from '../../../shared/api/client';
import { findTier, formatUsd } from '../../../shared/pricing';

// PayPal's documented sandbox demo client-id, usable without a real PayPal
// developer account -- renders a real button and completes a real
// (sandbox) approval flow client-side. Swap via VITE_PAYPAL_CLIENT_ID once
// real credentials are chosen; server-side capture is still a deliberate
// stub either way (see geocoding-server/src/billing.js) until then.
const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID || 'test';

type Status = 'idle' | 'error' | 'success';

export default function Checkout() {
  const [params] = useSearchParams();
  const tier = findTier(Number(params.get('tier')));
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
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
          onApprove: async (_data: unknown, actions: any) => {
            const trimmedEmail = emailRef.current.trim();
            if (!trimmedEmail) {
              setStatus('error');
              setMessage('Enter your account email before paying.');
              return;
            }
            try {
              const order = await actions.order.capture();
              const response = await fetch(`${DEFAULT_API_BASE_URL}/billing/purchase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: trimmedEmail,
                  addressCount: tier.addressCount,
                  orderId: order.id,
                }),
              });
              const body = await response.json();
              if (!response.ok) {
                setStatus('error');
                setMessage(body.error ?? 'Purchase failed.');
                return;
              }
              setStatus('success');
              setMessage(
                `Done (test mode, no real charge) — ${body.tier.toLocaleString()} total monthly addresses now available for ${trimmedEmail}.`
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
          <strong>Test mode:</strong> PayPal's sandbox approval flow runs for real, but the
          server-side charge is a deliberate stub — no money moves. Your account's quota is topped
          up for real, though.
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
        <p className="card-body" style={{ color: 'var(--color-accent)', marginTop: 'var(--space-4)' }}>
          {message}
        </p>
      )}
      {status === 'error' && (
        <p className="card-body" style={{ color: '#a4402a', marginTop: 'var(--space-4)' }}>
          {message}
        </p>
      )}
    </div>
  );
}
