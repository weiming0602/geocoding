require('dotenv').config();

const { createDatabases, createBaseApp, startServer } = require('./serverSetup');
const { registerGeocodingRoutes } = require('./geocodingRoutes');
const { registerRoadAlertsRoutes } = require('./roadAlertsRoutes');

// Every route in one process: local dev (`node src/server.js`), the test
// suite (test/helpers.js's withTestServer), and any deployment that
// hasn't switched to the split pair yet. Production can instead run
// geocodingServer.js and roadAlertsServer.js as two processes on the
// same box, so a Road Alerts crash/restart/deploy can't take down the
// paid geocoding API -- see ops/road-alerts-server.service.
const { db, usersDbPromise } = createDatabases();
const app = createBaseApp({ logRequests: require.main === module });
registerGeocodingRoutes(app, { db, usersDbPromise });
registerRoadAlertsRoutes(app, { db, usersDbPromise });

if (require.main === module) {
  startServer(app, { name: 'geocoding-server', port: Number(process.env.PORT) || 3001 });
}

module.exports = { app, db, usersDbPromise };
