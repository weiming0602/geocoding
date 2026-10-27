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
      <p>
        Every street is stored as a series of segments. Each segment records an address range on its{' '}
        <strong>left</strong> side and a separate range on its <strong>right</strong> side — because
        the two sides of a street are usually numbered differently (one side odd, one side even).
      </p>
      <p>When you geocode an address:</p>
      <ol>
        <li>Look up the street by name and ZIP code, and find every segment that could match.</li>
        <li>
          Check the house number's parity — <strong>odd numbers are treated as the left side</strong>{' '}
          of the street, <strong>even numbers as the right side</strong> — and pick the segment whose
          range on that side actually contains the number.
        </li>
        <li>
          Interpolate a point proportionally along that segment: if the range runs 1–99 and you asked
          for 91, the point sits about 91% of the way from the "1" end toward the "99" end.
        </li>
        <li>
          Offset the point slightly off the street centerline, onto the correct side, so the pin lands
          on the building's side of the road rather than in the middle of the street.
        </li>
      </ol>

      <div className="plate" style={{ margin: 'var(--space-4) 0' }}>
        <img src="/help/chestnut-91-left.png" style={{ display: 'block', width: '100%' }} />
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8 }}>
        Chestnut Rd runs from house number 1 to 99. <strong>91 is odd</strong>, so it's placed on the{' '}
        <strong>left</strong> side of the street, about 91% of the way toward the 99 end — matching
        the marker near "end num: 99."
      </p>

      <div className="plate" style={{ margin: 'var(--space-4) 0' }}>
        <img src="/help/sawyer-26-right.png" style={{ display: 'block', width: '100%' }} />
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8 }}>
        Sawyer Brook Rd runs from house number 2 to 98. <strong>26 is even</strong>, so it's placed on
        the <strong>right</strong> side of the street, close to the "start num: 2" end — since 26 is
        near the low end of the range.
      </p>

      <h2>A typo isn't a dead end</h2>
      <p>
        A real-world address rarely arrives perfectly formed, so Meridian handles a few kinds of
        mistakes differently depending on how much they actually confuse a search:
      </p>
      <p>
        <strong>Misspelled street names</strong> are the case Meridian can genuinely fix. When an
        address fails to match anything on the first try, an authenticated request falls back to a
        second pass: Meridian looks up real street names near the address's ZIP code (or town, if
        no ZIP was given), hands a short list of those real candidates to an AI model, and asks it
        to pick whichever one the misspelled input was most likely trying to say — "Pequawket
        Trl" for a query that came in as "Peqwket Trl," for example. The model is only ever allowed
        to choose from streets that already exist in Meridian's data or say none of them fit — it's
        never allowed to invent a street that isn't really there. If it picks one, Meridian re-runs
        the normal geocoding match against that real street and returns a genuine result, clearly
        marked as AI-assisted so it's never confused with an exact match.
      </p>
      <p>
        <strong>Wrong ZIP codes</strong> are a harder case, and honestly not well-handled yet: that
        same fallback search is scoped to the ZIP code the request gave, on the assumption that the
        ZIP is reliable even when the street name isn't. If the ZIP itself is wrong, the candidate
        list comes from the wrong neighborhood entirely, so the AI model has nothing correct to pick
        from. A wrong ZIP is the one mistake here most likely to still end in a failed match.
      </p>
      <p>
        <strong>Wrong town names</strong> matter much less than you'd expect, because Meridian's
        primary matching path doesn't actually key off the town at all — it matches by ZIP code and
        street name, so a correct ZIP paired with the wrong town name on the same line still
        geocodes normally. Town only comes into play as a fallback scope for the AI-assisted search
        above when no ZIP is given at all, so an incorrect town mainly matters for addresses missing
        a ZIP in the first place.
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
        round that number to the correct parity (odd for the left side, even for the right).
      </p>

      <h2>Batch geocoding</h2>
      <p>
        Batch jobs process a plain-text file of addresses (one per line, no cap on count), running the
        same forward-geocoding logic on every line independently — one bad address doesn't stop the
        rest of the batch. Results can be downloaded as a ZIP. Note: quota is only checked and recorded
        for email delivery, not for a plain batch run or ZIP download.
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
        Usage is tracked per account email against a monthly request tier. Quota resets on the 1st of
        each calendar month; an email-delivery request that would exceed the remaining quota is
        rejected up front, before any addresses are processed.
      </p>

      <h2>Calling the API directly</h2>
      <p>
        Everything above is also available as a plain REST API — see <a href="#/api-docs">API Docs</a>{' '}
        for all five endpoints, with real request/response examples. Single lookups work without an
        account, up to a modest rate limit; batch jobs still need a service key from a paid plan.
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
