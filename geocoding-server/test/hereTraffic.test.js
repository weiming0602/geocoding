const test = require('node:test');
const assert = require('node:assert/strict');

const { isHereConfigured, mapHereSeverity, categorizeHereIncident, extractRoadwayFromDescription, normalizeHereIncident, getHereIncidents } = require('../src/hereTraffic');
const { UpstreamError } = require('../src/errors');

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

// Real incidents captured live from HERE Traffic API v7 this session
// (Dallas, TX -- circle:32.8626698,-96.7601162;r=10000,
// locationReferencing=shape) -- shape.links trimmed to 2 points for
// readability, incidentDetails kept verbatim.
const REAL_CONSTRUCTION_INCIDENT = {
  location: {
    length: 559.0,
    shape: { links: [{ points: [{ lat: 32.81818, lng: -96.84479 }, { lat: 32.81947, lng: -96.84636 }], length: 206.0, functionalClass: 3 }] },
  },
  incidentDetails: {
    id: '2021742316625632607',
    hrn: 'here:traffic:incident:2021742316625632607',
    startTime: '2026-09-02T16:17:34Z',
    endTime: '2026-09-13T16:17:34Z',
    entryTime: '2026-09-03T15:32:50Z',
    roadClosed: false,
    criticality: 'minor',
    type: 'construction',
    typeDescription: { value: 'Road construction', language: 'en-US' },
    codes: [803, 500],
    description: { value: 'At W Mockingbird Ln - Construction work', language: 'en-US' },
    summary: { value: 'Construction work', language: 'en-US' },
  },
};

const REAL_ROAD_CLOSURE_INCIDENT = {
  location: {
    length: 119.0,
    shape: { links: [{ points: [{ lat: 32.90477, lng: -96.68286 }, { lat: 32.90477, lng: -96.68261 }], length: 23.0, functionalClass: 5 }] },
  },
  incidentDetails: {
    id: '3690011721065073050',
    hrn: 'here:traffic:incident:3690011721065073050',
    startTime: '2026-09-09T22:21:50Z',
    endTime: '2026-09-11T10:21:50Z',
    entryTime: '2026-09-09T22:21:50Z',
    roadClosed: true,
    criticality: 'critical',
    type: 'roadClosure',
    typeDescription: { value: 'Road closure', language: 'en-US' },
    codes: [401],
    description: { value: 'Closed', language: 'en-US' },
    summary: { value: 'Closed', language: 'en-US' },
  },
};

// An incident with no shape data at all -- defensive case, not sampled
// live (every real incident this session had shape data), but HERE's
// docs don't guarantee every location referencing type is always
// present for every incident.
const NO_SHAPE_INCIDENT = {
  location: { length: 10.0 },
  incidentDetails: {
    id: 'no-shape-test-id',
    entryTime: '2026-09-10T00:00:00Z',
    roadClosed: false,
    criticality: 'minor',
    type: 'other',
    typeDescription: { value: 'Other news', language: 'en-US' },
    description: { value: 'Something happened', language: 'en-US' },
    summary: { value: 'Something happened', language: 'en-US' },
  },
};

test('normalizeHereIncident maps a real construction incident to the RoadSignal shape', () => {
  const normalized = normalizeHereIncident(REAL_CONSTRUCTION_INCIDENT);
  assert.equal(normalized.id, '2021742316625632607');
  assert.equal(normalized.type, 'traffic_hazard');
  assert.equal(normalized.source, 'HERE Traffic API');
  assert.equal(normalized.network, 'HERE');
  assert.equal(normalized.roadway, 'W Mockingbird Ln');
  assert.equal(normalized.latitude, 32.81818);
  assert.equal(normalized.longitude, -96.84479);
  assert.equal(normalized.description, 'At W Mockingbird Ln - Construction work');
  assert.equal(normalized.createdAt, '2026-09-03T15:32:50Z');
  assert.equal(normalized.lastUpdatedAt, '2026-09-03T15:32:50Z');
  assert.equal(normalized.severity, 'proximity');
  assert.equal(normalized.hazardCategory, 'construction');
  assert.equal(normalized.speech.brief, 'Construction work');
  assert.equal(normalized.raw511EventType, 'Road construction');
  assert.equal(normalized.raw511Severity, null);
  assert.equal(normalized.status, null);
  assert.equal(normalized.direction, null);
  assert.equal(normalized.crossStreet, null);
  assert.equal(normalized.mileMarker, null);
  assert.equal(normalized.county, null);
  assert.equal(normalized.city, null);
  assert.equal(normalized.affectedLanes, null);
  assert.equal(normalized.affectedLanesDetail, null);
  assert.equal(normalized.weightRestriction, null);
  assert.equal(normalized.verifiedBy, null);
});

