const { getRoadSignals, filterByBbox, sortByFreshness } = require('./roadSignals');
const { findNextCrossStreet } = require('./nextCrossStreet');
const { getRoadReroute } = require('./roadReroute');
const {
  registerAccount,
  checkAccess: checkRoadAlertsAccess,
  updateDigestOptIn,
  updateUsername,
  updateRoutineDensity,
  markNotificationsViewed,
} = require('./roadAlertsAccounts');
const { insertSurfacedAlert } = require('./roadAlertsSurfacedLog');
const { findTopic, findOrCreateTopic } = require('./roadAlertsTopics');
const { resolveTlid } = require('./roadAlertsTopicAnchor');
const { getStatement, insertStatement, getStatementsForTopic, getUnseenReplyCount } = require('./roadAlertsStatements');
const {
  addTestWeightedPoint,
  getTestWeightedPoints,
  clearTestWeightedPoints,
  deleteTestWeightedPoint,
} = require('./testWeightedPoints');
const {
  recordWeightedPointPing,
  getWeightedPoints,
  getAllWeightedPointCandidates,
  ROUTINE_DENSITY_TIERS,
  resolveRoutineDensityTier,
} = require('./weightedPoints');
const { addTestRoadSignal, getTestRoadSignals, clearTestRoadSignals, deleteTestRoadSignal } = require('./testRoadSignals');
const { getDriveRoute } = require('./testDriveRoute');
const { sendRoadAlertsWelcomeEmail, sendRoadAlertEmail } = require('./emailDelivery');
const { ValidationError, NotFoundError, OutOfRangeError, UnauthorizedError, UpstreamError } = require('./errors');
const { isPushConfigured, getVapidPublicKey } = require('./pushKeys');
const { saveSubscription, upsertLivePosition, deleteLivePosition, clearPushSentForAccount } = require('./roadAlertsPush');
const { EMAIL_PATTERN, allowsTestWeightedPoints, allowsTestRoadSignals } = require('./serverSetup');

// Road Alerts' routes: accounts/preferences, live hazards (/road-signals),
// cross-street/reroute, push, comments, weighted points, and the
// test-only tooling. Served by roadAlertsServer.js on its own in
// production (and by server.js alongside geocodingRoutes.js everywhere
// else) -- see serverSetup.js. Uses its own Road Alerts accounts
// (roadAlertsAccounts.js), never the geocoding product's quota accounts.

/**
 * The weighted points (routine streets) a Road Alerts route should
 * prefer for this account -- see routePreference.js. Real, qualified
 * points always; developer-seeded test points too when
 * ALLOW_TEST_WEIGHTED_POINTS is set, so the preference can be exercised
 * from the sandbox. Best-effort: a failure here just means no preference,
 * never a failed route.
 */
async function loadRouteWeightedPoints(usersDb, email) {
  const points = [];
  try {
    points.push(...(await getWeightedPoints(usersDb, email)));
  } catch (err) {
    console.error('Failed to load weighted points for routing:', err);
  }
  if (allowsTestWeightedPoints()) {
    try {
      points.push(...(await getTestWeightedPoints(usersDb, email)));
    } catch (err) {
      console.error('Failed to load test weighted points for routing:', err);
    }
  }
  return points.map((p) => ({ latitude: p.latitude, longitude: p.longitude, weight: p.weight }));
}

