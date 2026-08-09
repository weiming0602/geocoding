const test = require('node:test');
const assert = require('node:assert/strict');

const {
  searchPlaces,
  buildOverpassQuery,
  addressLineFromTags,
  parseNearQuery,
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

test('parseNearQuery splits terms from a trailing "near <place>" clause', () => {
  assert.deepEqual(parseNearQuery('barber shop near Brunswick, Maine'), {
    terms: 'barber shop',
    locationPhrase: 'Brunswick, Maine',
  });
  assert.deepEqual(parseNearQuery('pizza'), { terms: 'pizza', locationPhrase: null });
  // "near" with nothing after it, or nothing before it, isn't a usable split.
  assert.deepEqual(parseNearQuery('pizza near'), { terms: 'pizza near', locationPhrase: null });
  assert.deepEqual(parseNearQuery('near Brunswick'), { terms: 'near Brunswick', locationPhrase: null });
  // Rightmost "near" wins, so an incidental earlier "near" in the terms doesn't split there.
  assert.deepEqual(parseNearQuery('things near me near Brunswick, Maine'), {
    terms: 'things near me',
    locationPhrase: 'Brunswick, Maine',
  });
});

// searchPlaces with a "near <place>" query calls fetch twice: once to
// Nominatim (geocode the place), once to Overpass (the actual search) --
// this fake routes by URL the same way placesSearchEndpoint.test.js
// routes by host, since a single generic fake can't serve both shapes.
function withFetchByUrl(handlers, fn) {
  return async () => {
    const saved = global.fetch;
    global.fetch = async (url, ...args) => {
      if (typeof url === 'string' && url.includes('nominatim')) return handlers.nominatim(url, ...args);
      return handlers.overpass(url, ...args);
    };
    try {
      await fn();
    } finally {
      global.fetch = saved;
    }
  };
}

test(
  'searchPlaces resolves a "near <place>" clause via Nominatim and searches from there',
  withFetchByUrl(
    {
      nominatim: async (url) => {
        assert.match(url, /q=Brunswick%2C%20Maine/);
        return { ok: true, json: async () => [{ lat: '43.9145', lon: '-69.9653' }] };
      },
      overpass: async (_url, opts) => {
        assert.match(opts.body, /around:5000,43\.9145,-69\.9653/);
        assert.match(opts.body, /"name"~"barber",i/);
        return { ok: true, json: async () => ({ elements: [] }) };
      },
    },
    async () => {
      const result = await searchPlaces('barber shop near Brunswick, Maine', undefined, undefined, 5000);
      assert.deepEqual(result.center, { latitude: 43.9145, longitude: -69.9653 });
    }
  )
);

test(
  'searchPlaces prefers the "near <place>" clause over explicit coordinates when both are given',
  withFetchByUrl(
    {
      nominatim: async () => ({ ok: true, json: async () => [{ lat: '43.9145', lon: '-69.9653' }] }),
      overpass: async (_url, opts) => {
        assert.match(opts.body, /around:5000,43\.9145,-69\.9653/); // not the passed-in 0,0
        return { ok: true, json: async () => ({ elements: [] }) };
      },
    },
    async () => {
      await searchPlaces('barber shop near Brunswick, Maine', 0, 0, 5000);
    }
  )
);

test(
  'searchPlaces throws ValidationError when Nominatim finds nothing for the place name',
  withFetchByUrl(
    { nominatim: async () => ({ ok: true, json: async () => [] }), overpass: async () => ({ ok: true, json: async () => ({}) }) },
    async () => {
      await assert.rejects(
        () => searchPlaces('barber shop near Nowhereville', undefined, undefined, 5000),
        /couldn't find a location matching/
      );
    }
  )
);

test(
  'searchPlaces throws UpstreamError when Nominatim itself fails',
  withFetchByUrl(
    { nominatim: async () => ({ ok: false, status: 503 }), overpass: async () => ({ ok: true, json: async () => ({}) }) },
    async () => {
      await assert.rejects(
        () => searchPlaces('barber shop near Brunswick, Maine', undefined, undefined, 5000),
        UpstreamError
      );
    }
  )
);

test('searchPlaces still requires latitude/longitude when there is no "near" clause', async () => {
  await assert.rejects(
    () => searchPlaces('barber shop', undefined, undefined, 5000),
    /latitude and longitude must be numbers/
  );
});
