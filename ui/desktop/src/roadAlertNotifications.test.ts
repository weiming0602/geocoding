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

  // A fake active service worker: replies on the transferred port the way
  // public/sw.js does, or stays silent like an outdated one would.
  function fakeWorker(reply: { shown: boolean } | null) {
    return {
      postMessage: vi.fn((_message: unknown, ports: MessagePort[]) => {
        if (reply) ports[0].postMessage(reply);
      }),
    };
  }

  it('hands the notification and its sketch to the active service worker', async () => {
    const worker = fakeWorker({ shown: true });
    stubNotifications('granted', { getRegistration: () => Promise.resolve({ active: worker }) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    expect(worker.postMessage.mock.calls[0][0]).toEqual({
      type: 'road-alert-notification',
      title: 'Serious road alert',
      body: 'Crash ahead',
      sketch,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('falls back to a plain notification when the service worker never confirms (e.g. an outdated version)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const worker = fakeWorker(null);
      stubNotifications('granted', { getRegistration: () => Promise.resolve({ active: worker }) });
      showAlertNotification('Serious road alert', 'Crash ahead', sketch);
      await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
      expect(NotificationMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1600);
      expect(NotificationMock).toHaveBeenCalledWith('Serious road alert', { body: 'Crash ahead' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a plain notification when the service worker reports it could not show one', async () => {
    const worker = fakeWorker({ shown: false });
    stubNotifications('granted', { getRegistration: () => Promise.resolve({ active: worker }) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await vi.waitFor(() => expect(NotificationMock).toHaveBeenCalledWith('Serious road alert', { body: 'Crash ahead' }));
  });

  it('falls back to a plain page notification when no service worker is active', async () => {
    stubNotifications('granted', { getRegistration: () => Promise.resolve(undefined) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await vi.waitFor(() => expect(NotificationMock).toHaveBeenCalledWith('Serious road alert', { body: 'Crash ahead' }));
  });

  it('does nothing without notification permission', async () => {
    const worker = fakeWorker({ shown: true });
    stubNotifications('default', { getRegistration: () => Promise.resolve({ active: worker }) });
    showAlertNotification('Serious road alert', 'Crash ahead', sketch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(NotificationMock).not.toHaveBeenCalled();
  });
});
