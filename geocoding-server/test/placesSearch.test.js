const test = require('node:test');
const assert = require('node:assert/strict');

const {
  searchPlaces,
  buildOverpassQuery,
  addressLineFromTags,
  MAX_RESULTS,
} = require('../src/placesSearch');
const { ValidationError, UpstreamError } = require('../src/errors');

test('addressLineFromTags builds a Meridian-format line when housenumber/street/postcode are present', () => {
  assert.equal(
    addressLineFromTags({
      'addr:housenumber': '997',
      'addr:street': 'Pequawket Trl',
      'addr:city': 'Standish',
      'addr:state': 'ME',
      'addr:postcode': '04091',
    }),
    '997 Pequawket Trl, Standish, ME 04091'
  );
});

test('addressLineFromTags omits city/state gracefully when only postcode is present', () => {
  assert.equal(
    addressLineFromTags({
      'addr:housenumber': '997',
      'addr:street': 'Pequawket Trl',
      'addr:postcode': '04091',
    }),
    '997 Pequawket Trl 04091'
  );
});

test('addressLineFromTags returns null when housenumber, street, or postcode is missing', () => {
  assert.equal(addressLineFromTags({ 'addr:street': 'Pequawket Trl', 'addr:postcode': '04091' }), null);
  assert.equal(addressLineFromTags({ 'addr:housenumber': '997', 'addr:postcode': '04091' }), null);
  assert.equal(addressLineFromTags({ 'addr:housenumber': '997', 'addr:street': 'Pequawket Trl' }), null);
  assert.equal(addressLineFromTags({ name: 'Some Place' }), null);
});

test('buildOverpassQuery includes an around clause and a filter per word per tag', () => {
  const query = buildOverpassQuery(['asian', 'restaurant'], 43.66, -70.26, 5000);
  assert.match(query, /around:5000,43\.66,-70\.26/);
  // Two clauses per word (name + a combined cuisine/amenity/shop
  // regex), not one per tag -- four separate per-tag regex clauses
  // measurably risked timing out the public Overpass instance.
  assert.match(query, /"name"~"asian",i/);
  assert.match(query, /\[~"\^\(cuisine\|amenity\|shop\)\$"~"asian",i\]/);
  assert.match(query, /"name"~"restaurant",i/);
  assert.match(query, /\[~"\^\(cuisine\|amenity\|shop\)\$"~"restaurant",i\]/);
});

// searchPlaces calls the global fetch; each test below swaps it out for a
// fake and restores the original afterward (matching billing.test.js's
// pattern for mocking global.fetch).
function withFetch(fakeFetch, fn) {
  return async () => {
    const saved = global.fetch;
    global.fetch = fakeFetch;
    try {
      await fn();
    } finally {
      global.fetch = saved;
    }
  };
}

test(
  'searchPlaces extracts addresses, dedupes, and counts skipped results',
  withFetch(
    async () => ({
      ok: true,
      json: async () => ({
        elements: [
          {
            tags: {
              name: 'Thai Palace',
              'addr:housenumber': '10',
              'addr:street': 'Main St',
              'addr:city': 'Portland',
              'addr:state': 'ME',
              'addr:postcode': '04101',
            },
          },
          // Same address matched via a different tag (e.g. both "name"
          // and "cuisine" matched) -- should be deduped, not counted twice.
          {
            tags: {
              name: 'Thai Palace',
              'addr:housenumber': '10',
              'addr:street': 'Main St',
              'addr:city': 'Portland',
              'addr:state': 'ME',
              'addr:postcode': '04101',
            },
          },
          // No street address at all -- counted as skipped, not silently dropped.
          { tags: { name: 'Food Truck (no fixed address)' } },
        ],
      }),
    }),
    async () => {
      const result = await searchPlaces('thai', 43.66, -70.26, 5000);
      assert.deepEqual(result.results, [
        { name: 'Thai Palace', address: '10 Main St, Portland, ME 04101' },
      ]);
      assert.equal(result.skipped, 1);
      assert.equal(result.truncated, false);
    }
  )
);

test(
  'searchPlaces caps results at MAX_RESULTS and reports truncated',
  withFetch(
    async () => ({
      ok: true,
      json: async () => ({
        elements: Array.from({ length: MAX_RESULTS + 10 }, (_, i) => ({
          tags: {
            name: `Place ${i}`,
            'addr:housenumber': String(i + 1),
            'addr:street': 'Main St',
            'addr:postcode': '04101',
          },
        })),
      }),
    }),
    async () => {
      const result = await searchPlaces('place', 43.66, -70.26, 5000);
      assert.equal(result.results.length, MAX_RESULTS);
      assert.equal(result.truncated, true);
    }
  )
);

test(
  'searchPlaces throws UpstreamError (not a bug in this app) when Overpass itself fails',
  withFetch(
    async () => ({ ok: false, status: 504 }),
    async () => {
      await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, 5000), UpstreamError);
    }
  )
);

test(
  'searchPlaces throws a specific UpstreamError message when rate-limited (429)',
  withFetch(
    async () => ({ ok: false, status: 429 }),
    async () => {
      await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, 5000), /rate-limited/);
    }
  )
);

test(
  'searchPlaces throws UpstreamError when the request itself fails/times out (network error)',
  withFetch(
    async () => {
      throw new Error('timeout');
    },
    async () => {
      await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, 5000), UpstreamError);
    }
  )
);

test('searchPlaces retries once and succeeds if a later attempt lands on a healthier backend', async () => {
  const saved = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 504 };
    return {
      ok: true,
      json: async () => ({
        elements: [
          {
            tags: {
              name: 'Thai Palace',
              'addr:housenumber': '10',
              'addr:street': 'Main St',
              'addr:postcode': '04101',
            },
          },
        ],
      }),
    };
  };
  try {
    const result = await searchPlaces('thai', 43.66, -70.26, 5000);
    assert.equal(calls, 2);
    assert.equal(result.results.length, 1);
  } finally {
    global.fetch = saved;
  }
});

test('searchPlaces does not retry a 429 -- retrying a rate limit would only make it worse', async () => {
  const saved = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429 };
  };
  try {
    await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, 5000), /rate-limited/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = saved;
  }
});

test('searchPlaces validates its inputs before ever calling fetch', async () => {
  await assert.rejects(() => searchPlaces('', 43.66, -70.26, 5000), ValidationError);
  await assert.rejects(() => searchPlaces('thai', 'not-a-number', -70.26, 5000), ValidationError);
  await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, -1), ValidationError);
  await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, 999999), ValidationError);
});
