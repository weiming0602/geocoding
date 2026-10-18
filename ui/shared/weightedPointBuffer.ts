import type { Coordinates } from './api/types';
import { haversineDistanceMeters } from './geo';

/**
 * How far a ping must end up from BOTH the session's start location and
 * (retroactively) its eventual stop location to ever be sent as a
 * weighted-point ping -- see docs/ROAD_ALERTS_DESIGN.md's Privacy model.
 *
 * The original design excluded only the single literal first/last GPS fix
 * of a drive. In practice that under-protects: the street right outside
 * someone's home or workplace gets driven on nearly every trip, so a ping
 * taken a few minutes after Start (while still near where the drive began)
 * routinely qualified as "routine" within days -- recording exactly the
 * kind of identifying location the privacy model says it excludes. This
 * radius-based buffer replaces that single-fix exclusion on both ends.
 *
 * Wider than roadAlertsMatching.ts's 300m alert-matching corridor and
 * geocoding-server/src/weightedPoints.js's 150m point-merge radius --
 * large enough to cover a driveway/residential street/parking lot, small
 * enough not to suppress genuinely routine points on a longer road.
 */
export const WEIGHTED_POINT_EXCLUSION_RADIUS_METERS = 400;

type PendingPing = Coordinates;

/**
 * Buffers GPS pings for one Road Alerts drive so that none within
 * WEIGHTED_POINT_EXCLUSION_RADIUS_METERS of either the session's start or
 * its eventual stop is ever sent as a weighted-point ping:
 *
 * - A ping within the radius of the session's start is dropped immediately
 *   -- it's never queued at all.
 * - Every other ping is held in a pending queue rather than sent right
 *   away, since there's no way to know in advance it won't turn out to be
 *   near wherever the drive ends. `addPing` flushes (returns as sendable)
 *   any already-pending ping that the new position has moved more than
 *   the exclusion radius away from -- confirming the driver moved on from
 *   it, so it wasn't a stop.
 * - When the drive ends (`flushAtStop`), anything still pending gets one
 *   final check against the actual stop position: still within the
 *   exclusion radius of it gets dropped, anything farther away (a ping
 *   from earlier in the drive that just hadn't been confirmed yet) is
 *   returned as sendable. Call with no stop position (stop location
 *   unknown) to drop everything still pending.
 *
 * Nothing here is persisted -- same "lives only in memory for the current
 * session" precedent as RoadAlerts.tsx's own short GPS trail.
 */
export class WeightedPointPingBuffer {
  private readonly exclusionRadiusMeters: number;
  private startPosition: Coordinates | null = null;
  private pending: PendingPing[] = [];

  constructor(exclusionRadiusMeters: number = WEIGHTED_POINT_EXCLUSION_RADIUS_METERS) {
    this.exclusionRadiusMeters = exclusionRadiusMeters;
  }

  /** Adds a new position fix. Returns pings now confirmed sendable (moved on from), in the order they were queued. */
  addPing(position: Coordinates): PendingPing[] {
    if (this.startPosition === null) {
      this.startPosition = position;
      return [];
    }

    const toSend: PendingPing[] = [];
    const stillPending: PendingPing[] = [];
    for (const candidate of this.pending) {
      if (haversineDistanceMeters(candidate, position) > this.exclusionRadiusMeters) {
        toSend.push(candidate);
      } else {
        stillPending.push(candidate);
      }
    }
    this.pending = stillPending;

    if (haversineDistanceMeters(this.startPosition, position) > this.exclusionRadiusMeters) {
      this.pending.push(position);
    }

    return toSend;
  }

  /**
   * Call when the drive ends. With a known stop position, does one final
   * flush against it (anything still farther than the exclusion radius
   * from where the drive actually ended is returned as sendable) before
   * dropping the rest; with no stop position, drops everything pending.
   * Resets the buffer either way, ready for a future session.
   */
  flushAtStop(stopPosition?: Coordinates): PendingPing[] {
    const toSend = stopPosition
      ? this.pending.filter((candidate) => haversineDistanceMeters(candidate, stopPosition) > this.exclusionRadiusMeters)
      : [];
    this.startPosition = null;
    this.pending = [];
    return toSend;
  }
}
