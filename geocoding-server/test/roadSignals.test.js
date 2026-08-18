const test = require('node:test');
const assert = require('node:assert/strict');

const {
  asArray,
  parseIncidentsXml,
  extractIncidents,
  normalizeIncident,
  mapSeverity,
  buildSpeech,
  formatLaneDetail,
  formatWeightRestriction,
  filterByBbox,
} = require('../src/roadSignals');

function incidentXml(inner) {
  return `<incident>${inner}</incident>`;
}

// Shaped after a real incident sampled live from New England 511 (see the
// "Manual curl check against live 511 API" step) -- lat/lon as integer
// microdegrees and affectedLanesDetail/weight as structured/numeric
// fields, not the plain strings an unverified guess might have used.
const SAMPLE_INCIDENT_INNER = `
  <startLocation>
    <state>ME</state>
    <county>Penobscot</county>
    <city>Old Town</city>
    <roadway>Stillwater Avenue</roadway>
    <direction>Northbound</direction>
    <crossstreet>Main St</crossstreet>
    <mileMarker>12</mileMarker>
    <lat>44933300</lat>
    <lon>-68646100</lon>
  </startLocation>
  <desc>Bridge posted to 30 Ton</desc>
  <status>Active</status>
  <severity>Low</severity>
  <eventType>Weight Restriction</eventType>
  <affectedLanes />
  <affectedLanesDetail>
    <laneDetails type="MainLane" status="Cleared" index="0" />
    <laneDetails type="Divider" status="Cleared" index="1" />
  </affectedLanesDetail>
  <roadRestrictions><weight>60000</weight></roadRestrictions>
  <verifiedBy>MaineDOT</verifiedBy>
  <createdTimestamp>2026-08-11T07:20:41</createdTimestamp>
  <lastUpdatedTimestamp>2026-08-11T08:00:00</lastUpdatedTimestamp>
`;

function statusXml(nets) {
  return `<status xmlns="http://its.gov/c2c_icd"><incidentData>${nets}</incidentData></status>`;
}

test('asArray wraps a bare value, passes through arrays, and empties null/undefined', () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray([{ a: 1 }, { a: 2 }]), [{ a: 1 }, { a: 2 }]);
});

test('extractIncidents flattens a single <net>/<incident> (collapsed to bare objects by the parser)', () => {
  const xml = statusXml(`<net>${incidentXml(SAMPLE_INCIDENT_INNER)}</net>`);
  const parsed = parseIncidentsXml(xml);
  const incidents = extractIncidents(parsed, 'Maine');
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].network, 'Maine');
  assert.equal(incidents[0].raw.desc, 'Bridge posted to 30 Ton');
});

test('extractIncidents flattens multiple <net> and multiple <incident> elements', () => {
  const netA = `<net>${incidentXml(SAMPLE_INCIDENT_INNER)}${incidentXml(SAMPLE_INCIDENT_INNER)}</net>`;
  const netB = `<net>${incidentXml(SAMPLE_INCIDENT_INNER)}</net>`;
  const parsed = parseIncidentsXml(statusXml(netA + netB));
  const incidents = extractIncidents(parsed, 'Maine');
  assert.equal(incidents.length, 3);
});

test('extractIncidents returns an empty array when there are no incidents at all', () => {
  const parsed = parseIncidentsXml(statusXml('<net></net>'));
  assert.deepEqual(extractIncidents(parsed, 'Maine'), []);
});

test('normalizeIncident maps every documented XML field to the flat normalized shape', () => {
  const parsed = parseIncidentsXml(statusXml(`<net>${incidentXml(SAMPLE_INCIDENT_INNER)}</net>`));
  const [{ raw }] = extractIncidents(parsed, 'Maine');
  const normalized = normalizeIncident(raw, 'Maine');

  assert.equal(normalized.type, 'traffic_hazard');
  assert.equal(normalized.source, 'New England 511');
  assert.equal(normalized.network, 'Maine');
  assert.equal(normalized.roadway, 'Stillwater Avenue');
  assert.equal(normalized.direction, 'Northbound');
  assert.equal(normalized.crossStreet, 'Main St');
  assert.equal(normalized.mileMarker, 12);
  assert.equal(normalized.county, 'Penobscot');
  assert.equal(normalized.city, 'Old Town');
  assert.equal(normalized.latitude, 44.9333);
  assert.equal(normalized.longitude, -68.6461);
  assert.equal(normalized.affectedLanes, null); // self-closing <affectedLanes /> in the real data
  assert.equal(normalized.affectedLanesDetail, 'MainLane cleared, Divider cleared');
  assert.equal(normalized.weightRestriction, '60000 lbs');
  assert.equal(normalized.description, 'Bridge posted to 30 Ton');
  assert.equal(normalized.verifiedBy, 'MaineDOT');
  assert.equal(normalized.lastUpdatedAt, '2026-08-11T08:00:00');
  assert.equal(normalized.raw511Severity, 'Low');
  assert.equal(normalized.raw511EventType, 'Weight Restriction');
  assert.match(normalized.id, /^[0-9a-f]{16}$/);
});

