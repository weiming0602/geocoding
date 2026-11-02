import { useState } from 'react';

import AccountTabs from '../components/AccountTabs';
import FeedbackForm from '../components/FeedbackForm';
import PageHeader from '../components/PageHeader';
import RoadAlertsDiagram from '../components/RoadAlertsDiagram';

type HelpTopic = 'geocoding' | 'roadAlerts';

export default function Help() {
  const [topic, setTopic] = useState<HelpTopic>('geocoding');

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader icon="help">Help</PageHeader>
      <AccountTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        A short guide to how Meridian's two features actually work.
      </p>

      <div className="seg" style={{ marginBottom: 'var(--space-6)' }}>
        <label className="seg-opt">
          <input
            type="radio"
            name="helpTopic"
            checked={topic === 'geocoding'}
            onChange={() => setTopic('geocoding')}
          />
          Geocoding
        </label>
        <label className="seg-opt">
          <input
            type="radio"
            name="helpTopic"
            checked={topic === 'roadAlerts'}
            onChange={() => setTopic('roadAlerts')}
          />
          Road Alerts
        </label>
      </div>

      {topic === 'geocoding' ? <GeocodingHelp /> : <RoadAlertsHelp />}

      <h2 style={{ marginTop: 'var(--space-6)' }}>Still have a question?</h2>
      <FeedbackForm />
    </div>
  );
}

