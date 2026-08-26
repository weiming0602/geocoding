const test = require('node:test');
const assert = require('node:assert/strict');

const {
  searchPlaces,
  buildOverpassQuery,
  addressLineFromTags,
  parseNearQuery,
  addressLineFromNominatim,
  metersToViewbox,
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

test('addressLineFromNominatim builds a Meridian-format line from Nominatim addressdetails', () => {
  assert.equal(
    addressLineFromNominatim({
      house_number: '653',
      road: 'Congress Street',
      city: 'Portland',
      state: 'Maine',
      postcode: '04101',
    }),
    '653 Congress Street, Portland, Maine 04101'
  );
});

test('addressLineFromNominatim falls back through town/village/hamlet when there is no city field', () => {
  assert.equal(
    addressLineFromNominatim({ house_number: '10', road: 'Main St', town: 'Brunswick', postcode: '04011' }),
    '10 Main St, Brunswick 04011'
  );
  assert.equal(
    addressLineFromNominatim({ house_number: '10', road: 'Main St', village: 'Freeport', postcode: '04032' }),
    '10 Main St, Freeport 04032'
  );
});

test('addressLineFromNominatim returns null when house_number, road, or postcode is missing', () => {
  assert.equal(addressLineFromNominatim({ road: 'Main St', postcode: '04011' }), null);
  assert.equal(addressLineFromNominatim({ house_number: '10', postcode: '04011' }), null);
  assert.equal(addressLineFromNominatim({ house_number: '10', road: 'Main St' }), null);
});

test('metersToViewbox produces a box centered on the given point', () => {
  const [minLon, minLat, maxLon, maxLat] = metersToViewbox(43.66, -70.26, 1000).split(',').map(Number);
  assert.ok(minLon < -70.26 && maxLon > -70.26);
  assert.ok(minLat < 43.66 && maxLat > 43.66);
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
            lat: 43.6591,
            lon: -70.2568,
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
            lat: 43.6591,
            lon: -70.2568,
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
        { name: 'Thai Palace', address: '10 Main St, Portland, ME 04101', latitude: 43.6591, longitude: -70.2568 },
      ]);
      assert.equal(result.skipped, 1);
      assert.equal(result.truncated, false);
    }
  )
);

