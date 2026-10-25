import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RoadAlertsTabs, { resetSandboxAvailabilityForTests } from './RoadAlertsTabs';

function stubTestTools(tools: { testRoadSignals: boolean; testWeightedPoints: boolean } | 'unreachable') {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      tools === 'unreachable'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response(JSON.stringify(tools), { status: 200 }))
    )
  );
}

function renderTabs() {
  render(
    <MemoryRouter>
      <RoadAlertsTabs />
    </MemoryRouter>
  );
}

describe('RoadAlertsTabs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetSandboxAvailabilityForTests();
  });

  it('shows the Sandbox tab when the server has a test tool switched on', async () => {
    stubTestTools({ testRoadSignals: true, testWeightedPoints: false });
    renderTabs();
    expect(await screen.findByRole('link', { name: /sandbox/i })).toHaveAttribute('href', '/road-alerts-sandbox');
  });

  it('hides the Sandbox tab on a server with both test tools off (production)', async () => {
    stubTestTools({ testRoadSignals: false, testWeightedPoints: false });
    renderTabs();
    await screen.findByRole('link', { name: /raising alarm/i });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('link', { name: /sandbox/i })).toBeNull();
  });

  it('hides the Sandbox tab when the server cannot be reached', async () => {
    stubTestTools('unreachable');
    renderTabs();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('link', { name: /sandbox/i })).toBeNull();
    expect(screen.getByRole('link', { name: /road alerts/i })).toBeInTheDocument();
  });
});
