import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import App from './App';

describe('App', () => {
  it('renders the nav and defaults to the Overview route', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: 'Geocode' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Real addresses, not just estimates' })).toBeInTheDocument();
  });
});
