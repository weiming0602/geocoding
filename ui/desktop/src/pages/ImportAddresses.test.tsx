import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import * as XLSX from 'xlsx';
import { describe, expect, it, vi } from 'vitest';

import ImportAddresses, { buildAddressLine, guessRole, isGeocodableAddressLine, type ColumnRole } from './ImportAddresses';
import Batch from './Batch';
import { ImportAddressesStateProvider } from '../state/ImportAddressesState';

// jsdom has no real WebGL2, which a real maplibre-gl Map requires -- any
// test that drives a genuinely successful Batch result with coordinates
// renders BatchMapView, which would otherwise throw during setup (and
// again on unmount, since the map never finished initializing). Stubbed
// with harmless no-ops; nothing here asserts on the map itself.
vi.mock('maplibre-gl', () => {
  class FakeMap {
    on() {
      return this;
    }
    addControl() {
      return this;
    }
    addSource() {
      return this;
    }
    addLayer() {
      return this;
    }
    getSource() {
      return { setData() {} };
    }
    getCanvas() {
      return { style: {} };
    }
    remove() {}
    resize() {}
    fitBounds() {}
    setCenter() {}
    setZoom() {}
    getZoom() {
      return 10;
    }
  }
  class FakePopup {
    setLngLat() {
      return this;
    }
    setText() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  class FakeLngLatBounds {
    extend() {
      return this;
    }
  }
  return { Map: FakeMap, NavigationControl: class {}, Popup: FakePopup, GeoJSONSource: class {}, LngLatBounds: FakeLngLatBounds };
});

describe('guessRole', () => {
  it('recognizes common header spellings for each role', () => {
    expect(guessRole('House Number')).toBe('streetNumber');
    expect(guessRole('Street Number')).toBe('streetNumber');
    expect(guessRole('Address')).toBe('streetFull');
    expect(guessRole('Street')).toBe('streetName');
    expect(guessRole('City')).toBe('city');
    expect(guessRole('State')).toBe('state');
    expect(guessRole('Zip')).toBe('zip');
    expect(guessRole('Postal Code')).toBe('zip');
    expect(guessRole('Notes')).toBe('ignore');
  });

  it('recognizes common ID/primary-key header spellings', () => {
    expect(guessRole('ID')).toBe('id');
    expect(guessRole('Record ID')).toBe('id');
    expect(guessRole('Customer ID')).toBe('id');
    expect(guessRole('Primary Key')).toBe('id');
    expect(guessRole('UUID')).toBe('id');
    expect(guessRole('Ref')).toBe('id');
    expect(guessRole('Reference No')).toBe('id');
  });
});

describe('buildAddressLine', () => {
  it('combines separate street-number and street-name columns', () => {
    const mapping: Record<number, ColumnRole> = {
      0: 'streetNumber',
      1: 'streetName',
      2: 'city',
      3: 'state',
      4: 'zip',
    };
    const row = ['91', 'Chestnut St', 'Portland', 'ME', '04101'];
    expect(buildAddressLine(row, mapping)).toBe('91 Chestnut St, Portland, ME 04101');
  });

  it('prefers a combined streetFull column over separate number/name columns', () => {
    const mapping: Record<number, ColumnRole> = { 0: 'streetFull', 1: 'city', 2: 'zip' };
    const row = ['91 Chestnut St', 'Portland', '04101'];
    expect(buildAddressLine(row, mapping)).toBe('91 Chestnut St, Portland 04101');
  });

  it('omits city/state gracefully when only a ZIP is mapped', () => {
    const mapping: Record<number, ColumnRole> = { 0: 'streetFull', 1: 'zip' };
    const row = ['91 Chestnut St', '04101'];
    expect(buildAddressLine(row, mapping)).toBe('91 Chestnut St 04101');
  });
});

describe('isGeocodableAddressLine', () => {
  it('requires a leading street number and a 5-digit ZIP', () => {
    expect(isGeocodableAddressLine('91 Chestnut St, Portland, ME 04101')).toBe(true);
    expect(isGeocodableAddressLine('Chestnut St, Portland, ME 04101')).toBe(false); // no number
    expect(isGeocodableAddressLine('91 Chestnut St, Portland, ME')).toBe(false); // no ZIP
    expect(isGeocodableAddressLine('')).toBe(false);
  });
});

describe('SheetJS round trip (the actual file-parsing path)', () => {
  it('parses a CSV with a header row into the same shape the upload handler expects', () => {
    const csv = [
      'House Number,Street,City,State,Zip',
      '91,Chestnut St,Portland,ME,04101',
      ',Missing Number Rd,Bath,ME,04530',
    ].join('\n');
    const workbook = XLSX.read(csv, { type: 'string' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][];
    const rows = raw.map((r) => r.map((c) => String(c ?? '').trim()));

    expect(rows[0]).toEqual(['House Number', 'Street', 'City', 'State', 'Zip']);
    expect(rows[1]).toEqual(['91', 'Chestnut St', 'Portland', 'ME', '04101']);

    const mapping: Record<number, ColumnRole> = {
      0: 'streetNumber',
      1: 'streetName',
      2: 'city',
      3: 'state',
      4: 'zip',
    };
    const line1 = buildAddressLine(rows[1], mapping);
    expect(line1).toBe('91 Chestnut St, Portland, ME 04101');
    expect(isGeocodableAddressLine(line1)).toBe(true);

    const line2 = buildAddressLine(rows[2], mapping);
    expect(isGeocodableAddressLine(line2)).toBe(false); // missing house number
  });
});

describe('ImportAddresses component (upload -> map -> preview -> filter)', () => {
  const csv = [
    'House Number,Street Name,City,State,Zip Code',
    '91,Chestnut St,Portland,ME,04101',
    '20,Custom House Wharf,Portland,ME,04101',
    '13,Deerfield Dr,Brunswick,ME,04011',
    ',Congress St,Portland,ME,04101', // missing number -- flagged
    '43,Middle St,Portland,ME,', // missing zip -- flagged
  ].join('\n');

  async function uploadAndPreview() {
    const { container } = render(
      <MemoryRouter initialEntries={['/import-addresses']}>
        <ImportAddressesStateProvider>
          <Routes>
            <Route path="/import-addresses" element={<ImportAddresses />} />
            <Route path="/batch" element={<Batch />} />
          </Routes>
        </ImportAddressesStateProvider>
      </MemoryRouter>
    );
    const file = new File([csv], 'addresses.csv', { type: 'text/csv' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => screen.getByText('Map your columns'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview addresses' }));
    await waitFor(() => screen.getByText(/row.*selected/));
    return container;
  }

  it('auto-maps columns, builds address lines, and flags incomplete rows by default', async () => {
    await uploadAndPreview();

    expect(screen.getByText('91 Chestnut St, Portland, ME 04101')).toBeInTheDocument();
    expect(screen.getByText('13 Deerfield Dr, Brunswick, ME 04011')).toBeInTheDocument();
    expect(screen.getByText('3 of 5 rows selected')).toBeInTheDocument();
    expect(screen.getAllByText('missing number or ZIP')).toHaveLength(2);
  });

  it('filters rows by a column value (City) and by status', async () => {
    const container = await uploadAndPreview();
    const table = () => within(container.querySelector('table') as HTMLTableElement);

    const citySelect = screen.getByLabelText('City') as HTMLSelectElement;
    fireEvent.change(citySelect, { target: { value: 'Brunswick' } });
    expect(screen.getByText(/Showing 1 of 5 rows/)).toBeInTheDocument();
    expect(table().getByText('13 Deerfield Dr, Brunswick, ME 04011')).toBeInTheDocument();
    expect(table().queryByText(/Chestnut St/)).not.toBeInTheDocument();

    fireEvent.change(citySelect, { target: { value: '__all__' } });
    const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'flagged' } });
    expect(screen.getByText(/Showing 2 of 5 rows/)).toBeInTheDocument();
    expect(screen.getAllByText('missing number or ZIP')).toHaveLength(2);
  });

  it('"Select all matching" / "Deselect all matching" only affect the currently filtered rows', async () => {
    const container = await uploadAndPreview();
    expect(screen.getByText('3 of 5 rows selected')).toBeInTheDocument();

    const citySelect = screen.getByLabelText('City') as HTMLSelectElement;
    // 4 Portland rows (2 already checked, 2 flagged/unchecked); Deerfield
    // (Brunswick, already checked) is the only row NOT shown by this filter.
    fireEvent.change(citySelect, { target: { value: 'Portland' } });

    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    // All 4 Portland rows now checked, plus Deerfield (untouched, was already checked) = 5 of 5.
    expect(screen.getByText('5 of 5 rows selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Deselect all matching' }));
    // Deselects the 4 Portland rows; Deerfield (not shown, untouched) stays checked.
    expect(screen.getByText('1 of 5 rows selected')).toBeInTheDocument();

    // Clearing the filter should reveal all 5 rows again, still 1 selected.
    fireEvent.change(citySelect, { target: { value: '__all__' } });
    const table = within(container.querySelector('table') as HTMLTableElement);
    expect(table.getAllByRole('row')).toHaveLength(6); // 5 data rows + header
  });

  it('"Send to Batch geocode" navigates to Batch with the selected rows pre-filled, skipping download', async () => {
    await uploadAndPreview();
    // Default selection: the 3 valid rows (Chestnut, Custom House Wharf, Deerfield).
    fireEvent.click(screen.getByRole('button', { name: 'Send to Batch geocode' }));

    // Batch.tsx renders the picked file's name in place of the file-path input.
    const filePathInput = await screen.findByPlaceholderText('C:\\software\\database\\addresses.txt');
    expect(filePathInput).toHaveValue('imported-addresses.txt');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument(); // only shown when pickedFile is set
    expect(screen.getByRole('link', { name: '← Back to Import Addresses' })).toBeInTheDocument();
  });

  it('going to Batch and back via "Back to Import Addresses" preserves the wizard state', async () => {
    await uploadAndPreview();

    // Narrow with a filter before forwarding, so we have something non-default to check survives.
    const citySelect = screen.getByLabelText('City') as HTMLSelectElement;
    fireEvent.change(citySelect, { target: { value: 'Brunswick' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Batch geocode' }));
    await screen.findByRole('link', { name: '← Back to Import Addresses' });

    fireEvent.click(screen.getByRole('link', { name: '← Back to Import Addresses' }));

    // Still on the preview step (not reset to the upload step), same
    // selection count, and the City filter is still set to Brunswick --
    // proof the wizard state lived in a context above the route, not
    // local state that unmounted when Batch's route took over.
    expect(screen.getByText('3 of 5 rows selected')).toBeInTheDocument();
    expect(screen.getByLabelText('City')).toHaveValue('Brunswick');
    expect(screen.getByText(/Showing 1 of 5 rows/)).toBeInTheDocument();
  });
});

describe('ImportAddresses ID column (forwarded through to Batch results)', () => {
  const csvWithId = [
    'Customer ID,House Number,Street Name,City,State,Zip Code',
    'CUST-1,91,Chestnut St,Portland,ME,04101',
    'CUST-2,13,Deerfield Dr,Brunswick,ME,04011',
  ].join('\n');

  it('auto-maps an ID column, shows it in preview, and carries it through Batch results + CSV export', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request) => {
      // Batch.tsx's own POST to the local server -- this test isn't
      // exercising Overpass/Nominatim, so any /geocode/batch call is
      // the one to fake.
      if (String(url).includes('/geocode/batch')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                address: '91 Chestnut St, Portland, ME 04101',
                success: true,
                source: 'interpolation',
                rangeSide: 'left',
                coordinates: { latitude: 43.66, longitude: -70.26 },
              },
              {
                address: '13 Deerfield Dr, Brunswick, ME 04011',
                success: true,
                source: 'address_point',
                coordinates: { latitude: 43.92, longitude: -69.89 },
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/import-addresses']}>
          <ImportAddressesStateProvider>
            <Routes>
              <Route path="/import-addresses" element={<ImportAddresses />} />
              <Route path="/batch" element={<Batch />} />
            </Routes>
          </ImportAddressesStateProvider>
        </MemoryRouter>
      );
      const file = new File([csvWithId], 'addresses.csv', { type: 'text/csv' });
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [file] } });
      await waitFor(() => screen.getByText('Map your columns'));

      // Auto-mapped as "Primary key / ID" from the "Customer ID" header.
      const mappingTable = within(container.querySelector('table') as HTMLTableElement);
      expect(mappingTable.getByText('Customer ID').closest('tr')?.textContent).toContain('Primary key / ID');

      fireEvent.click(screen.getByRole('button', { name: 'Preview addresses' }));
      await waitFor(() => screen.getByText(/row.*selected/));
      // "Customer ID" also becomes a filter dropdown (only 2 distinct
      // values), so scope to the actual preview table -- "CUST-1" is
      // also a <option> in that filter.
      const previewTable = within(container.querySelector('table') as HTMLTableElement);
      expect(previewTable.getByText('CUST-1')).toBeInTheDocument();
      expect(previewTable.getByText('CUST-2')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Send to Batch geocode' }));
      await screen.findByPlaceholderText('C:\\software\\database\\addresses.txt');

      fireEvent.click(screen.getByRole('button', { name: 'Batch geocode' }));
      await screen.findByText('2 of 2 succeeded');

      const resultsTable = within(screen.getAllByRole('table').slice(-1)[0]);
      expect(resultsTable.getByText('CUST-1')).toBeInTheDocument();
      expect(resultsTable.getByText('CUST-2')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download results as CSV (with ID)' })).toBeInTheDocument();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
