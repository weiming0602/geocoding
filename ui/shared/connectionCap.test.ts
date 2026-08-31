import { describe, expect, test } from 'vitest';

import { DEFAULT_MAP_MARKER_CAP, capFromConnectionInfo } from './connectionCap';

describe('capFromConnectionInfo', () => {
  test('falls back to the default when no connection info is available', () => {
    expect(capFromConnectionInfo(undefined)).toBe(DEFAULT_MAP_MARKER_CAP);
    expect(capFromConnectionInfo(null)).toBe(DEFAULT_MAP_MARKER_CAP);
    expect(capFromConnectionInfo({})).toBe(DEFAULT_MAP_MARKER_CAP);
  });

  test('caps slow connections down to 250', () => {
    expect(capFromConnectionInfo({ effectiveType: 'slow-2g' })).toBe(250);
    expect(capFromConnectionInfo({ effectiveType: '2g' })).toBe(250);
  });

  test('caps 3g to 500', () => {
    expect(capFromConnectionInfo({ effectiveType: '3g' })).toBe(500);
    // downlink is ignored once effectiveType says 3g -- it's the browser's
    // own bucketed judgment call, trusted over a raw bandwidth number.
    expect(capFromConnectionInfo({ effectiveType: '3g', downlink: 20 })).toBe(500);
  });

  test('caps 4g to 750, unless downlink says otherwise', () => {
    expect(capFromConnectionInfo({ effectiveType: '4g' })).toBe(750);
    expect(capFromConnectionInfo({ effectiveType: '4g', downlink: 10 })).toBe(750);
    expect(capFromConnectionInfo({ effectiveType: '4g', downlink: 4.9 })).toBe(500);
  });

  test('falls back to downlink alone when effectiveType is missing/unrecognized', () => {
    expect(capFromConnectionInfo({ downlink: 1 })).toBe(250);
    expect(capFromConnectionInfo({ downlink: 3 })).toBe(500);
    expect(capFromConnectionInfo({ downlink: 8 })).toBe(750);
    expect(capFromConnectionInfo({ effectiveType: 'bluetooth', downlink: 8 })).toBe(750);
  });
});
