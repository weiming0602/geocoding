const Database = require('better-sqlite3');

/** Computes a WKT LINESTRING's bounding box, mirroring what the Python ingest computes. */
function bboxOf(wkt) {
  const coords = wkt
    .replace(/^LINESTRING\s*\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((pair) => pair.trim().split(/\s+/).map(Number));
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE streets (
      id INTEGER PRIMARY KEY,
      tlid TEXT,
      fullname TEXT,
      lfromadd TEXT,
      ltoadd TEXT,
      rfromadd TEXT,
      rtoadd TEXT,
      zipl TEXT,
      zipr TEXT,
      state TEXT,
      state_abbr TEXT,
      geometry TEXT,
      minx REAL,
      miny REAL,
      maxx REAL,
      maxy REAL
    );
  `);

  const insert = db.prepare(
    `INSERT INTO streets
       (id, tlid, fullname, lfromadd, ltoadd, rfromadd, rtoadd, zipl, zipr, state, state_abbr,
        geometry, minx, miny, maxx, maxy)
     VALUES (@id, @tlid, @fullname, @lfromadd, @ltoadd, @rfromadd, @rtoadd, @zipl, @zipr, @state,
             @state_abbr, @geometry, @minx, @miny, @maxx, @maxy)`
  );

  const rows = [
    {
      id: 12, tlid: '78056932', fullname: 'Pequawket Trl', lfromadd: '988', ltoadd: '998',
      rfromadd: '979', rtoadd: '991', zipl: '04091', zipr: '04091', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.778377 43.833902, -70.778425 43.834164, -70.778486 43.834454)',
    },
    {
      id: 1, tlid: '78060165', fullname: 'Sebago Rd', lfromadd: '', ltoadd: '',
      rfromadd: '', rtoadd: '', zipl: '04074', zipr: '04074', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.748418 43.876127, -70.750996 43.878619)',
    },
    // A second segment of the same named street/ZIP, covering a different
    // address sub-range (real streets are split into many such segments).
    {
      id: 14, tlid: '78012506', fullname: 'Pequawket Trl', lfromadd: '700', ltoadd: '738',
      rfromadd: '701', rtoadd: '721', zipl: '04091', zipr: '04091', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.79 43.83, -70.795 43.835)',
    },
    // Same fullname+zip as id=12/14 but in a different state, to test that
    // state disambiguates when everything else collides.
    {
      id: 99, tlid: '99999999', fullname: 'Pequawket Trl', lfromadd: '100', ltoadd: '198',
      rfromadd: '101', rtoadd: '199', zipl: '04091', zipr: '04091', state: 'New Hampshire', state_abbr: 'NH',
      geometry: 'LINESTRING (-71.0 43.9, -71.01 43.91)',
    },
    // A real-world shape (e.g. "Greely Rd" in the actual dataset): zipl and
    // zipr differ, since the street runs along a ZIP boundary.
    {
      id: 50, tlid: '50000000', fullname: 'Greely Rd', lfromadd: '201', ltoadd: '291',
      rfromadd: '200', rtoadd: '292', zipl: '04021', zipr: '04097', state: 'Maine', state_abbr: 'ME',
      geometry: 'LINESTRING (-70.2 43.9, -70.21 43.91)',
    },
  ];

  for (const row of rows) {
    const [minx, miny, maxx, maxy] = bboxOf(row.geometry);
    insert.run({ ...row, minx, miny, maxx, maxy });
  }

  return db;
}

module.exports = { makeDb };
