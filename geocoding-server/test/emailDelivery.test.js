const test = require('node:test');
const assert = require('node:assert/strict');

const { sendServiceKeyEmail, sendRoadAlertEmail, sendFeedbackNotification } = require('../src/emailDelivery');

// sendServiceKeyEmail only calls Resend's API when both env vars are
// set; each test sets/restores them directly (there's no shared
// withTestServer here since this doesn't touch either Postgres
// database) and mocks the global fetch via the test context, which
// node:test automatically restores when the test ends.

function withResendConfigured(env, fn) {
  return async (t) => {
    const defaults = {
      RESEND_API_KEY: 'test-key',
      RESEND_FROM_EMAIL: 'no-reply@example.com',
    };
    const overrides = { ...defaults, ...env };
    const saved = {};
    for (const key of Object.keys(overrides)) saved[key] = process.env[key];
    Object.assign(process.env, overrides);
    try {
      await fn(t);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

test(
  'sendServiceKeyEmail sends via Resend when configured',
  withResendConfigured({}, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    const result = await sendServiceKeyEmail('alice@example.com', {
      serviceKey: 'mk_abc123',
      tier: 1500,
      purchased: 1000,
      priceCents: 1500,
    });

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(fetchMock.mock.callCount(), 1);

    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.from, 'no-reply@example.com');
    assert.deepEqual(body.to, ['alice@example.com']);
    assert.match(body.text, /mk_abc123/);
  })
);

test(
  'sendServiceKeyEmail falls back to the stub when Resend env vars are missing',
  async (t) => {
    const saved = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    };
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    try {
      const result = await sendServiceKeyEmail('alice@example.com', {
        serviceKey: 'mk_abc123',
        tier: 1500,
        purchased: 1000,
        priceCents: 1500,
      });
      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
);

test(
  'sendServiceKeyEmail reports failure instead of throwing when Resend errors',
  withResendConfigured({}, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('rate limited', { status: 429 }));

    const result = await sendServiceKeyEmail('alice@example.com', {
      serviceKey: 'mk_abc123',
      tier: 1500,
      purchased: 1000,
      priceCents: 1500,
    });

    assert.equal(result.delivered, false);
    assert.equal(result.stubbed, false);
    assert.match(result.error, /Resend responded 429/);
  })
);

const SAMPLE_SIGNAL = {
  id: 'ME26-002841',
  roadway: 'I-95',
  severity: 'proximity',
  latitude: 43.168363,
  longitude: -70.653171,
  source: 'New England 511',
  network: 'Maine',
  speech: { brief: 'Traffic on I-95.', average: 'Slow traffic on I-95 south.', deep: 'Slow traffic on I-95 southbound near York.' },
};

test(
  'sendRoadAlertEmail sends the signal to the account\'s own email when configured',
  withResendConfigured({}, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    const result = await sendRoadAlertEmail('alice@example.com', SAMPLE_SIGNAL);

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(fetchMock.mock.callCount(), 1);

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, ['alice@example.com']);
    assert.match(body.subject, /I-95/);
    assert.match(body.text, /Slow traffic on I-95 southbound near York/);
    assert.match(body.text, /43\.168363/);
  })
);

test(
  'sendRoadAlertEmail falls back to the stub when Resend env vars are missing',
  async (t) => {
    const saved = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    };
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    try {
      const result = await sendRoadAlertEmail('alice@example.com', SAMPLE_SIGNAL);
      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
);

test(
  'sendFeedbackNotification sends to FEEDBACK_NOTIFY_EMAIL when configured',
  withResendConfigured({ FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' }, async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    const result = await sendFeedbackNotification({
      name: 'Vasily',
      email: 'commenter@example.com',
      message: 'Love the service, any plans for Vermont?',
    });

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(fetchMock.mock.callCount(), 1);

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, ['owner@example.com']);
    assert.match(body.text, /Vasily/);
    assert.match(body.text, /Vermont/);
    assert.match(body.text, /commenter@example\.com/);
  })
);

test(
  'sendFeedbackNotification falls back to the stub when FEEDBACK_NOTIFY_EMAIL is missing',
  withResendConfigured({}, async (t) => {
    const savedNotifyEmail = process.env.FEEDBACK_NOTIFY_EMAIL;
    delete process.env.FEEDBACK_NOTIFY_EMAIL;
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));

    try {
      const result = await sendFeedbackNotification({
        name: null,
        email: null,
        message: 'no contact info left',
      });

      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      if (savedNotifyEmail !== undefined) process.env.FEEDBACK_NOTIFY_EMAIL = savedNotifyEmail;
    }
  })
);
