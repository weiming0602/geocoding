import type { ReactElement } from 'react';
import { HashRouter as Router, Route, Routes, useLocation } from 'react-router';

import ExternalRedirect from './components/ExternalRedirect';
import Layout from './components/Layout';
import ApiDocs from './pages/ApiDocs';
import Batch from './pages/Batch';
import Checkout from './pages/Checkout';
import FindPlaces from './pages/FindPlaces';
import Geocode from './pages/Geocode';
import Help from './pages/Help';
import ImportAddresses from './pages/ImportAddresses';
import Overview from './pages/Overview';
import OwnerDashboard from './pages/OwnerDashboard';
import PlanQuota from './pages/PlanQuota';
import Pricing from './pages/Pricing';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Progress from './pages/Progress';
import ReverseGeocode from './pages/ReverseGeocode';
import RoadAlerts from './pages/RoadAlerts';
import RoadAlertsAlarmTest from './pages/RoadAlertsAlarmTest';
import RoadAlertsHomeBoard from './pages/RoadAlertsHomeBoard';
import RoadAlertsSandbox from './pages/RoadAlertsSandbox';
import RoadAlertsTest from './pages/RoadAlertsTest';
import SiteMap from './pages/SiteMap';
import TermsOfUse from './pages/TermsOfUse';
import ServiceWorkerNavigation from './components/ServiceWorkerNavigation';
import { ImportAddressesStateProvider } from './state/ImportAddressesState';
import { RecentLookupsProvider } from './state/RecentLookups';
import { GEOCODING_SITE_URL, ROAD_ALERTS_MOVED, ROAD_ALERTS_SITE_URL, SITE, siteUrl } from './siteConfig';

const ROAD_ALERTS_PAGES: [string, ReactElement][] = [
  ['/road-alerts', <RoadAlerts />],
  ['/road-alerts-sandbox', <RoadAlertsSandbox />],
  ['/road-alert-test', <RoadAlertsTest />],
  ['/road-alerts-alarm-test', <RoadAlertsAlarmTest />],
  ['/road-alerts-home-board', <RoadAlertsHomeBoard />],
];

// Pages both sites keep: what Road Alerts' own help/legal links point to.
const SHARED_PAGES: [string, ReactElement][] = [
  ['/help', <Help />],
  ['/privacy', <PrivacyPolicy />],
  ['/terms', <TermsOfUse />],
];

/** The current hash path on the other site -- for old links to a page that now lives there. */
function MovedTo({ base, label }: { base: string; label: string }) {
  const location = useLocation();
  return <ExternalRedirect to={siteUrl(base, location.pathname + location.search)} label={label} />;
}

/** alerts.meridiangeocoding.com: Road Alerts is home; anything else belongs to the geocoding site. */
function RoadAlertsSiteRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RoadAlerts />} />
      {ROAD_ALERTS_PAGES.map(([path, page]) => (
        <Route key={path} path={path} element={page} />
      ))}
      {SHARED_PAGES.map(([path, page]) => (
        <Route key={path} path={path} element={page} />
      ))}
      <Route path="*" element={<MovedTo base={GEOCODING_SITE_URL} label="This page" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <Router>
      <ServiceWorkerNavigation />
      <RecentLookupsProvider>
        <ImportAddressesStateProvider>
          <Layout>
            {SITE === 'road-alerts' ? (
              <RoadAlertsSiteRoutes />
            ) : (
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/owner" element={<OwnerDashboard />} />
                <Route path="/geocode" element={<Geocode />} />
                <Route path="/reverse-geocode" element={<ReverseGeocode />} />
                <Route path="/find-places" element={<FindPlaces />} />
                {ROAD_ALERTS_PAGES.map(([path, page]) => (
                  <Route
                    key={path}
                    path={path}
                    element={ROAD_ALERTS_MOVED ? <MovedTo base={ROAD_ALERTS_SITE_URL} label="Road Alerts" /> : page}
                  />
                ))}
                <Route path="/import-addresses" element={<ImportAddresses />} />
                <Route path="/batch" element={<Batch />} />
                <Route path="/plan-quota" element={<PlanQuota />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/checkout" element={<Checkout />} />
                <Route path="/progress" element={<Progress />} />
                <Route path="/api-docs" element={<ApiDocs />} />
                <Route path="/help" element={<Help />} />
                <Route path="/privacy" element={<PrivacyPolicy />} />
                <Route path="/terms" element={<TermsOfUse />} />
                <Route path="/sitemap" element={<SiteMap />} />
              </Routes>
            )}
          </Layout>
        </ImportAddressesStateProvider>
      </RecentLookupsProvider>
    </Router>
  );
}
