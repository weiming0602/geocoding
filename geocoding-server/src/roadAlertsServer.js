require('dotenv').config();

const { createDatabases, createBaseApp, startServer } = require('./serverSetup');
const { registerRoadAlertsRoutes } = require('./roadAlertsRoutes');

// Road Alerts routes only (see roadAlertsRoutes.js), as its own process
// next to geocodingServer.js on the same droplet -- nginx sends
// /road-alerts/* and /road-signals* here (ops/nginx-api.conf.example),
// run via ops/road-alerts-server.service. ROAD_ALERTS_PORT rather than
// PORT, so a shared .env's PORT (meant for the geocoding process) can't
// make both processes fight over the same port.
const { db, usersDbPromise } = createDatabases();
const app = createBaseApp({ logRequests: require.main === module });
registerRoadAlertsRoutes(app, { db, usersDbPromise });

if (require.main === module) {
  startServer(app, { name: 'road-alerts-server', port: Number(process.env.ROAD_ALERTS_PORT) || 3002 });
}

module.exports = { app, db, usersDbPromise };