// Regression: a result with a usable address but no valid coordinate
// (Overpass's own "out body" omits lat/lon for way/relation elements,
// only nodes carry it inline) previously flowed through as NaN, which
// crashed both frontends' map components (setLngLat/fitBounds throw on
// a NaN LngLat, with no error boundary to catch it) -- must be counted
// as skipped instead, same as a result missing a street address.
test(
  'searchPlaces skips a result with a usable address but no valid coordinate (Overpass)',
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
              'addr:postcode': '04101',
            },
            // No lat/lon at all.
          },
          {
            lat: NaN,
            lon: -70.26,
            tags: {
              name: 'Pizza Place',
              'addr:housenumber': '20',
              'addr:street': 'Main St',
              'addr:postcode': '04101',
            },
          },
          {
            lat: 43.66,
            lon: -70.26,
            tags: {
              name: 'Good Place',
              'addr:housenumber': '30',
              'addr:street': 'Main St',
              'addr:postcode': '04101',
            },
          },
        ],
      }),
    }),
    async () => {
      const result = await searchPlaces('place', 43.66, -70.26, 5000);
      assert.deepEqual(result.results, [
        { name: 'Good Place', address: '30 Main St 04101', latitude: 43.66, longitude: -70.26 },
      ]);
      assert.equal(result.skipped, 2);
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
          lat: 43.66 + i * 0.001,
          lon: -70.26,
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

// Nominatim is tried before Overpass now (see searchPlaces), so these
// two tests -- specifically about Overpass's own retry behavior -- route
// by URL and make Nominatim fail fast (network error), isolating the
// Overpass-only call count from Nominatim's.
test('searchPlaces retries Overpass once and succeeds if a later attempt lands on a healthier backend', async () => {
  const saved = global.fetch;
  let overpassCalls = 0;
  global.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('nominatim')) throw new Error('nominatim down');
    overpassCalls += 1;
    if (overpassCalls === 1) return { ok: false, status: 504 };
    return {
      ok: true,
      json: async () => ({
        elements: [
          {
            lat: 43.66,
            lon: -70.26,
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
    assert.equal(overpassCalls, 2);
    assert.equal(result.results.length, 1);
  } finally {
    global.fetch = saved;
  }
});

test('searchPlaces does not retry a 429 from Overpass -- retrying a rate limit would only make it worse', async () => {
  const saved = global.fetch;
  let overpassCalls = 0;
  global.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('nominatim')) throw new Error('nominatim down');
    overpassCalls += 1;
    return { ok: false, status: 429 };
  };
  try {
    await assert.rejects(() => searchPlaces('thai', 43.66, -70.26, 5000), /rate-limited/);
    assert.equal(overpassCalls, 1);
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

// Regression: same NaN-coordinate crash as the result-level tests above,
// but for the "near <place>" center itself (geocodePlaceName) -- a
// malformed lat/lon from Nominatim's own place lookup must not silently
// become the search center (which the frontend map would then hand to
// maplibre as a NaN LngLat and crash on).
test(
  'searchPlaces throws UpstreamError when Nominatim returns an unusable coordinate for a "near" clause',
  withFetchByUrl(
    {
      nominatim: async () => ({ ok: true, json: async () => [{ lat: 'not-a-number', lon: '-69.9653' }] }),
      overpass: async () => ({ ok: true, json: async () => ({}) }),
    },
    async () => {
      await assert.rejects(
        () => searchPlaces('barber shop near Brunswick, Maine', undefined, undefined, 5000),
        /unusable location/
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

test(
  'searchPlaces uses real Nominatim POI results directly, never touching Overpass',
  withFetchByUrl(
    {
      // The POI search call (searchNominatimPlaces) is distinguishable
      // from the near-clause geocode call (geocodePlaceName) by its
      // extra query params -- both hit the same nominatim host.
      nominatim: async (url) => {
        if (String(url).includes('addressdetails=1')) {
          return {
            ok: true,
            json: async () => [
              {
                name: 'Clippers Barber Shop',
                lat: '43.9151',
                lon: '-69.9648',
                address: { house_number: '16', road: 'Vannah Avenue', city: 'Portland', state: 'Maine', postcode: '04103' },
              },
            ],
          };
        }
        return { ok: true, json: async () => [{ lat: '43.9145', lon: '-69.9653' }] };
      },
      overpass: async () => {
        throw new Error('Overpass should not be called when Nominatim already found results');
      },
    },
    async () => {
      const result = await searchPlaces('barber shop near Brunswick, Maine', undefined, undefined, 5000);
      assert.deepEqual(result.results, [
        {
          name: 'Clippers Barber Shop',
          address: '16 Vannah Avenue, Portland, Maine 04103',
          latitude: 43.9151,
          longitude: -69.9648,
        },
      ]);
    }
  )
);

// Regression: same NaN-coordinate crash as the Overpass path above, but
// via Nominatim's own POI search (searchNominatimPlaces) -- a result
// missing lat/lon (parseFloat(undefined) === NaN) must be skipped, not
// handed to the frontend map component as an unusable point.
test(
  'searchPlaces skips a Nominatim POI result with a usable address but no valid coordinate',
  withFetchByUrl(
    {
      nominatim: async (url) => {
        if (String(url).includes('addressdetails=1')) {
          return {
            ok: true,
            json: async () => [
              {
                name: 'No Coordinate Shop',
                address: { house_number: '1', road: 'Main St', city: 'Portland', postcode: '04101' },
                // No lat/lon at all.
              },
              {
                name: 'Clippers Barber Shop',
                lat: '43.9151',
                lon: '-69.9648',
                address: { house_number: '16', road: 'Vannah Avenue', city: 'Portland', state: 'Maine', postcode: '04103' },
              },
            ],
          };
        }
        return { ok: true, json: async () => [{ lat: '43.9145', lon: '-69.9653' }] };
      },
      overpass: async () => {
        throw new Error('Overpass should not be called when Nominatim already found results');
      },
    },
    async () => {
      const result = await searchPlaces('barber shop near Brunswick, Maine', undefined, undefined, 5000);
      assert.deepEqual(result.results, [
        {
          name: 'Clippers Barber Shop',
          address: '16 Vannah Avenue, Portland, Maine 04103',
          latitude: 43.9151,
          longitude: -69.9648,
        },
      ]);
      assert.equal(result.skipped, 1);
    }
  )
);

test(
  'searchPlaces falls back to Overpass when Nominatim finds zero POI results',
  withFetchByUrl(
    {
      nominatim: async () => ({ ok: true, json: async () => [] }),
      overpass: async () => ({
        ok: true,
        json: async () => ({
          elements: [
            {
              lat: 43.9,
              lon: -69.96,
              tags: { name: 'Pizza Place', 'addr:housenumber': '5', 'addr:street': 'Elm St', 'addr:postcode': '04011' },
            },
          ],
        }),
      }),
    },
    async () => {
      const result = await searchPlaces('pizza', 43.9, -69.96, 5000);
      assert.deepEqual(result.results, [
        { name: 'Pizza Place', address: '5 Elm St 04011', latitude: 43.9, longitude: -69.96 },
      ]);
    }
  )
);

test('searchPlaces still requires latitude/longitude when there is no "near" clause', async () => {
  await assert.rejects(
    () => searchPlaces('barber shop', undefined, undefined, 5000),
    /latitude and longitude must be numbers/
  );
});
