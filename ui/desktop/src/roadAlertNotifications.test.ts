import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHIME_DURATION_MS, CHIME_RINGS, isPushCapable, playAlertChime, showAlertNotification } from './roadAlertNotifications';

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

describe('playAlertChime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // A fake Web Audio context that records when each tone starts and stops.
  function stubAudio() {
    const starts: number[] = [];
    const stops: number[] = [];
    let closed = 0;
    const param = { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, value: 0 };
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createOscillator() {
        return {
          type: 'sine',
          frequency: { value: 0 },
          connect: () => {},
          start: (t: number) => starts.push(t),
          stop: (t: number) => stops.push(t),
        };
      }
      createGain() {
        return { gain: param, connect: () => {} };
      }
      close() {
        closed += 1;
        return Promise.resolve();
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    return { starts, stops, closed: () => closed };
  }

  it('rings the two-tone chime exactly 3 times, then stops', () => {
    vi.useFakeTimers();
    const audio = stubAudio();
    playAlertChime();
    expect(CHIME_RINGS).toBe(3);
    expect(audio.starts).toHaveLength(6); // 3 rings x 2 tones
    const ringStarts = audio.starts.filter((_, i) => i % 2 === 0);
    expect(ringStarts[1] - ringStarts[0]).toBeCloseTo(ringStarts[2] - ringStarts[1]);
    // Every tone has finished by the time callers start speaking.
    expect(Math.max(...audio.stops) * 1000).toBeLessThanOrEqual(CHIME_DURATION_MS);
    expect(audio.closed()).toBe(0);
    vi.advanceTimersByTime(CHIME_DURATION_MS + 500);
    expect(audio.closed()).toBe(1);
  });
});
