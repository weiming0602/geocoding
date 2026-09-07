import { HashRouter as Router, Route, Routes } from 'react-router';

import Layout from './components/Layout';
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
import RoadAlertsTest from './pages/RoadAlertsTest';
import SiteMap from './pages/SiteMap';
import TermsOfUse from './pages/TermsOfUse';
import { ImportAddressesStateProvider } from './state/ImportAddressesState';
import { RecentLookupsProvider } from './state/RecentLookups';

export default function App() {
  return (
    <Router>
      <RecentLookupsProvider>
        <ImportAddressesStateProvider>
          <Layout>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/owner" element={<OwnerDashboard />} />
              <Route path="/geocode" element={<Geocode />} />
              <Route path="/reverse-geocode" element={<ReverseGeocode />} />
              <Route path="/find-places" element={<FindPlaces />} />
              <Route path="/road-alerts" element={<RoadAlerts />} />
              <Route path="/road-alert-test" element={<RoadAlertsTest />} />
              <Route path="/import-addresses" element={<ImportAddresses />} />
              <Route path="/batch" element={<Batch />} />
              <Route path="/plan-quota" element={<PlanQuota />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/checkout" element={<Checkout />} />
              <Route path="/progress" element={<Progress />} />
              <Route path="/help" element={<Help />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/terms" element={<TermsOfUse />} />
              <Route path="/sitemap" element={<SiteMap />} />
            </Routes>
          </Layout>
        </ImportAddressesStateProvider>
      </RecentLookupsProvider>
    </Router>
  );
}
