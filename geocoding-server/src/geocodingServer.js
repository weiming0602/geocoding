require('dotenv').config();

const { createDatabases, createBaseApp, startServer } = require('./serverSetup');
const { registerGeocodingRoutes } = require('./geocodingRoutes');

// Geocoding routes only (see geocodingRoutes.js) -- the production
// counterpart to roadAlertsServer.js; server.js serves both together.
// Same port (PORT, default 3001) and env vars as server.js, so switching
// a deployed ops/geocoding-server.service to this file is a one-line
// ExecStart change once nginx routes Road Alerts paths elsewhere (see
// ops/nginx-api.conf.example).
const { db, usersDbPromise } = createDatabases();
const app = createBaseApp({ logRequests: require.main === module });
registerGeocodingRoutes(app, { db, usersDbPromise });

if (require.main === module) {
  startServer(app, { name: 'geocoding-server (geocoding routes only)', port: Number(process.env.PORT) || 3001, servesBilling: true });
}

module.exports = { app, db, usersDbPromise };
