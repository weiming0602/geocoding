import { describe, expect, it } from 'vitest';

import { ApiError } from '../../shared/api/client';
import { rerouteErrorMessage } from './rerouteErrorMessage';

describe('rerouteErrorMessage', () => {
  it('explains an out-of-range hazard with its distance and the 5 km limit', () => {
    expect(rerouteErrorMessage(new ApiError('hazard is 16120m away', 422), 16120)).toBe(
      "This hazard is 16.1 km away -- detours are offered once you're within 15 km of it. Try again as you get closer."
    );
  });

  it('says no route was found for a 404', () => {
    expect(rerouteErrorMessage(new ApiError('no route found around this hazard', 404), 1200)).toBe(
      'No way around this hazard was found from where you are.'
    );
  });

  it('explains when there is no mapped street past the hazard to rejoin', () => {
    expect(rerouteErrorMessage(new ApiError('no routable street data past this hazard to rejoin', 404), 3000)).toBe(
      "Couldn't plan a detour here: there's no mapped street past this hazard in your direction of travel to rejoin."
    );
  });

  it('explains when the driver is not near a mapped street', () => {
    expect(rerouteErrorMessage(new ApiError('no routable street data near this location yet', 404), 3000)).toMatch(
      /you don't seem to be near a mapped street/
    );
  });

  it('falls back to a generic retry message for anything else', () => {
    expect(rerouteErrorMessage(new ApiError('internal error', 500), 1200)).toBe(
      'Could not find a detour right now -- try again.'
    );
    expect(rerouteErrorMessage(new TypeError('Failed to fetch'), null)).toBe(
      'Could not find a detour right now -- try again.'
    );
  });
});
