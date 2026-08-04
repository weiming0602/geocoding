export default function Help() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 4 }}>How Meridian geocodes an address</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        A short guide to what happens when you look up, reverse-geocode, or batch-process addresses.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        <strong>Coverage:</strong> Maine and New Hampshire, by design. Meridian isn't trying to
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

      <h2>Plan &amp; quota</h2>
      <p>
        Usage is tracked per account email against a monthly request tier. Quota resets on the 1st of
        each calendar month; an email-delivery request that would exceed the remaining quota is
        rejected up front, before any addresses are processed.
      </p>
    </div>
  );
}