function GeocodingHelp() {
  return (
    <>
      <h1 style={{ marginTop: 0 }}>How Meridian geocodes an address</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        What happens when you look up, reverse-geocode, or batch-process addresses.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        <strong>💡 Coverage:</strong> Maine and New Hampshire, by design. Meridian isn't trying to
        cover the whole country — it's built specifically for these two states. Addresses outside
        Maine and New Hampshire aren't supported yet.
      </div>

      <h2>Forward geocoding: address → coordinates</h2>
      <p>Meridian tries these in order and stops at the first one that finds your address:</p>
      <ol>
        <li>
          <strong>An exact surveyed point</strong> (Maine only). Maine's E911 data has a real location
          for most individual buildings. If your house number, street and town match one, that exact
          point is returned.
        </li>
        <li>
          <strong>The street, inside the town you named.</strong> Meridian knows every Maine and New
          Hampshire town's boundary, and looks for your street inside the town in your address.
        </li>
        <li>
          <strong>The street, by ZIP code.</strong> Used when you gave no town, the town isn't one
          Meridian recognizes, or that town has no street by that name.
        </li>
      </ol>
      <p>
        Steps 2 and 3 work from street segments. Each segment records an address range on its{' '}
        <strong>left</strong> side and a separate range on its <strong>right</strong> side, because
        the two sides of a street are numbered differently: one side odd, the other even. Which side
        holds the odd numbers isn't a fixed rule; it varies from segment to segment, and Meridian
        reads it from each segment's own data. Then it:
      </p>
      <ol>
        <li>Picks the segment, and the side, whose range actually contains your house number.</li>
        <li>
          Places a point proportionally along that segment: if the range runs 1–99 and you asked for
          91, the point sits about 91% of the way from the "1" end toward the "99" end.
        </li>
        <li>
          Moves the point slightly off the centerline onto that side, so the pin lands on the
          building's side of the road rather than in the middle of the street.
        </li>
      </ol>

      <div className="plate" style={{ margin: 'var(--space-4) 0' }}>
        <img src="/help/chestnut-91-left.png" style={{ display: 'block', width: '100%' }} />
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8 }}>
        Chestnut Rd runs from house number 1 to 99. On this segment the odd numbers are on the{' '}
        <strong>left</strong>, so 91 is placed on the left side, about 91% of the way toward the 99
        end — matching the marker near "end num: 99."
      </p>

      <div className="plate" style={{ margin: 'var(--space-4) 0' }}>
        <img src="/help/sawyer-26-right.png" style={{ display: 'block', width: '100%' }} />
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8 }}>
        Sawyer Brook Rd runs from house number 2 to 98. On this segment the even numbers are on the{' '}
        <strong>right</strong>, so 26 is placed on the right side, close to the "start num: 2" end —
        since 26 is near the low end of the range.
      </p>

      <h2>When an address has a mistake</h2>
      <p>
        Real addresses often arrive with a wrong ZIP code or a misspelled street. Here's what Meridian
        does with each, and how a result tells you it fixed something:
      </p>
      <table className="table" style={{ marginBottom: 'var(--space-4)' }}>
        <thead>
          <tr>
            <th>Mistake</th>
            <th>Example</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Wrong ZIP code</td>
            <td>10 Forest Ave, Lebanon, NH <strong>03301</strong> (03301 is Concord's)</td>
            <td>
              Found in Lebanon anyway. The result is tagged <strong>ZIP corrected: 03766</strong>.
            </td>
          </tr>
          <tr>
            <td>Misspelled street</td>
            <td>
              73 <strong>Piine</strong> St, Lewiston, ME 04240
            </td>
            <td>
              Signed in: an AI-assisted retry finds Pine St, tagged <strong>AI-corrected</strong>. Not
              signed in: "no street found".
            </td>
          </tr>
          <tr>
            <td>Both at once</td>
            <td>73 Piine St, Lewiston, ME 04106</td>
            <td>Signed in: Pine St in Lewiston, with both tags.</td>
          </tr>
          <tr>
            <td>No ZIP code</td>
            <td>7 Federal St, Concord, NH</td>
            <td>Found by town. A ZIP isn't required when the town is given.</td>
          </tr>
        </tbody>
      </table>

      <h3>Wrong ZIP codes: the town you named comes first</h3>
      <p>
        When your address names a town, Meridian looks for the street inside that town before it
        trusts the ZIP. If the street is there, that's the result, even if the ZIP belongs somewhere
        else. The street's real ZIP is reported back (<strong>ZIP corrected</strong>, and a{' '}
        <code>correctedZip</code> column in batch results) so you can fix your records. The ZIP is
        only used when the town can't place the address: the town isn't recognized, it has no street
        by that name, or the same town name exists in both states and you gave neither a state nor a
        matching ZIP.
      </p>
      <p className="text-muted" style={{ fontSize: 13 }}>
        Town names have to be the official town or city. A village or mailing name that isn't its own
        town (such as "West Lebanon", which is part of Lebanon) isn't recognized, so those addresses
        fall back to their ZIP code. And because the town comes first, an address whose mailing town
        differs from the town it's really in could, rarely, land on a same-named street in the named
        town. The ZIP corrected tag makes that visible.
      </p>

      <h3>Misspelled streets: an AI-assisted retry</h3>
      <p>
        When a street isn't found as written, Meridian collects real streets with similar spellings,
        first from the town you named and then from your ZIP code, and asks an AI model which one you
        most likely meant ("Pine St" for "Piine St"). The model can only choose from streets that
        really exist in Meridian's data, or say none of them fit; it can never invent a street.
        Meridian then geocodes the chosen street normally, and rejects the pick if it lands more than
        5 km outside the town you named. A rescued result is always tagged{' '}
        <strong>AI-corrected</strong> with the street it was read as, so it's never mistaken for an
        exact match.
      </p>
      <p>
        <strong>This retry only runs for signed-in requests</strong>, because it costs money to run:
      </p>
      <ul>
        <li>
          <strong>Geocode page:</strong> open <strong>"Use your account"</strong> under the Geocode
          button and enter your account email and service key. They're remembered in your browser
          until you clear them.
        </li>
        <li>
          <strong>Batch geocoding:</strong> automatic on every paid run. Every row that isn't found
          gets one retry.
        </li>
        <li>
          <strong>API:</strong> include <code>email</code> and <code>serviceKey</code> in the{' '}
          <code>/geocode</code> request body.
        </li>
      </ul>
      <p className="text-muted" style={{ fontSize: 13 }}>
        A rescued address costs the same as any other found address; the retry itself is free. Each
        account gets up to 50 retries a day on single lookups, and up to 1,000 a day in batch runs
        (at most 200 per run). Past those limits, an address that isn't found as written simply
        isn't found.
      </p>

      <h2>Street aliases (a.k.a. names)</h2>
      <p>
        Many streets go by more than one name — a numbered route that's also known by a local name,
        for example. Every known alias for a street is kept alongside its primary name, so a query
        using any alias resolves to the same segments and the same coordinates as the primary name
        would.
      </p>

      <h2>Reverse geocoding: coordinates → address</h2>
      <p>
        Reverse geocoding runs the same logic backwards: find the street segment closest to the
        coordinate you provide, work out which side of that segment's direction of travel the point
        falls on, and interpolate a house number from how far along the segment the point sits — then
        round that number to match the numbering on that side of that segment (odd or even).
      </p>

      <h2>Batch geocoding</h2>
      <p>
        Batch jobs process a plain-text file of addresses (one per line, no cap on count), running the
        same forward-geocoding logic on every line independently — one bad address doesn't stop the
        rest of the batch. Results can be downloaded as a ZIP. Every batch run needs your account email
        and service key, and uses one address from your plan for every line, whether or not it's
        found. In return, lines that aren't found get the AI-assisted retry at no extra cost.
      </p>
      <p>
        If your file's first line is a header like <code>id,address</code> (or <code>customer_id</code>,
        <code>record id</code>, <code>uuid</code>, and similar), Batch geocoding notices and asks whether
        to use that column to identify each row in your results — handy for matching a result back to
        your own records. If your file has no ID column at all, it offers to add a simple sequential one
        (1, 2, 3, ...) instead, for the same reason. Either way, nothing is applied without asking first.
      </p>

      <h2>Plan &amp; quota</h2>
      <p>
        Usage is tracked per account email against a monthly tier, which resets on the 1st of each
        calendar month. A batch run that would exceed what's left is rejected up front, before any
        addresses are processed. A signed-in single lookup uses one address only when it's found;
        one that isn't found costs nothing.
      </p>

      <h2>Calling the API directly</h2>
      <p>
        Everything above is also available as a plain REST API — see <a href="#/api-docs">API Docs</a>{' '}
        for all five endpoints, with real request/response examples. Single lookups work without an
        account, up to a modest rate limit (but without the AI-assisted retry); batch jobs need a
        service key from a paid plan.
      </p>
    </>
  );
}

