export default function TermsOfUse() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Terms of Use</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Last updated {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}. The basics of
        using Meridian, in plain language.
      </p>

      <h2>1. Acceptance of these terms</h2>
      <p>
        By using Meridian's desktop app, mobile app, or API, you agree to these terms. If you don't agree, please
        don't use the service.
      </p>

      <h2>2. What Meridian is</h2>
      <p>
        Meridian is a geocoding service purpose-built for Maine and New Hampshire, plus a Road Alerts feature
        covering live traffic hazards for Maine, New Hampshire, and Vermont. Road Alerts is currently free while
        it's being tested; we'll give notice before that ever changes.
      </p>

      <h2>3. Accounts and service keys</h2>
      <p>
        There's no password anywhere in Meridian -- an account is an email address paired with a service key
        generated for it. You're responsible for keeping your service key confidential; anyone who has it can
        spend your account's quota. There's no account-recovery flow for a lost key -- registering again with the
        same email for Road Alerts re-sends the existing key, but a lost Batch geocoding service key can't be
        recovered on its own.
      </p>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Attempt to circumvent Batch geocoding's quota limits or another account's service key.</li>
        <li>Use Meridian for any unlawful purpose, or in a way that could damage, disable, or overburden the service.</li>
        <li>Scrape, resell, or redistribute Meridian's underlying data (TIGER/Line, Maine E911, 511 hazard data) as a competing product, beyond the geocoded results you receive for your own use.</li>
      </ul>

      <h2>5. Payments</h2>
      <p>
        Batch geocoding quota is sold in one-time packs at the prices shown on the <a href="#/pricing">Pricing</a>{' '}
        page at the time of purchase, processed by PayPal. Purchases are generally final; if you believe you were
        charged in error, contact us and we'll look into it.
      </p>

      <h2>6. Service availability and accuracy</h2>
      <p>
        Meridian's geocoding is built on public data (US Census TIGER/Line, Maine's E911 address points) and,
        where a real surveyed address point isn't available, mathematical interpolation along a street. Road
        Alerts hazard data comes from New England 511, provided as-is. Neither is guaranteed to be complete,
        current, or error-free, and Meridian is provided "as is" without warranties of any kind, to the extent
        permitted by law.
      </p>

      <h2>7. Limitation of liability</h2>
      <p>
        To the extent permitted by law, Meridian and its operator aren't liable for indirect, incidental, or
        consequential damages arising from your use of the service, including reliance on a geocoded address or
        a Road Alerts hazard notice while driving. Always use your own judgment behind the wheel.
      </p>

      <h2>8. Changes</h2>
      <p>
        We may update these terms or the service itself as Meridian develops. Meaningful changes to these terms
        will be reflected here with an updated "last updated" date.
      </p>

      <h2>9. Governing law</h2>
      <p>These terms are governed by the laws of the State of Maine, USA, without regard to its conflict-of-law principles.</p>

      <h2>10. Contact us</h2>
      <p>
        Questions about these terms can be sent through the feedback form on the <a href="#/help">Help</a> page.
      </p>
    </div>
  );
}
