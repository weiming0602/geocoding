import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The same App, built as either site (see siteConfig.ts). siteConfig reads
// import.meta.env once at import time, so each test stubs the env, then
// imports a fresh App.
async function renderAppAt(hashPath: string, env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  window.location.hash = `#${hashPath}`;
  const { default: App } = await import('./App');
  render(<App />);
}

describe('site split', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.location.hash = '';
  });

  it('the Road Alerts site opens on Road Alerts, with its own nav and a link back to geocoding', async () => {
    await renderAppAt('/', { VITE_APP: 'road-alerts' });
    expect(document.querySelector('.nav-brand')).toHaveTextContent('Meridian Road Alerts');
    expect(screen.getByRole('link', { name: 'Geocoding ↗' })).toHaveAttribute('href', 'https://www.meridiangeocoding.com');
    expect(screen.queryByRole('link', { name: 'Batch' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Pricing' })).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'Road Alerts' }).length).toBeGreaterThan(0);
  });

  it('the Road Alerts site sends geocoding pages back to the geocoding site', async () => {
    await renderAppAt('/geocode', { VITE_APP: 'road-alerts', VITE_GEOCODING_URL: 'https://www.meridiangeocoding.com/' });
    expect(screen.getByRole('link', { name: 'https://www.meridiangeocoding.com/#/geocode' })).toHaveAttribute(
      'href',
      'https://www.meridiangeocoding.com/#/geocode'
    );
  });

  it('the geocoding site keeps serving Road Alerts itself until VITE_ROAD_ALERTS_URL is set', async () => {
    await renderAppAt('/road-alerts', {});
    const brand = document.querySelector('.nav-brand');
    expect(brand).toHaveTextContent(/^Meridian$/);
    const topNav = document.querySelector('nav.nav') as HTMLElement;
    expect(within(topNav).getByRole('link', { name: 'Road Alerts' })).toHaveAttribute('href', '#/road-alerts');
    expect(screen.queryByText(/has moved to/)).toBeNull();
  });

  it('once Road Alerts has moved, the geocoding site links and redirects there, keeping the page path', async () => {
    await renderAppAt('/road-alerts-home-board', { VITE_ROAD_ALERTS_URL: 'https://alerts.meridiangeocoding.com' });
    const topNav = document.querySelector('nav.nav') as HTMLElement;
    expect(within(topNav).getByRole('link', { name: 'Road Alerts ↗' })).toHaveAttribute('href', 'https://alerts.meridiangeocoding.com/#/');
    const moved = screen.getByText(/Road Alerts has moved to/);
    expect(within(moved).getByRole('link')).toHaveAttribute(
      'href',
      'https://alerts.meridiangeocoding.com/#/road-alerts-home-board'
    );
  });
});