test('normalizeIncident falls back to a stable hash id when no id attribute is present', () => {
  const parsed = parseIncidentsXml(statusXml(`<net>${incidentXml(SAMPLE_INCIDENT_INNER)}</net>`));
  const [{ raw }] = extractIncidents(parsed, 'Maine');
  const first = normalizeIncident(raw, 'Maine');
  const second = normalizeIncident(raw, 'Maine');
  assert.equal(first.id, second.id);
});

// raw511Severity values below (Low/Moderate/High/Severe) match what was
// actually observed live-sampling all 3 New England 511 networks (see the
// "Manual curl check against live 511 API" step), not guessed enum values.

test('mapSeverity maps a Severe or High raw511Severity to serious', () => {
  assert.equal(
    mapSeverity({ raw511Severity: 'Severe', raw511EventType: 'Construction', description: '' }),
    'serious'
  );
  assert.equal(
    mapSeverity({ raw511Severity: 'High', raw511EventType: 'Other', description: '' }),
    'serious'
  );
});

test('mapSeverity maps a Moderate raw511Severity to need_to_know', () => {
  assert.equal(
    mapSeverity({ raw511Severity: 'Moderate', raw511EventType: 'Accident', description: '' }),
    'need_to_know'
  );
});

test('mapSeverity maps a Low raw511Severity to proximity', () => {
  assert.equal(
    mapSeverity({ raw511Severity: 'Low', raw511EventType: 'Disabled Vehicle', description: '' }),
    'proximity'
  );
});

test('mapSeverity bumps a closure/emergency to serious regardless of a low raw511Severity', () => {
  assert.equal(
    mapSeverity({ raw511Severity: 'Low', raw511EventType: 'Road Closure', description: '' }),
    'serious'
  );
});

test('mapSeverity falls back to eventType keywords when raw511Severity is missing/unrecognized', () => {
  assert.equal(
    mapSeverity({ raw511Severity: '', raw511EventType: 'Accident', description: '' }),
    'need_to_know'
  );
  assert.equal(
    mapSeverity({ raw511Severity: '', raw511EventType: 'Debris', description: '' }),
    'proximity'
  );
});

test('mapSeverity conservatively defaults unmatched text to need_to_know, not fun_to_know', () => {
  assert.equal(
    mapSeverity({ raw511Severity: 'Unknown', raw511EventType: 'Something Else', description: '' }),
    'need_to_know'
  );
});

test('buildSpeech produces non-empty brief/average/deep, with deep at least as long as brief', () => {
  const normalized = {
    roadway: 'Stillwater Avenue',
    direction: 'Northbound',
    affectedLanes: 'Right lane closed',
    affectedLanesDetail: 'Right lane closed between mile 12 and 13',
    weightRestriction: '30 Ton',
    description: 'Bridge posted to 30 Ton',
    raw511EventType: 'Weight Restriction',
  };
  const speech = buildSpeech(normalized);
  assert.ok(speech.brief.length > 0);
  assert.ok(speech.average.length > 0);
  assert.ok(speech.deep.length > 0);
  assert.ok(speech.deep.length >= speech.brief.length);
  assert.match(speech.brief, /Weight Restriction on Stillwater Avenue/);
});

test('buildSpeech falls back to average when no long-form fields are present', () => {
  const speech = buildSpeech({ roadway: 'Main St', raw511EventType: 'Accident' });
  assert.equal(speech.deep, speech.average);
});

test('formatLaneDetail summarizes structured laneDetails into readable text', () => {
  assert.equal(
    formatLaneDetail({
      laneDetails: [
        { '@_type': 'MainLane', '@_status': 'Cleared', '@_index': '0' },
        { '@_type': 'Divider', '@_status': 'Closed', '@_index': '1' },
      ],
    }),
    'MainLane cleared, Divider closed'
  );
});

test('formatLaneDetail handles a single laneDetails element (collapsed to a bare object)', () => {
  assert.equal(
    formatLaneDetail({ laneDetails: { '@_type': 'MainLane', '@_status': 'Cleared' } }),
    'MainLane cleared'
  );
});

test('formatLaneDetail passes a plain string through unchanged and empties null/blank', () => {
  assert.equal(formatLaneDetail('Right lane closed'), 'Right lane closed');
  assert.equal(formatLaneDetail(null), null);
  assert.equal(formatLaneDetail(''), null);
});

test('formatWeightRestriction appends lbs to a numeric weight and passes text through', () => {
  assert.equal(formatWeightRestriction(60000), '60000 lbs');
  assert.equal(formatWeightRestriction('30 Ton'), '30 Ton');
  assert.equal(formatWeightRestriction(null), null);
});

test('filterByBbox includes an incident inside the radius and excludes one clearly outside it', () => {
  const near = { latitude: 43.66, longitude: -70.26 };
  const far = { latitude: 45.0, longitude: -68.0 };
  const results = filterByBbox([near, far], 43.66, -70.26, 5000);
  assert.deepEqual(results, [near]);
});

test('filterByBbox excludes incidents with missing coordinates', () => {
  const noCoords = { latitude: null, longitude: null };
  assert.deepEqual(filterByBbox([noCoords], 43.66, -70.26, 5000), []);
});
