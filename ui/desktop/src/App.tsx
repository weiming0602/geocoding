import { NavLink, Route, HashRouter as Router, Routes } from 'react-router';

import Batch from './pages/Batch';
import Geocode from './pages/Geocode';
import Overview from './pages/Overview';
import PlanQuota from './pages/PlanQuota';
import ReverseGeocode from './pages/ReverseGeocode';

const NAV_LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/geocode', label: 'Geocode' },
  { to: '/reverse-geocode', label: 'Reverse geocode' },
  { to: '/batch', label: 'Batch' },
  { to: '/plan-quota', label: 'Plan & quota' },
];

export default function App() {
  return (
    <Router>
      <nav>
        {NAV_LINKS.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.end}>
            {link.label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/geocode" element={<Geocode />} />
          <Route path="/reverse-geocode" element={<ReverseGeocode />} />
          <Route path="/batch" element={<Batch />} />
          <Route path="/plan-quota" element={<PlanQuota />} />
        </Routes>
      </main>
    </Router>
  );
}
