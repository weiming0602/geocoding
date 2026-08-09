import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import ImportAddresses, { buildAddressLine, guessRole, isGeocodableAddressLine, type ColumnRole } from './ImportAddresses';
import Batch from './Batch';

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
        <Routes>
          <Route path="/import-addresses" element={<ImportAddresses />} />
          <Route path="/batch" element={<Batch />} />
        </Routes>
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

  it('"Select all shown" / "Deselect all shown" only affect the currently filtered rows', async () => {
    const container = await uploadAndPreview();
    expect(screen.getByText('3 of 5 rows selected')).toBeInTheDocument();

    const citySelect = screen.getByLabelText('City') as HTMLSelectElement;
    // 4 Portland rows (2 already checked, 2 flagged/unchecked); Deerfield
    // (Brunswick, already checked) is the only row NOT shown by this filter.
    fireEvent.change(citySelect, { target: { value: 'Portland' } });

    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
    // All 4 Portland rows now checked, plus Deerfield (untouched, was already checked) = 5 of 5.
    expect(screen.getByText('5 of 5 rows selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Deselect all shown' }));
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
  });
});
