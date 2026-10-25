import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPushCapable, showAlertNotification } from './roadAlertNotifications';

describe('isPushCapable', () => {
  it('is false when serviceWorker or PushManager is unavailable', () => {
    // jsdom (this project's test environment) has neither -- see vite.config.ts's test.environment.
    expect(isPushCapable()).toBe(false);
  });
});

describe('showAlertNotification', () => {
  const sketch = {
    trail: [{ latitude: 43.65, longitude: -70.26 }],
    position: { latitude: 43.6575, longitude: -70.2585 },
    headingDeg: 20,
    hazard: { latitude: 43.664, longitude: -70.255 },
  };
  const NotificationMock = vi.fn() as unknown as typeof Notification & ReturnType<typeof vi.fn>;

  function stubNotifications(permission: NotificationPermission, serviceWorker?: object) {
    Object.assign(NotificationMock, { permission });
    vi.stubGlobal('Notification', NotificationMock);
    if (serviceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(NotificationMock).mockClear();
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  it('hands the notification and its sketch to the active service worker', async () => {
    const postMessage = vi.fn();
    stubNotifications('granted', { getRegistration: () => Promise.resolve({ active: { postMessage } }) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(postMessage).toHaveBeenCalledWith({
      type: 'road-alert-notification',
      title: 'Serious road alert',
      body: 'Crash ahead',
      sketch,
    });
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('falls back to a plain page notification when no service worker is active', async () => {
    stubNotifications('granted', { getRegistration: () => Promise.resolve(undefined) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await vi.waitFor(() => expect(NotificationMock).toHaveBeenCalledWith('Serious road alert', { body: 'Crash ahead' }));
  });

  it('does nothing without notification permission', async () => {
    const postMessage = vi.fn();
    stubNotifications('default', { getRegistration: () => Promise.resolve({ active: { postMessage } }) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postMessage).not.toHaveBeenCalled();
    expect(NotificationMock).not.toHaveBeenCalled();
  });
});
