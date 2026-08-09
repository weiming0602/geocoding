import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { buildAddressLine, guessRole, isGeocodableAddressLine, type ColumnRole } from './ImportAddresses';

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
