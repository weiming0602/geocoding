const test = require('node:test');
const assert = require('node:assert/strict');

const { isHereConfigured, mapHereSeverity } = require('../src/hereTraffic');

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