test('normalizeHereIncident maps a real road closure incident to severity serious', () => {
  const normalized = normalizeHereIncident(REAL_ROAD_CLOSURE_INCIDENT);
  assert.equal(normalized.roadway, null);
  assert.equal(normalized.severity, 'serious');
  assert.equal(normalized.hazardCategory, 'closure');
  assert.equal(normalized.latitude, 32.90477);
  assert.equal(normalized.longitude, -96.68286);
});

test('normalizeHereIncident returns null latitude/longitude when there is no shape data', () => {
  const normalized = normalizeHereIncident(NO_SHAPE_INCIDENT);
  assert.equal(normalized.latitude, null);
  assert.equal(normalized.longitude, null);
});

// fetchHereIncidents/getHereIncidents call the real global fetch, so
// these tests replace it with a fake for the duration of each test and
// restore it afterward -- same technique roadSignalsEndpoint.test.js
// already uses for New England 511's fetch calls.
function withFakeFetch(respond, fn) {
  return async () => {
    const saved = global.fetch;
    global.fetch = respond;
    try {
      await fn();
    } finally {
      global.fetch = saved;
    }
  };
}

test(
  'getHereIncidents fetches, normalizes, and bbox-filters real HERE results',
  withFakeFetch(
    async (url) => {
      assert.ok(String(url).startsWith('https://data.traffic.hereapi.com/v7/incidents?'));
      assert.ok(String(url).includes('in=circle:32.8626698,-96.7601162;r=10000'));
      assert.ok(String(url).includes('locationReferencing=shape'));
      return {
        ok: true,
        json: async () => ({ results: [REAL_CONSTRUCTION_INCIDENT, REAL_ROAD_CLOSURE_INCIDENT] }),
      };
    },
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        const signals = await getHereIncidents({ latitude: 32.8626698, longitude: -96.7601162, radiusMeters: 10000 });
        assert.equal(signals.length, 2);
        assert.ok(signals.some((s) => s.id === '2021742316625632607'));
        assert.ok(signals.some((s) => s.id === '3690011721065073050'));
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test(
  'getHereIncidents throws UpstreamError when the HERE fetch itself fails',
  withFakeFetch(
    async () => {
      throw new Error('network down');
    },
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        await assert.rejects(
          () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
          UpstreamError
        );
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test(
  'getHereIncidents throws UpstreamError when HERE responds with a non-2xx status',
  withFakeFetch(
    async () => ({ ok: false, status: 500 }),
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        await assert.rejects(
          () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
          UpstreamError
        );
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test(
  'getHereIncidents throws UpstreamError when the HERE response body is malformed JSON',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token in JSON');
      },
    }),
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        await assert.rejects(
          () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
          UpstreamError
        );
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test(
  'getHereIncidents throws UpstreamError when a result entry is missing incidentDetails',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({ results: [{ location: {} }] }),
    }),
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        await assert.rejects(
          () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
          UpstreamError
        );
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);

test('getHereIncidents throws UpstreamError when HERE_API_KEY is unset, without calling fetch', async () => {
  const saved = process.env.HERE_API_KEY;
  delete process.env.HERE_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  try {
    await assert.rejects(
      () => getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 }),
      UpstreamError
    );
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.HERE_API_KEY = saved;
  }
});

// Regression test for the bbox-refiltering bug: HERE's own circle query
// already confirmed this incident is relevant, but normalizeHereIncident
// only has the segment's first shape point to work with -- here it's
// placed roughly 10km+ north of the query point, well outside a 10km
// query radius, even though the real incident (and the rest of its
// segment) is genuinely within range. getHereIncidents must NOT drop it.
const FAR_FIRST_POINT_INCIDENT = {
  location: {
    length: 15000.0,
    shape: { links: [{ points: [{ lat: 32.95, lng: -96.76 }, { lat: 32.86, lng: -96.76 }], length: 15000.0, functionalClass: 1 }] },
  },
  incidentDetails: {
    id: 'far-first-point-test-id',
    entryTime: '2026-09-10T00:00:00Z',
    roadClosed: false,
    criticality: 'minor',
    type: 'construction',
    typeDescription: { value: 'x' },
    description: { value: 'x' },
    summary: { value: 'x' },
  },
};

test(
  'getHereIncidents does not drop an incident whose first shape point is far outside the query radius, since HERE already confirmed relevance',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({ results: [FAR_FIRST_POINT_INCIDENT] }),
    }),
    async () => {
      const saved = process.env.HERE_API_KEY;
      process.env.HERE_API_KEY = 'test-key';
      try {
        const signals = await getHereIncidents({ latitude: 32.86, longitude: -96.76, radiusMeters: 10000 });
        assert.equal(signals.length, 1);
        assert.equal(signals[0].id, 'far-first-point-test-id');
      } finally {
        if (saved !== undefined) process.env.HERE_API_KEY = saved;
        else delete process.env.HERE_API_KEY;
      }
    }
  )
);
