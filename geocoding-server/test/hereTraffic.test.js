const test = require('node:test');
const assert = require('node:assert/strict');

const { isHereConfigured, mapHereSeverity, categorizeHereIncident, extractRoadwayFromDescription } = require('../src/hereTraffic');

test('isHereConfigured is false when HERE_API_KEY is unset', () => {
  const saved = process.env.HERE_API_KEY;
  delete process.env.HERE_API_KEY;
  try {
    assert.equal(isHereConfigured(), false);
  } finally {
    if (saved !== undefined) process.env.HERE_API_KEY = saved;
  }
});

test('isHereConfigured is true when HERE_API_KEY is set', () => {
  const saved = process.env.HERE_API_KEY;
  process.env.HERE_API_KEY = 'test-key';
  try {
    assert.equal(isHereConfigured(), true);
  } finally {
    if (saved !== undefined) process.env.HERE_API_KEY = saved;
    else delete process.env.HERE_API_KEY;
  }
});

// roadClosed/type/criticality values below are exactly as observed live
// from HERE Traffic API v7 against real Dallas, TX incidents this
// session -- see docs/superpowers/specs/2026-09-10-here-traffic-provider-design.md.
test('mapHereSeverity maps a real road closure (roadClosed: true) to serious', () => {
  assert.equal(mapHereSeverity({ criticality: 'critical', roadClosed: true, type: 'roadClosure' }), 'serious');
});

test('mapHereSeverity maps type roadClosure to serious even if roadClosed were false', () => {
  assert.equal(mapHereSeverity({ criticality: 'minor', roadClosed: false, type: 'roadClosure' }), 'serious');
});

test('mapHereSeverity maps criticality critical to serious regardless of type', () => {
  assert.equal(mapHereSeverity({ criticality: 'critical', roadClosed: false, type: 'plannedEvent' }), 'serious');
});

test('mapHereSeverity maps criticality major to need_to_know', () => {
  assert.equal(mapHereSeverity({ criticality: 'major', roadClosed: false, type: 'construction' }), 'need_to_know');
});

test('mapHereSeverity maps criticality minor to proximity', () => {
  assert.equal(mapHereSeverity({ criticality: 'minor', roadClosed: false, type: 'construction' }), 'proximity');
});

test('mapHereSeverity falls back to proximity for an unrecognized criticality value', () => {
  assert.equal(mapHereSeverity({ criticality: 'unknown-future-value', roadClosed: false, type: 'other' }), 'proximity');
});

// description/type values below are real, sampled live from HERE
// Traffic API v7 against Dallas, TX incidents this session.
test('categorizeHereIncident maps type construction directly to construction', () => {
  assert.equal(
    categorizeHereIncident({ type: 'construction', typeDescription: { value: 'Road construction' }, description: { value: 'At W Mockingbird Ln - Construction work' } }),
    'construction'
  );
});

test('categorizeHereIncident maps type roadClosure directly to closure', () => {
  assert.equal(
    categorizeHereIncident({ type: 'roadClosure', typeDescription: { value: 'Road closure' }, description: { value: 'Closed' } }),
    'closure'
  );
});

test('categorizeHereIncident maps type congestion directly to congestion', () => {
  assert.equal(
    categorizeHereIncident({ type: 'congestion', typeDescription: { value: 'Congestion' }, description: { value: 'Backed-up traffic' } }),
    'congestion'
  );
});

test('categorizeHereIncident maps type laneRestriction directly to obstruction', () => {
  assert.equal(
    categorizeHereIncident({ type: 'laneRestriction', typeDescription: { value: 'Lane restriction' }, description: { value: 'Turning lane closed' } }),
    'obstruction'
  );
});

test('categorizeHereIncident falls back to the shared keyword matcher for type plannedEvent, defaulting to other', () => {
  assert.equal(
    categorizeHereIncident({ type: 'plannedEvent', typeDescription: { value: 'Planned event' }, description: { value: 'At Caroline St - Fair' } }),
    'other'
  );
});

test('categorizeHereIncident falls back to the shared keyword matcher and can still detect hazmat from description text', () => {
  assert.equal(
    categorizeHereIncident({ type: 'other', typeDescription: { value: 'Other news' }, description: { value: 'Chemical spill on shoulder' } }),
    'hazmat'
  );
});

test('extractRoadwayFromDescription extracts the roadway from an "At X - Y" description', () => {
  assert.equal(extractRoadwayFromDescription('At W Mockingbird Ln - Construction work'), 'W Mockingbird Ln');
  assert.equal(extractRoadwayFromDescription('At TX-289/Preston Rd/Exit 21 - Backed-up traffic. Approach with care'), 'TX-289/Preston Rd/Exit 21');
});

test('extractRoadwayFromDescription returns null when the description does not follow that pattern', () => {
  assert.equal(extractRoadwayFromDescription('Closed'), null);
  assert.equal(extractRoadwayFromDescription('Turning lane closed'), null);
  assert.equal(extractRoadwayFromDescription(null), null);
});
