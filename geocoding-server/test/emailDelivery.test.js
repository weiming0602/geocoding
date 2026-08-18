const test = require('node:test');
const assert = require('node:assert/strict');

const { SESClient } = require('@aws-sdk/client-ses');
const { sendServiceKeyEmail, sendRoadAlertEmail, sendFeedbackNotification } = require('../src/emailDelivery');

// sendServiceKeyEmail only calls real SES when all three env vars are
// set; each test sets/restores them directly (there's no shared
// withTestServer here since this doesn't touch either Postgres
// database) and mocks SESClient.prototype.send via the test context,
// which node:test automatically restores when the test ends.

function withSesConfigured(env, fn) {
  return async (t) => {
    const defaults = {
      AWS_ACCESS_KEY_ID: 'test-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      SES_FROM_EMAIL: 'no-reply@example.com',
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
  'sendServiceKeyEmail sends via SES when configured',
  withSesConfigured({}, async (t) => {
    const sendMock = t.mock.method(SESClient.prototype, 'send', async () => ({}));

    const result = await sendServiceKeyEmail('alice@example.com', {
      serviceKey: 'mk_abc123',
      tier: 1500,
      purchased: 1000,
      priceCents: 1500,
    });

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(sendMock.mock.callCount(), 1);

    const command = sendMock.mock.calls[0].arguments[0];
    assert.equal(command.input.Source, 'no-reply@example.com');
    assert.deepEqual(command.input.Destination.ToAddresses, ['alice@example.com']);
    assert.match(command.input.Message.Body.Text.Data, /mk_abc123/);
  })
);

test(
  'sendServiceKeyEmail falls back to the stub when SES env vars are missing',
  async (t) => {
    const saved = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      SES_FROM_EMAIL: process.env.SES_FROM_EMAIL,
    };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.SES_FROM_EMAIL;
    const sendMock = t.mock.method(SESClient.prototype, 'send', async () => ({}));

    try {
      const result = await sendServiceKeyEmail('alice@example.com', {
        serviceKey: 'mk_abc123',
        tier: 1500,
        purchased: 1000,
        priceCents: 1500,
      });
      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(sendMock.mock.callCount(), 0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
);

test(
  'sendServiceKeyEmail reports failure instead of throwing when SES errors',
  withSesConfigured({}, async (t) => {
    t.mock.method(SESClient.prototype, 'send', async () => {
      throw new Error('SES rejected the request');
    });

    const result = await sendServiceKeyEmail('alice@example.com', {
      serviceKey: 'mk_abc123',
      tier: 1500,
      purchased: 1000,
      priceCents: 1500,
    });

    assert.equal(result.delivered, false);
    assert.equal(result.stubbed, false);
    assert.match(result.error, /SES rejected the request/);
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
  withSesConfigured({}, async (t) => {
    const sendMock = t.mock.method(SESClient.prototype, 'send', async () => ({}));

    const result = await sendRoadAlertEmail('alice@example.com', SAMPLE_SIGNAL);

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(sendMock.mock.callCount(), 1);

    const command = sendMock.mock.calls[0].arguments[0];
    assert.deepEqual(command.input.Destination.ToAddresses, ['alice@example.com']);
    assert.match(command.input.Message.Subject.Data, /I-95/);
    assert.match(command.input.Message.Body.Text.Data, /Slow traffic on I-95 southbound near York/);
    assert.match(command.input.Message.Body.Text.Data, /43\.168363/);
  })
);

test(
  'sendRoadAlertEmail falls back to the stub when SES env vars are missing',
  async (t) => {
    const saved = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      SES_FROM_EMAIL: process.env.SES_FROM_EMAIL,
    };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.SES_FROM_EMAIL;
    const sendMock = t.mock.method(SESClient.prototype, 'send', async () => ({}));

    try {
      const result = await sendRoadAlertEmail('alice@example.com', SAMPLE_SIGNAL);
      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(sendMock.mock.callCount(), 0);
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
  withSesConfigured({ FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' }, async (t) => {
    const sendMock = t.mock.method(SESClient.prototype, 'send', async () => ({}));

    const result = await sendFeedbackNotification({
      name: 'Vasily',
      email: 'commenter@example.com',
      message: 'Love the service, any plans for Vermont?',
    });

    assert.deepEqual(result, { delivered: true, stubbed: false });
    assert.equal(sendMock.mock.callCount(), 1);

    const command = sendMock.mock.calls[0].arguments[0];
    assert.deepEqual(command.input.Destination.ToAddresses, ['owner@example.com']);
    assert.match(command.input.Message.Body.Text.Data, /Vasily/);
    assert.match(command.input.Message.Body.Text.Data, /Vermont/);
    assert.match(command.input.Message.Body.Text.Data, /commenter@example\.com/);
  })
);

test(
  'sendFeedbackNotification falls back to the stub when FEEDBACK_NOTIFY_EMAIL is missing',
  withSesConfigured({}, async (t) => {
    const savedNotifyEmail = process.env.FEEDBACK_NOTIFY_EMAIL;
    delete process.env.FEEDBACK_NOTIFY_EMAIL;
    const sendMock = t.mock.method(SESClient.prototype, 'send', async () => ({}));

    try {
      const result = await sendFeedbackNotification({
        name: null,
        email: null,
        message: 'no contact info left',
      });

      assert.deepEqual(result, { delivered: false, stubbed: true });
      assert.equal(sendMock.mock.callCount(), 0);
    } finally {
      if (savedNotifyEmail !== undefined) process.env.FEEDBACK_NOTIFY_EMAIL = savedNotifyEmail;
    }
  })
);
