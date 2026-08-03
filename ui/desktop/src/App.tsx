import { HashRouter as Router, Route, Routes } from 'react-router';

import Layout from './components/Layout';
import Batch from './pages/Batch';
import Geocode from './pages/Geocode';
import Help from './pages/Help';
import Overview from './pages/Overview';
import PlanQuota from './pages/PlanQuota';
import ReverseGeocode from './pages/ReverseGeocode';
import { RecentLookupsProvider } from './state/RecentLookups';

export default function App() {
  return (
    <Router>
      <RecentLookupsProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/geocode" element={<Geocode />} />
            <Route path="/reverse-geocode" element={<ReverseGeocode />} />
            <Route path="/batch" element={<Batch />} />
            <Route path="/plan-quota" element={<PlanQuota />} />
            <Route path="/help" element={<Help />} />
          </Routes>
        </Layout>
      </RecentLookupsProvider>
    </Router>
  );
}
