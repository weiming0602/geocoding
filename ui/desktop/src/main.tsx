import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './styles.css';
import { setApiBaseUrl } from '../../shared/api/client';

// Unset in dev (falls back to DEFAULT_API_BASE_URL's own localhost:3001);
// a production build sets this to the deployed API's real origin.
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
if (apiBaseUrl) setApiBaseUrl(apiBaseUrl);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
