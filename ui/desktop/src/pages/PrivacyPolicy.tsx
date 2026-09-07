export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Privacy Policy</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        Last updated {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}. What Meridian
        actually collects and does with it -- described plainly, matching how the service is really built rather
        than boilerplate that doesn't apply.
      </p>

      <h2>What Meridian is</h2>
      <p>
        Meridian is a geocoding service for Maine and New Hampshire, plus a Road Alerts feature covering live
        traffic hazards for Maine, New Hampshire, and Vermont. This policy covers the desktop web app, the mobile
        app, and the API behind both.
      </p>

      <h2>Information we collect</h2>
      <p>
        There's no signup or password anywhere in Meridian -- an account is just an email address plus a service
        key generated for it. What we collect depends on which feature you use:
      </p>
      <ul>
        <li>
          <strong>Account email and service key.</strong> Used to track your monthly Batch geocoding quota and,
          separately, to register for Road Alerts. Your service key is generated once and never re-sent in
          plaintext except by email at the time it's created -- there's no account-recovery flow, so losing it
          means registering again.
        </li>
        <li>
          <strong>Addresses and coordinates you submit for geocoding.</strong> Processed to return a result.
          Single Geocode/Reverse geocode lookups aren't logged or stored beyond serving that one request.
        </li>
        <li>
          <strong>Batch file contents.</strong> Processed to produce your results, not retained afterward.
        </li>
        <li>
          <strong>Road Alerts location data.</strong> While you have Road Alerts actively watching your position,
          the app periodically reports your location (roughly every 3 minutes) to build a model of routes you
          drive routinely, so hazards on your own regular roads can be flagged more usefully. Your trip's starting
          point and ending point are never recorded, by design. A location only becomes a stored "weighted point"
          once you've actually passed through it several times within about a week -- a single trip through
          somewhere doesn't get remembered. Any weighted point you stop revisiting is automatically deleted after
          180 days.
        </li>
        <li>
          <strong>Feedback you submit.</strong> Through the Help page's feedback form, including your email if
          you provide one so we can reply. Feedback comments are automatically deleted after 90 days.
        </li>
        <li>
          <strong>Payment information.</strong> Handled entirely by PayPal at checkout -- Meridian never receives
          or stores your card number, PayPal password, or other payment credentials, only confirmation that a
          purchase succeeded.
        </li>
        <li>
          <strong>Local device storage.</strong> Your Road Alerts service key is remembered in your browser's (or
          the mobile app's) local storage so you're not re-entering it every visit. This stays on your own device
          -- it isn't something we receive or can see.
        </li>
      </ul>

      <h2>How we use this information</h2>
      <p>
        To provide the geocoding and Road Alerts service itself, enforce Batch geocoding's monthly quota, respond
        to feedback you send us, and email your service key after a purchase. We don't sell personal information,
        and we don't use it for advertising -- there isn't any advertising in Meridian.
      </p>

      <h2>Third-party services we rely on</h2>
      <p>Meridian is built on public data and a small number of third-party services, each used only for its specific purpose:</p>
      <ul>
        <li><strong>PayPal</strong> -- processes payments for additional Batch geocoding quota.</li>
        <li><strong>Resend</strong> -- delivers the transactional emails Meridian sends (service key delivery, etc.).</li>
        <li><strong>OpenStreetMap (Nominatim and Overpass)</strong> -- powers the Find Places search.</li>
        <li><strong>New England 511</strong> -- the source of Road Alerts' live traffic hazard data.</li>
        <li>
          <strong>US Census TIGER/Line and the Maine Office of GIS's E911 address data</strong> -- the public
          street and address data Meridian's own geocoding is built on. This is data about roads and addresses,
          not about you.
        </li>
      </ul>

      <h2>Data retention</h2>
      <p>
        Account and quota records are kept for as long as your account is active. Road Alerts weighted points are
        deleted automatically after 180 days without a new visit to that location. Feedback is deleted
        automatically after 90 days. If you'd like your account data removed sooner, contact us (see below).
      </p>

      <h2>Your choices</h2>
      <p>
        Road Alerts location sharing only happens while you've pressed Start and the app is actively watching --
        press Stop, or simply don't register for Road Alerts, and none of this location data is ever collected.
        You can request that we delete your account's data at any time.
      </p>

      <h2>Children's privacy</h2>
      <p>Meridian isn't directed at children under 13, and we don't knowingly collect information from them.</p>

      <h2>Changes to this policy</h2>
      <p>
        If how we handle your information changes in a meaningful way, we'll update this page and change the
        "last updated" date above.
      </p>

      <h2>Contact us</h2>
      <p>
        Questions about this policy or your data can be sent through the feedback form on the <a href="#/help">Help</a> page.
      </p>
    </div>
  );
}