/** Registers every Road Alerts route on `app`. `db` is the read-only geocoding pool (streets/topology). */
function registerRoadAlertsRoutes(app, { db, usersDbPromise }) {
  // Registers (or re-registers) a Road Alerts account -- email only, no
  // password, matching this app's existing loose account model (see
  // roadAlertsAccounts.js). Idempotent: an already-registered email gets
  // its existing service key back unchanged, re-emailed -- this is
  // deliberately this feature's only "forgot my key" recovery path, since
  // there's no separate recovery flow anywhere in this app. Free for every
  // registered account right now, no trial clock -- see
  // roadAlertsAccounts.js's registerAccount for why.
  app.post('/road-alerts/register', async (req, res) => {
    const { email } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      const usersDb = await usersDbPromise;
      const account = await registerAccount(usersDb, email);

      const emailResult = await sendRoadAlertsWelcomeEmail(email, {
        serviceKey: account.service_key,
        alreadyRegistered: !account.created,
      });

      res.json({
        email: account.email,
        serviceKey: account.service_key,
        registeredAt: account.registered_at,
        alreadyRegistered: !account.created,
        serviceKeyEmailed: emailResult.delivered,
        digestOptIn: account.digest_opt_in,
      });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Reads/writes an account's opt-in flag for the daily email digest (see
  // roadAlertsDigest.js) -- separate from /road-alerts/register since the
  // app loads a stored account straight from device storage on launch
  // (see roadAlertsStorage.ts), with no other way to learn the current
  // server-side value after a restart. GET only returns what
  // checkRoadAlertsAccess already fetched; POST updates it. Default is
  // false for every account -- the digest is opt-in, never automatic.
  app.get('/road-alerts/preferences', async (req, res) => {
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

      res.json({ digestOptIn: account.digest_opt_in, routineDensity: account.routine_density });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // digestOptIn and routineDensity are independent settings sharing one
  // endpoint (same reasoning as their shared GET above) -- each is only
  // validated/updated when present in the body, so a caller changing one
  // never has to also resend the other's current value.
  app.post('/road-alerts/preferences', async (req, res) => {
    const { email, serviceKey, digestOptIn, routineDensity } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      if (digestOptIn === undefined && routineDensity === undefined) {
        throw new ValidationError('must include digestOptIn and/or routineDensity');
      }
      if (digestOptIn !== undefined && typeof digestOptIn !== 'boolean') {
        throw new ValidationError('digestOptIn must be a boolean');
      }
      if (routineDensity !== undefined && !Object.prototype.hasOwnProperty.call(ROUTINE_DENSITY_TIERS, routineDensity)) {
        throw new ValidationError(`routineDensity must be one of: ${Object.keys(ROUTINE_DENSITY_TIERS).join(', ')}`);
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);
      let account;
      if (digestOptIn !== undefined) {
        account = await updateDigestOptIn(usersDb, email, digestOptIn);
      }
      if (routineDensity !== undefined) {
        account = await updateRoutineDensity(usersDb, email, routineDensity);
      }

      res.json({ digestOptIn: account.digest_opt_in, routineDensity: account.routine_density });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // A display name shown alongside anything an account posts (see
  // roadAlertsStatements.js) -- kept separate from /road-alerts/register
  // (that route's contract is specifically email-only account creation/
  // key-recovery, already asserted by its own tests) and from
  // /road-alerts/preferences (specifically the digest boolean). Same
  // reasoning as preferences for being its own GET/POST pair: a stored
  // account on-device carries no profile data of its own (see
  // roadAlertsStorage.ts), so the current value is always fetched fresh.
  app.get('/road-alerts/username', async (req, res) => {
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

      res.json({ username: account.username });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/road-alerts/username', async (req, res) => {
    const { email, serviceKey, username } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      const trimmedUsername = typeof username === 'string' ? username.trim() : '';
      if (!trimmedUsername || trimmedUsername.length > 40) {
        throw new ValidationError('username must be 1-40 characters');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);
      const account = await updateUsername(usersDb, email, trimmedUsername);

      res.json({ username: account.username });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // The topic (if any) anchored to a road location, and everything
  // posted to it -- see roadAlertsTopics.js for why a topic is anchored
  // to a persistent street segment (tlid) rather than to a volatile 511
  // signal.id. Read-only: uses findTopic, never findOrCreateTopic, so
  // merely viewing an alert never creates a topic nobody's actually
  // commented on. `db` (read-only, the `geocoding` streets database) is
  // used only to resolve the tlid; the topic/statement lookup itself
  // runs against `usersDb` (`geocoding_users`, writable).
  app.get('/road-alerts/topic', async (req, res) => {
    const { latitude, longitude, email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      const lat = Number(latitude);
      const lon = Number(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new ValidationError('latitude and longitude must be numbers');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const tlid = await resolveTlid(db, lat, lon);
      const topic = await findTopic(usersDb, { tlid, latitude: lat, longitude: lon });
      if (!topic) {
        return res.json({ topic: null, statements: [] });
      }

      const statements = await getStatementsForTopic(usersDb, topic.id);
      res.json({
        topic: {
          id: topic.id,
          tlid: topic.tlid,
          latitude: topic.latitude,
          longitude: topic.longitude,
          roadway: topic.roadway,
          createdAt: topic.created_at,
        },
        statements: statements.map((statement) => ({
          id: statement.id,
          username: statement.username,
          body: statement.body,
          createdAt: statement.created_at,
          replies: statement.replies.map((reply) => ({
            id: reply.id,
            username: reply.username,
            body: reply.body,
            createdAt: reply.created_at,
            replies: [],
          })),
        })),
      });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Posts a top-level statement on the topic anchored to a location (the
  // only write path that can create a topic -- see roadAlertsTopics.js),
  // or a reply to an existing statement when parentStatementId is given.
  // The one-level-cap enforcement itself lives in insertStatement
  // (roadAlertsStatements.js), not here -- this route only decides
  // whether a topic needs resolving/creating first.
  app.post('/road-alerts/statements', async (req, res) => {
    const { email, serviceKey, body, latitude, longitude, roadway, parentStatementId } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      const trimmedBody = typeof body === 'string' ? body.trim() : '';
      if (!trimmedBody || trimmedBody.length > 500) {
        throw new ValidationError('body must be 1-500 characters');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
      if (!account.username) {
        throw new ValidationError('set a display name before posting a comment');
      }

      let topicId;
      if (parentStatementId != null) {
        // A reply's topic comes from its parent, never from the client --
        // latitude/longitude are ignored here, so a reply always lands on
        // the same topic as the statement it's replying to.
        const parent = await getStatement(usersDb, parentStatementId);
        if (!parent) {
          throw new NotFoundError(`no statement found with id ${parentStatementId}`);
        }
        topicId = parent.topic_id;
      } else {
        const lat = Number(latitude);
        const lon = Number(longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new ValidationError('latitude and longitude must be numbers for a new statement');
        }
        const tlid = await resolveTlid(db, lat, lon);
        const topic = await findOrCreateTopic(usersDb, {
          tlid,
          latitude: lat,
          longitude: lon,
          roadway: typeof roadway === 'string' ? roadway : null,
        });
        topicId = topic.id;
      }

      const statement = await insertStatement(usersDb, {
        topicId,
        parentStatementId: parentStatementId ?? null,
        email: account.email,
        username: account.username,
        body: trimmedBody,
      });

      res.json({
        statement: {
          id: statement.id,
          topicId: statement.topic_id,
          parentStatementId: statement.parent_statement_id,
          username: statement.username,
          body: statement.body,
          createdAt: statement.created_at,
        },
        topicId,
      });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // How many replies to this account's own statements are unseen -- see
  // roadAlertsStatements.js's getUnseenReplyCount for the "only counts a
  // reply from someone else, never a self-reply" rule. This is
  // deliberately scoped to replies only, not a general "new alerts" count
  // -- see AGENTS.md's Road Alerts section for why: that would need
  // tracking every alert *surfaced* to a user (a passive-exposure event),
  // which cuts against this project's explicit-action-only logging
  // principle for Road Alerts, established while building the digest
  // feature.
  app.get('/road-alerts/notifications', async (req, res) => {
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const sinceDate = account.notifications_viewed_at ?? account.registered_at;
      const replyCount = await getUnseenReplyCount(usersDb, email, sinceDate);

      res.json({ replyCount });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Resets the reply count above to 0 -- called when the driver actually
  // opens/expands their notifications, not on every poll.
  app.post('/road-alerts/notifications/viewed', async (req, res) => {
    const { email, serviceKey } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);
      const account = await markNotificationsViewed(usersDb, email);

      res.json({ viewedAt: account.notifications_viewed_at });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Live traffic-hazard incidents near a point, sourced from New England 511
  // (Maine/NH/Vermont DOTs -- see roadSignals.js and docs/ROAD_ALERTS_DESIGN.md).
  // GET, not POST, since it's polled repeatedly with no free-text body to
  // send, same convention as GET /quota. Requires a registered Road Alerts
  // account (email+serviceKey, see roadAlertsAccounts.js) -- checked before
  // the upstream 511 fetch, so a bad request never burns an upstream call.
  app.get('/road-signals', async (req, res) => {
    const { latitude, longitude, radiusMeters, email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const parsedLatitude = latitude !== undefined ? Number(latitude) : undefined;
      const parsedLongitude = longitude !== undefined ? Number(longitude) : undefined;
      const parsedRadiusMeters = radiusMeters !== undefined ? Number(radiusMeters) : 8000;

      // Test-only fake hazards (see testRoadSignals.js) merged in alongside
      // the real live ones -- off by default (allowsTestRoadSignals()).
      // Caught separately from the real fetch below: if 511 itself is down,
      // a developer testing against their own seeded hazard shouldn't also
      // lose that because of an unrelated upstream outage.
      let testSignals = [];
      if (allowsTestRoadSignals()) {
        try {
          const allTestSignals = await getTestRoadSignals(usersDb, email);
          testSignals =
            parsedLatitude !== undefined && parsedLongitude !== undefined
              ? filterByBbox(allTestSignals, parsedLatitude, parsedLongitude, parsedRadiusMeters)
              : allTestSignals;
        } catch (err) {
          console.error('Failed to load test road signals:', err);
        }
      }

      let result;
      try {
        result = await getRoadSignals({
          latitude: parsedLatitude,
          longitude: parsedLongitude,
          radiusMeters: parsedRadiusMeters,
        });
      } catch (err) {
        if (testSignals.length === 0) throw err;
        result = { signals: [], networks: [], partial: true, failedNetworks: [], generatedAt: new Date().toISOString() };
      }

      if (testSignals.length > 0) {
        result = { ...result, signals: sortByFreshness([...result.signals, ...testSignals]) };
      }

      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      if (err instanceof UpstreamError) return res.status(502).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // "Which street should I turn onto to get off this road before reaching
  // the hazard ahead" -- a proximity approximation using the existing
  // `streets` table (see nextCrossStreet.js), not real routing. On-demand
  // only (the mobile client calls this once per alert the driver taps,
  // never auto-polled) -- gated by the same registered-account check as
  // /road-signals since it's part of the same product. The hazard's own
  // latitude/longitude/roadway are passed in by the client from the
  // RoadSignal it already has; this route never re-fetches 511 itself.
  app.get('/road-signals/cross-street', async (req, res) => {
    const { driverLatitude, driverLongitude, hazardLatitude, hazardLongitude, hazardRoadway, email, serviceKey } =
      req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const result = await findNextCrossStreet(db, {
        driverLatitude: driverLatitude !== undefined ? Number(driverLatitude) : undefined,
        driverLongitude: driverLongitude !== undefined ? Number(driverLongitude) : undefined,
        hazardLatitude: hazardLatitude !== undefined ? Number(hazardLatitude) : undefined,
        hazardLongitude: hazardLongitude !== undefined ? Number(hazardLongitude) : undefined,
        hazardRoadway: typeof hazardRoadway === 'string' ? hazardRoadway : null,
      });

      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // 1-2 alternate driving routes past the hazard, avoiding a buffer around
  // it -- see roadReroute.js for the rejoin-point estimate and the
  // pgRouting/pgr_ksp query against our own `streets`-derived topology
  // (streets_topology_nodes/streets_routing_edges, built by
  // routing_topology.py) -- no external routing service. Same
  // client-resends-the-hazard's-own-coordinates reasoning as
  // /road-signals/cross-street above.
  app.get('/road-signals/reroute', async (req, res) => {
    const {
      driverLatitude,
      driverLongitude,
      driverHeading,
      hazardLatitude,
      hazardLongitude,
      destinationLatitude,
      destinationLongitude,
      email,
      serviceKey,
    } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const result = await getRoadReroute(db, {
        weightedPoints: await loadRouteWeightedPoints(usersDb, email),
        driverLatitude: driverLatitude !== undefined ? Number(driverLatitude) : undefined,
        driverLongitude: driverLongitude !== undefined ? Number(driverLongitude) : undefined,
        driverHeading: driverHeading !== undefined ? Number(driverHeading) : undefined,
        hazardLatitude: hazardLatitude !== undefined ? Number(hazardLatitude) : undefined,
        hazardLongitude: hazardLongitude !== undefined ? Number(hazardLongitude) : undefined,
        destinationLatitude: destinationLatitude !== undefined ? Number(destinationLatitude) : undefined,
        destinationLongitude: destinationLongitude !== undefined ? Number(destinationLongitude) : undefined,
      });

      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Unauthenticated on purpose -- a VAPID public key is not a secret (it's
  // sent to the browser's push service on every subscribe by design), and
  // exposing it this way means the frontend doesn't need a rebuild if the
  // key is ever rotated.
  app.get('/road-signals/push-public-key', (req, res) => {
    if (!isPushConfigured()) {
      return res.status(404).json({ error: 'push notifications are not configured on this server' });
    }
    res.json({ publicKey: getVapidPublicKey() });
  });

  // Stores a browser's Web Push subscription against its Road Alerts
  // account -- see docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
  // Same account-auth gate as every other Road Alerts account-scoped
  // endpoint (checkRoadAlertsAccess).
  app.post('/road-signals/push-subscribe', async (req, res) => {
    const { email, serviceKey, subscription } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      if (
        !subscription ||
        typeof subscription.endpoint !== 'string' ||
        !subscription.keys ||
        typeof subscription.keys.p256dh !== 'string' ||
        typeof subscription.keys.auth !== 'string'
      ) {
        throw new ValidationError('subscription must include endpoint and keys.p256dh/keys.auth');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
      await saveSubscription(usersDb, account.id, {
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      });
      res.json({ subscribed: true });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Ephemeral -- see the spec's Privacy model section. One row per
  // account, always overwritten, never a history table.
  app.post('/road-signals/live-position', async (req, res) => {
    const { email, serviceKey, latitude, longitude, heading } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      if (typeof latitude !== 'number' || Number.isNaN(latitude)) {
        throw new ValidationError('latitude must be a number');
      }
      if (typeof longitude !== 'number' || Number.isNaN(longitude)) {
        throw new ValidationError('longitude must be a number');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
      await upsertLivePosition(usersDb, account.id, {
        latitude,
        longitude,
        heading: typeof heading === 'number' && !Number.isNaN(heading) ? heading : null,
      });
      res.json({ updated: true });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Called on Stop -- removes the row immediately rather than waiting for
  // the worker's 10-minute staleness timeout, and clears this account's
  // push-dedup history so the same hazard can alert again on a later trip.
  app.delete('/road-signals/live-position', async (req, res) => {
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
      await deleteLivePosition(usersDb, account.id);
      await clearPushSentForAccount(usersDb, account.id);
      res.json({ deleted: true });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Emails one road alert to the account's own registered email, on
  // request -- the "save this" voice command in RoadAlertsForm.tsx, or any
  // other on-demand save. The `signal` is passed in by the client from the
  // RoadSignal it already has (same reasoning as /road-signals/cross-street
  // just above: this route never re-fetches 511 itself). Always sends to
  // the authenticated account's own email (from checkRoadAlertsAccess, tied
  // to the email+serviceKey pair) -- never an arbitrary address the client
  // names, so there's no open-relay/spam surface here beyond a user
  // emailing themselves.
  app.post('/road-alerts/email-alert', async (req, res) => {
    const { email, serviceKey, signal } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }
      if (!signal || typeof signal !== 'object' || typeof signal.id !== 'string') {
        throw new ValidationError('signal must be a road signal object with an id');
      }
      if (!signal.speech || typeof signal.speech.deep !== 'string') {
        throw new ValidationError('signal.speech.deep must be a string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const emailResult = await sendRoadAlertEmail(email, signal);

      // Logging into the digest is purely additive to the immediate send
      // above, and only for accounts opted in -- see roadAlertsSurfacedLog.js.
      // A logging failure shouldn't fail a request the user is already
      // mid-voice-command for, so it's caught and reported here rather than
      // thrown.
      if (account.digest_opt_in) {
        try {
          await insertSurfacedAlert(usersDb, email, signal);
        } catch (logErr) {
          console.error('failed to log surfaced alert for digest:', logErr);
        }
      }

      res.json({ emailed: emailResult.delivered, stubbed: Boolean(emailResult.stubbed) });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Test-only fake weighted points (see testWeightedPoints.js) -- off by
  // default (allowsTestWeightedPoints(), checked first so a disabled
  // deployment never even touches the database for these). Gated by the
  // same registered-account check as /road-signals otherwise. Lets a real
  // device's live GPS and real 511 data be run through
  // roadAlertsMatching.js's "hazard between the user and a routine point"
  // logic without needing the on-device trip-learning system that would
  // eventually produce real weighted points -- never a substitute for that
  // real, on-device-only data.
  app.post('/road-alerts/test/weighted-points', async (req, res) => {
    if (!allowsTestWeightedPoints()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey, latitude, longitude, weight, tlid, label } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const point = await addTestWeightedPoint(usersDb, email, {
        latitude: typeof latitude === 'number' ? latitude : Number(latitude),
        longitude: typeof longitude === 'number' ? longitude : Number(longitude),
        weight: typeof weight === 'number' ? weight : Number(weight),
        tlid: typeof tlid === 'string' ? tlid : null,
        label: typeof label === 'string' ? label : null,
      });

      res.json(point);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/road-alerts/test/weighted-points', async (req, res) => {
    if (!allowsTestWeightedPoints()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const weightedPoints = await getTestWeightedPoints(usersDb, email);
      res.json({ weightedPoints });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.delete('/road-alerts/test/weighted-points', async (req, res) => {
    if (!allowsTestWeightedPoints()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const deleted = await clearTestWeightedPoints(usersDb, email);
      res.json({ deleted });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Real weighted points (see weightedPoints.js) -- unlike the /test/
  // routes above, always on for any registered Road Alerts account, no
  // env-var gate. The mobile app calls this periodically with its current
  // position while a monitoring session is active, *except* for the
  // session's first and last ping (its trip endpoints) -- see
  // weightedPoints.js's own doc comment for why those are excluded rather
  // than just weighted low.
  app.post('/road-alerts/weighted-points', async (req, res) => {
    const { email, serviceKey, latitude, longitude, tlid, isEndpoint } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const point = await recordWeightedPointPing(usersDb, email, {
        latitude: typeof latitude === 'number' ? latitude : Number(latitude),
        longitude: typeof longitude === 'number' ? longitude : Number(longitude),
        tlid: typeof tlid === 'string' ? tlid : null,
        isEndpoint: Boolean(isEndpoint),
        routineDensity: account.routine_density,
      });

      res.json({ point });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/road-alerts/weighted-points', async (req, res) => {
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const weightedPoints = await getWeightedPoints(usersDb, email);
      res.json({ weightedPoints });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Debug/test-tooling counterpart to GET /road-alerts/weighted-points above
  // (see getAllWeightedPointCandidates's own doc comment) -- the Road Alert
  // Test page uses this one so a low- or no-qualified-point account is
  // still visible enough to evaluate the qualification logic against.
  // Never consumed by the real driving pages, which rely on the other
  // route's qualified-only contract for actual alerting.
  app.get('/road-alerts/weighted-points/candidates', async (req, res) => {
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      const account = await checkRoadAlertsAccess(usersDb, email, serviceKey);
      const { qualifyingWindowDays, minPingsToQualify } = resolveRoutineDensityTier(account.routine_density);

      const points = await getAllWeightedPointCandidates(usersDb, email);
      res.json({ routineDensity: account.routine_density, tier: { qualifyingWindowDays, minPingsToQualify }, points });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Test-only fake hazards (see testRoadSignals.js) -- off by default
  // (allowsTestRoadSignals(), checked first so a disabled deployment never
  // even touches the database for these). Gated by the same registered-
  // account check as /road-signals otherwise. Unlike a real 511 incident,
  // a row here never expires on its own -- lets a developer keep testing
  // the map/comments/reroute UI against a stable hazard for as long as
  // they want, across as many days as they want, without depending on a
  // real hazard staying live (or staying in range) that whole time.
  // Which developer test tools this server has switched on -- lets the
  // frontend show its Road Alerts sandbox tab only where the sandbox can
  // actually work (never on production, where both are off). Public and
  // unauthenticated on purpose: it only reveals two booleans, and the
  // sandbox tab needs to know before anyone has signed in.
  app.get('/road-alerts/test/enabled', (req, res) => {
    res.json({ testRoadSignals: allowsTestRoadSignals(), testWeightedPoints: allowsTestWeightedPoints() });
  });

  app.post('/road-alerts/test/signals', async (req, res) => {
    if (!allowsTestRoadSignals()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey, latitude, longitude, roadway, description, severity } = req.body || {};
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const row = await addTestRoadSignal(usersDb, email, {
        latitude: typeof latitude === 'number' ? latitude : Number(latitude),
        longitude: typeof longitude === 'number' ? longitude : Number(longitude),
        roadway: typeof roadway === 'string' ? roadway : null,
        description: typeof description === 'string' ? description : null,
        severity: typeof severity === 'string' ? severity : undefined,
      });

      res.json(row);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/road-alerts/test/signals', async (req, res) => {
    if (!allowsTestRoadSignals()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const signals = await getTestRoadSignals(usersDb, email);
      res.json({ signals });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.delete('/road-alerts/test/signals', async (req, res) => {
    if (!allowsTestRoadSignals()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const deleted = await clearTestRoadSignals(usersDb, email);
      res.json({ deleted });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Single-item deletes for the sandbox's per-row "Delete" buttons --
  // clear-all (the two DELETEs above) is still there for a fresh start.
  // Scoped to the authenticated account inside deleteTestRoadSignal/
  // deleteTestWeightedPoint, so a 404 here means "not yours or not there",
  // never a leak of whether another account's row exists.
  app.delete('/road-alerts/test/signals/:id', async (req, res) => {
    if (!allowsTestRoadSignals()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const deleted = await deleteTestRoadSignal(usersDb, email, req.params.id);
      if (!deleted) throw new NotFoundError('test hazard not found');
      res.json({ deleted: 1 });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.delete('/road-alerts/test/weighted-points/:id', async (req, res) => {
    if (!allowsTestWeightedPoints()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const deleted = await deleteTestWeightedPoint(usersDb, email, req.params.id);
      if (!deleted) throw new NotFoundError('test weighted point not found');
      res.json({ deleted: 1 });
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Street-following path for a simulated drive (see testDriveRoute.js) --
  // the sandbox geocodes the start/target addresses itself (plain
  // /geocode), then asks for the route between the two points here.
  // Gated by the same flag as the fake hazards it exists to drive past.
  // Read-only against `geocoding`, same as /road-signals/reroute.
  app.get('/road-alerts/test/drive-route', async (req, res) => {
    if (!allowsTestRoadSignals()) {
      return res.status(404).json({ error: 'not found' });
    }
    const { startLatitude, startLongitude, endLatitude, endLongitude, email, serviceKey } = req.query;
    try {
      if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
        throw new ValidationError('email must be a valid email address');
      }
      if (typeof serviceKey !== 'string' || !serviceKey.trim()) {
        throw new ValidationError('serviceKey must be a non-empty string');
      }

      const usersDb = await usersDbPromise;
      await checkRoadAlertsAccess(usersDb, email, serviceKey);

      const result = await getDriveRoute(db, {
        weightedPoints: await loadRouteWeightedPoints(usersDb, email),
        startLatitude: startLatitude !== undefined ? Number(startLatitude) : undefined,
        startLongitude: startLongitude !== undefined ? Number(startLongitude) : undefined,
        endLatitude: endLatitude !== undefined ? Number(endLatitude) : undefined,
        endLongitude: endLongitude !== undefined ? Number(endLongitude) : undefined,
      });

      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
      if (err instanceof OutOfRangeError) return res.status(422).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}

module.exports = { registerRoadAlertsRoutes };