function RoadAlertsHelp() {
  return (
    <>
      <h1 style={{ marginTop: 0 }}>How Road Alerts works</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Live traffic hazards near you, spoken aloud as you approach them.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        <strong>💡 Coverage:</strong> Maine, New Hampshire, and Vermont, sourced from New England
        511 in real time. Free while it's in testing — register with just an email, no payment.
      </div>

      <h2>How a hazard gets to you</h2>
      <div className="plate" style={{ marginBottom: 'var(--space-2)', padding: 'var(--space-4)' }}>
        <RoadAlertsDiagram />
      </div>

      <h2>Severity tiers</h2>
      <p>Every hazard is placed into one of four tiers, which controls how it's delivered:</p>
      <ol>
        <li>
          <strong>Serious</strong> — spoken automatically with an alarm. A major accident, a road
          closure, a severe weather warning.
        </li>
        <li>
          <strong>Need to know</strong> — spoken automatically, no alarm. A meaningful delay,
          construction, a weather advisory.
        </li>
        <li>
          <strong>Proximity</strong> — spoken briefly, lower urgency. A speed camera, a school
          zone, a sharp curve.
        </li>
        <li>
          <strong>Fun to know</strong> — never interrupts; visual only, or spoken if you ask.
        </li>
      </ol>
      <p>
        When the source data is ambiguous, an alert defaults to "Need to know" rather than staying
        silent — a missed real hazard costs more than one extra alert.
      </p>

      <h2>Hazard type icons</h2>
      <p>
        Each alert shows an icon for what kind of hazard it is — 🧪 hazardous material, 🚨 accident,
        🚧 construction, ⛔ closure, 🚗 congestion, 🌧️ weather, or ⚠️ for anything else — so you can
        tell what's ahead at a glance, without reading the full description.
      </p>

      <h2>Map and alternate routes</h2>
      <p>
        Tap <strong>"Show on map"</strong> on any alert to see the hazard's exact location relative
        to you. Where a way around it exists, <strong>"Show a way around this"</strong> computes up
        to three alternate routes from our own street data and shows them on the map — hover (or
        tap, on a phone) an option to see just that route highlighted. Pick one and use{' '}
        <strong>"Navigate with Google Maps"</strong> to hand it off for real turn-by-turn directions.
      </p>
      <p className="text-muted" style={{ fontSize: 13 }}>
        These routes are an estimate: they follow one-way streets using OpenStreetMap data
        (© OpenStreetMap contributors) and avoid any highway or ramp whose direction isn't known,
        but there's no live traffic, and the point where a route
        rejoins your original road past the hazard is approximate, not exact.
      </p>

      <h2>Comments</h2>
      <p>
        Tap <strong>"Comments"</strong> on an alert to read or add notes from other drivers about
        that same stretch of road.
      </p>

      <h2>Saving an alert for later</h2>
      <p>
        Right after an alert is spoken, say <strong>"save this"</strong> (or "keep this"/"email
        this") to have that specific alert emailed to you. Turn on the daily email digest in
        Settings to get a single recap of everything you saved that day, instead of one email per
        alert.
      </p>
    </>
  );
}
