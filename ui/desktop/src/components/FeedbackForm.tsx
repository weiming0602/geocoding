import { useState } from 'react';

import { DEFAULT_API_BASE_URL, fetchOrThrow } from '../../../shared/api/client';

type Status = 'idle' | 'submitting' | 'success' | 'error';

// POST /feedback -- a one-way comment/question box. There's no public
// display or in-app reply: the site owner gets notified by email and
// replies directly, outside the app, to whatever email is left here.
export default function FeedbackForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!message.trim()) {
      setStatus('error');
      setError('Enter a comment or question first.');
      return;
    }
    setStatus('submitting');
    setError('');
    try {
      const response = await fetchOrThrow(`${DEFAULT_API_BASE_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          message: message.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setStatus('error');
        setError(body.error ?? 'Something went wrong.');
        return;
      }
      setStatus('success');
      setName('');
      setEmail('');
      setMessage('');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <div className="card elev-sm" style={{ maxWidth: 480 }}>
      <h2 style={{ marginTop: 0 }}>Comments or questions</h2>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Leave an email if you'd like a reply — we'll write back directly.
      </p>

      <div className="field">
        <label>Name (optional)</label>
        <input
          className="input"
          placeholder="Just a first name is fine"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Email (optional)</label>
        <input
          className="input"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Comment or question</label>
        <textarea
          className="input"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <button
        className="btn btn-primary"
        onClick={handleSubmit}
        disabled={status === 'submitting'}
      >
        {status === 'submitting' ? 'Sending…' : 'Send'}
      </button>

      {status === 'success' && (
        <p className="card-body" style={{ color: 'var(--color-accent)', marginTop: 'var(--space-3)' }}>
          Thanks — got it.
        </p>
      )}
      {status === 'error' && (
        <p className="card-body" style={{ color: '#a4402a', marginTop: 'var(--space-3)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
