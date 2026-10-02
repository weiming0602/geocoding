import { describe, expect, it } from 'vitest';
import { isPushCapable } from './roadAlertNotifications';

describe('isPushCapable', () => {
  it('is false when serviceWorker or PushManager is unavailable', () => {
    // jsdom (this project's test environment) has neither -- see vite.config.ts's test.environment.
    expect(isPushCapable()).toBe(false);
  });
});
