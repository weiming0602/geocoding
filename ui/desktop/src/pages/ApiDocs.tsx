import AccountTabs from '../components/AccountTabs';
import PageHeader from '../components/PageHeader';

const pre = {
  background: 'var(--color-surface)',
  padding: 'var(--space-3)',
  borderRadius: 'var(--radius-md)',
  overflowX: 'auto' as const,
};

export default function ApiDocs() {
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader icon="help">API Docs</PageHeader>
      <AccountTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Call Meridian directly from your own code instead of uploading a file through this site --
        every endpoint below is the exact same one this site's own pages use.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        <strong>💡 Base URL:</strong> <code>https://api.meridiangeocoding.com</code> — every example
        below is a complete, runnable <code>curl</code> command against that URL.
      </div>

      <h2 style={{ marginTop: 0 }}>Authentication</h2>
      <p>
        Every endpoint accepts <code>email</code> and <code>serviceKey</code> as plain fields in the
        JSON request body — not an <code>Authorization</code> header. Get a service key from{' '}
        <a href="#/pricing">Pricing</a>; it's emailed to you right after purchase and never expires.
      </p>
      <p>
        <code>/geocode</code> and <code>/reverse-geocode</code> work <strong>without</strong> an
        account too — see Rate limits below for what that means. <code>/geocode/batch</code> and its
        two variants always require a real <code>email</code>+<code>serviceKey</code>.
      </p>

      <h2>Single lookups</h2>

      <h3>POST /geocode</h3>
      <p>Converts a street address to coordinates.</p>
      <pre style={pre}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode \\
  -H "Content-Type: application/json" \\
  -d '{"address": "4 Pleasant St, 04011"}'`}</code>
      </pre>
      <pre style={pre}>
        <code>{`{
  "input": { "number": 4, "streetName": "Pleasant St", "zip": "04011", "state": null, "town": null },
  "match": { "id": 23556, "tlid": "78007569", "fullname": "Pleasant St", "zipl": "04011", "zipr": "04011" },
  "source": "interpolation",
  "rangeSide": "right",
  "offsetSide": "right",
  "offsetFeet": 20,
  "coordinates": { "latitude": 43.91447417000781, "longitude": -69.9652059563305 }
}`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        <code>rangeSide</code> is which side of the street's stored address range the house number
        fell on (odd numbers → left, even → right — see <a href="#/help">Help</a> for why);{' '}
        <code>offsetSide</code>/<code>offsetFeet</code> describe how far the returned coordinate was
        nudged off the street centerline so it lands on the building's side of the road, not in the
        middle of the street.
      </p>
      <p>
        Add <code>email</code>/<code>serviceKey</code> to the body to draw from your account's quota
        instead of the free/rate-limited path — the response shape is identical either way, the only
        difference is that an authenticated call spends 1 unit of quota and is never rate-limited:
      </p>
      <pre style={pre}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode \\
  -H "Content-Type: application/json" \\
  -d '{
    "address": "4 Pleasant St, 04011",
    "email": "you@example.com",
    "serviceKey": "mk_..."
  }'`}</code>
      </pre>

      <h3>POST /reverse-geocode</h3>
      <p>Converts coordinates to the nearest address — the reverse of the above.</p>
      <pre style={pre}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/reverse-geocode \\
  -H "Content-Type: application/json" \\
  -d '{"latitude": 43.91447417000781, "longitude": -69.9652059563305}'`}</code>
      </pre>
      <pre style={pre}>
        <code>{`{
  "input": { "latitude": 43.91447417000781, "longitude": -69.9652059563305 },
  "match": { "id": 23556, "tlid": "78007569", "fullname": "Pleasant St", "zipl": "04011", "zipr": "04011", "state": "Maine", "state_abbr": "ME" },
  "side": "right",
  "number": 4,
  "address": "4 Pleasant St",
  "distanceMeters": 6.096000483129015,
  "matchedCoordinates": { "latitude": 43.914526400362874, "longitude": -69.96522879840107 }
}`}</code>
      </pre>
      <p>
        Same optional <code>email</code>/<code>serviceKey</code> fields as <code>/geocode</code>, same
        effect: authenticated calls draw from your quota and are never rate-limited.
      </p>

      <h2>Rate limits (unauthenticated calls only)</h2>
      <p>
        Calling <code>/geocode</code> or <code>/reverse-geocode</code> with no credentials is free, but
        limited to <strong>10 requests per minute per IP address</strong>. Exceed that and you'll get:
      </p>
      <pre style={pre}>
        <code>{`HTTP/1.1 429 Too Many Requests
{
  "error": "Rate limit exceeded: unauthenticated requests are limited to 10/minute. You're blocked from further anonymous requests for the rest of today -- sign up for a free account to get a service key for uninterrupted access."
}`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        That block lasts for the rest of the current day (UTC), not just a minute — it's meant to stop
        the free single-lookup endpoint from being used as an unpaid substitute for{' '}
        <code>/geocode/batch</code>, not to rate-limit a person occasionally trying a few addresses.
        Pass <code>email</code>/<code>serviceKey</code> to skip this entirely.
      </p>

      <h2>Batch</h2>
      <p>
        All three batch endpoints require <code>email</code>+<code>serviceKey</code> and draw from
        your account's monthly quota (see <a href="#/plan-quota">Plan &amp; quota</a>). One address per
        line, no cap on count.
      </p>

      <h3>POST /geocode/batch</h3>
      <p>
        Returns results as JSON, directly in the response. Addresses go in <code>fileContent</code> as
        a single newline-separated string:
      </p>
      <pre style={pre}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode/batch \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "you@example.com",
    "serviceKey": "mk_...",
    "fileContent": "4 Pleasant St, 04011\\n91 Chestnut St, Portland, ME 04101"
  }'`}</code>
      </pre>
      <pre style={pre}>
        <code>{`{
  "results": [
    {
      "address": "4 Pleasant St, 04011",
      "success": true,
      "input": { "number": 4, "streetName": "Pleasant St", "zip": "04011", "state": null, "town": null },
      "match": { "id": 23556, "tlid": "78007569", "fullname": "Pleasant St", "zipl": "04011", "zipr": "04011" },
      "source": "interpolation",
      "rangeSide": "right",
      "offsetSide": "right",
      "offsetFeet": 20,
      "coordinates": { "latitude": 43.91447417000781, "longitude": -69.9652059563305 }
    },
    {
      "address": "91 Chestnut St, Portland, ME 04101",
      "success": true,
      "input": { "number": 91, "streetName": "Chestnut St", "zip": "04101", "state": "ME", "town": "Portland" },
      "match": { "id": 30884, "tlid": "78028188", "fullname": "Chestnut St", "zipl": "04101", "zipr": "", "state_abbr": "ME" },
      "source": "interpolation",
      "rangeSide": "left",
      "offsetSide": "left",
      "offsetFeet": 20,
      "coordinates": { "latitude": 43.66074285774163, "longitude": -70.26014782589851 }
    }
  ],
  "usedThisPeriod": 2,
  "remaining": 998,
  "tier": 1000
}`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        One bad address doesn't fail the whole batch — a failed row gets{' '}
        <code>{`{ "success": false, "error": "..." }`}</code> in its place instead of a coordinate.
      </p>

      <h3>POST /geocode/batch/download</h3>
      <p>
        Same request shape as above, but the response is a ZIP file (<code>results.csv</code> +{' '}
        <code>errors.csv</code>) instead of JSON:
      </p>
      <pre style={pre}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode/batch/download \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com", "serviceKey": "mk_...", "fileContent": "4 Pleasant St, 04011"}' \\
  -o results.zip`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        The response also carries an <code>X-Quota</code> header (e.g. <code>3/1000</code>) so you can
        read usage without a separate <code>/quota</code> call. <code>results.csv</code> has columns{' '}
        <code>address,latitude,longitude,source,matchFullname</code>; <code>errors.csv</code> has{' '}
        <code>address,error</code>.
      </p>

      <h3>POST /geocode/batch/email</h3>
      <p>Same again, but the ZIP is emailed to your account's own address instead of returned directly.</p>
      <div className="plate" style={{ margin: 'var(--space-3) 0' }}>
        <strong>⚠ Different request shape:</strong> unlike the two endpoints above, this one does{' '}
        <strong>not</strong> accept <code>fileContent</code> — it only reads a server-local{' '}
        <code>filePath</code> (and that path must resolve inside the server's own temp directory). In
        practice this means a remote caller without filesystem access to the server itself can't use
        this endpoint directly; if you just want a copy of the results yourself, use{' '}
        <code>/geocode/batch/download</code> instead and save the ZIP it returns.
      </div>
      <pre style={pre}>
        <code>{`curl -X POST https://api.meridiangeocoding.com/geocode/batch/email \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "you@example.com",
    "serviceKey": "mk_...",
    "filePath": "/tmp/addresses.txt"
  }'`}</code>
      </pre>
      <p className="text-muted" style={{ fontSize: 13 }}>
        Response headers: <code>X-Quota</code> (e.g. <code>5/1000</code>) and{' '}
        <code>X-Email-Delivery</code> (<code>sent</code> once real email delivery is configured
        server-side, <code>stubbed</code> otherwise — either way the ZIP is still returned in the
        response body itself).
      </p>

      <h2>Errors</h2>
      <p>Every endpoint returns a plain <code>{`{ "error": "..." }`}</code> body with one of these HTTP statuses:</p>
      <ul>
        <li><code>400</code> — malformed request (bad address format, missing field)</li>
        <li><code>401</code> — <code>serviceKey</code> present but wrong/doesn't match <code>email</code></li>
        <li><code>404</code> — no match found for the address/coordinates, or an unknown account email</li>
        <li><code>422</code> — coordinates or address out of the supported range</li>
        <li><code>429</code> — rate-limited (see above) or your account's quota is exhausted this period</li>
      </ul>
    </div>
  );
}
