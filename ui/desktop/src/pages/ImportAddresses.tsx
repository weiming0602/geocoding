import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import * as XLSX from 'xlsx';

export type ColumnRole = 'ignore' | 'streetFull' | 'streetNumber' | 'streetName' | 'city' | 'state' | 'zip';

const ROLE_OPTIONS: { value: ColumnRole; label: string }[] = [
  { value: 'ignore', label: 'Ignore this column' },
  { value: 'streetFull', label: 'Street (number + name together)' },
  { value: 'streetNumber', label: 'Street number' },
  { value: 'streetName', label: 'Street name' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'zip', label: 'ZIP code' },
];

// Best-guess mapping from a header cell's text -- the user confirms or
// fixes this on the mapping step, so a wrong guess costs one click, not
// a bad import. Order matters: streetNumber's pattern is checked before
// the broader streetFull/streetName ones so e.g. "Street Number" doesn't
// fall through to matching "street".
export function guessRole(header: string): ColumnRole {
  const h = header.toLowerCase().trim();
  if (/house\s*(no\.?|number)\b|street\s*(no\.?|number)\b|addr.*num|^(no|num|number)$/.test(h)) return 'streetNumber';
  if (/full.*addr|^address$|^address ?1$|street.*addr/.test(h)) return 'streetFull';
  if (/street.*name|^street$|^road$/.test(h)) return 'streetName';
  if (/city|town/.test(h)) return 'city';
  if (/state|province/.test(h)) return 'state';
  if (/zip|postal/.test(h)) return 'zip';
  return 'ignore';
}

// Shared by buildAddressLine (to assemble the address line) and the
// preview step's column filters (to list a mapped column's distinct
// values) -- one lookup, so both agree on which column a role points at.
export function getMappedValue(row: string[], mapping: Record<number, ColumnRole>, role: ColumnRole): string {
  const idx = Object.keys(mapping).find((i) => mapping[Number(i)] === role);
  return idx !== undefined ? (row[Number(idx)] ?? '').toString().trim() : '';
}

// Mirrors placesSearch.js's addressLineFromTags shape server-side:
// "<street>, <city>, <state> <zip>" with city/state omitted gracefully
// when blank -- kept in sync so imported rows and Overpass-found places
// produce the same address-line format.
export function buildAddressLine(row: string[], mapping: Record<number, ColumnRole>): string {
  const get = (role: ColumnRole) => getMappedValue(row, mapping, role);
  let street = get('streetFull');
  if (!street) {
    street = [get('streetNumber'), get('streetName')].filter(Boolean).join(' ');
  }
  const city = get('city');
  const state = get('state');
  const zip = get('zip');
  const cityState = [city, state].filter(Boolean).join(', ');
  const middle = cityState ? `, ${cityState}` : '';
  return `${street}${middle}${zip ? ` ${zip}` : ''}`.replace(/\s+/g, ' ').trim();
}

// Same leading-number / trailing-5-digit-ZIP rule geocoding-server's
// parseAddress.js enforces -- flagging it here means a row that won't
// geocode gets caught before download, not after a wasted Batch run.
export function isGeocodableAddressLine(line: string): boolean {
  return Boolean(line) && line.length <= 200 && /^\d+\b/.test(line) && /\b\d{5}\b/.test(line);
}

type Step = 'upload' | 'map' | 'preview';
type StatusFilter = 'all' | 'valid' | 'flagged';
const ALL = '__all__';

export default function ImportAddresses() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const [mapping, setMapping] = useState<Record<number, ColumnRole>>({});
  const [included, setIncluded] = useState<boolean[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Keyed by original column index, not role -- every column in the
  // uploaded file gets a filter, including ones ignored/unmapped for
  // the address itself (e.g. a "Region" or "Notes" column), since those
  // can still be useful for deciding which rows belong in the export.
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>({});
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChooseFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][];
      const asStrings = raw
        .map((r) => r.map((c) => (c === undefined || c === null ? '' : String(c).trim())))
        .filter((r) => r.some((c) => c !== ''));
      if (asStrings.length === 0) {
        setError("That file has no rows Meridian could read.");
        return;
      }
      // If every cell in the first row is purely numeric, it's almost
      // certainly a data row (e.g. house numbers), not a header.
      const looksLikeHeader = asStrings[0].some((c) => c !== '' && !/^\d+$/.test(c));
      const headerRow = looksLikeHeader ? asStrings[0] : asStrings[0].map((_, i) => `Column ${i + 1}`);
      const dataRows = looksLikeHeader ? asStrings.slice(1) : asStrings;

      const guessed: Record<number, ColumnRole> = {};
      headerRow.forEach((h, i) => {
        guessed[i] = guessRole(h);
      });

      setFileName(file.name);
      setHeaders(headerRow);
      setRows(dataRows);
      setHasHeaderRow(looksLikeHeader);
      setMapping(guessed);
      setStep('map');
    } catch (err) {
      setError(err instanceof Error ? `Could not read that file: ${err.message}` : 'Could not read that file.');
    }
  }, []);

  const previewRows = useMemo(
    () =>
      rows.map((row) => {
        const address = buildAddressLine(row, mapping);
        return { row, address, valid: isGeocodableAddressLine(address) };
      }),
    [rows, mapping]
  );

  const handleContinueToPreview = useCallback(() => {
    setIncluded(previewRows.map((r) => r.valid));
    setStatusFilter('all');
    setColumnFilters({});
    setSearch('');
    setStep('preview');
  }, [previewRows]);

  const includedCount = included.filter(Boolean).length;

  // A per-column filter dropdown is only useful for columns with a
  // handful of repeating values (e.g. City, Region, a status flag) --
  // one with as many distinct values as rows (the address/name columns
  // themselves) would just be a duplicate of the search box, so those
  // are left out.
  const filterableColumns = useMemo(() => {
    return headers
      .map((header, i) => {
        const values = new Set(rows.map((r) => r[i]).filter(Boolean));
        return { index: i, header, values: [...values].sort() };
      })
      .filter((c) => c.values.length > 1 && c.values.length <= 50);
  }, [headers, rows]);

  const visibleIndices = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return previewRows.reduce<number[]>((acc, r, i) => {
      if (statusFilter === 'valid' && !r.valid) return acc;
      if (statusFilter === 'flagged' && r.valid) return acc;
      for (const [colIndex, value] of Object.entries(columnFilters)) {
        if (value !== ALL && r.row[Number(colIndex)] !== value) return acc;
      }
      if (searchLower && !r.address.toLowerCase().includes(searchLower)) return acc;
      acc.push(i);
      return acc;
    }, []);
  }, [previewRows, statusFilter, columnFilters, search]);

  const setIncludedForIndices = useCallback((indices: number[], value: boolean) => {
    setIncluded((arr) => arr.map((v, i) => (indices.includes(i) ? value : v)));
  }, []);

  const selectedLines = useMemo(
    () => previewRows.filter((_, i) => included[i]).map((r) => r.address),
    [previewRows, included]
  );

  const handleDownload = useCallback(() => {
    if (selectedLines.length === 0) return;
    const content = selectedLines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'imported-addresses.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  }, [selectedLines]);

  // Skips the download/re-upload round trip -- Batch.tsx picks this up
  // via its pickedFile initializer reading location.state on mount.
  const handleSendToBatch = useCallback(() => {
    if (selectedLines.length === 0) return;
    navigate('/batch', {
      state: { fileContent: selectedLines.join('\n'), fileName: 'imported-addresses.txt' },
    });
  }, [selectedLines, navigate]);

  const reset = useCallback(() => {
    setStep('upload');
    setFileName('');
    setHeaders([]);
    setRows([]);
    setMapping({});
    setIncluded([]);
    setStatusFilter('all');
    setColumnFilters({});
    setSearch('');
    setError(null);
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: 42 }}>Import addresses</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Upload a CSV or Excel export -- even one with street number, street name, city, and state
        or ZIP split across separate columns -- map which column is which, and download a clean
        address list ready for <a href="#/batch">Batch geocode</a>.
      </p>

      <div className="plate" style={{ marginBottom: 'var(--space-6)', padding: 'var(--space-3)' }}>
        Nothing here is uploaded to Meridian's servers -- the file is read and converted entirely
        in your browser. Rows missing a street number or ZIP can't be geocoded, so they're flagged
        (and unchecked by default) rather than silently dropped or sent through anyway.
      </div>

      {step === 'upload' && (
        <div className="card elev-sm" style={{ maxWidth: 480 }}>
          <div className="field">
            <label>CSV or Excel file</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleChooseFile}
            />
            <button className="btn btn-primary btn-block" onClick={() => fileInputRef.current?.click()}>
              Choose file
            </button>
          </div>
          {error && (
            <p className="card-body" style={{ color: '#a4402a', margin: 0 }}>
              {error}
            </p>
          )}
        </div>
      )}

      {step === 'map' && (
        <div>
          <div className="card-title">Map your columns</div>
          <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-3)' }}>
            {fileName} · {rows.length} row{rows.length === 1 ? '' : 's'} detected
            {hasHeaderRow ? '' : ' (no header row found -- columns are numbered)'}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Sample</th>
                  <th>Maps to</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h, i) => (
                  <tr key={i}>
                    <td>{h}</td>
                    <td className="text-muted" style={{ fontSize: 12 }}>
                      {rows
                        .slice(0, 2)
                        .map((r) => r[i])
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td>
                      <select
                        className="input"
                        value={mapping[i] ?? 'ignore'}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [i]: e.target.value as ColumnRole }))
                        }
                      >
                        {ROLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <button className="btn btn-secondary" onClick={reset}>
              Start over
            </button>
            <button className="btn btn-primary" onClick={handleContinueToPreview}>
              Preview addresses
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && (
        <div>
          <div className="card-title">
            {includedCount} of {previewRows.length} row{previewRows.length === 1 ? '' : 's'} selected
          </div>
          <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-3)' }}>
            Rows missing a street number or ZIP are unchecked by default. Use the filters to narrow
            down to the rows you want, then select/deselect them all at once -- or check/uncheck any
            row individually.
          </p>

          <div
            className="card elev-sm"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}
          >
            <div className="field" style={{ minWidth: 160, marginBottom: 0 }}>
              <label htmlFor="import-filter-status">Status</label>
              <select
                id="import-filter-status"
                className="input"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              >
                <option value="all">All rows</option>
                <option value="valid">Valid only</option>
                <option value="flagged">Flagged only</option>
              </select>
            </div>
            {filterableColumns.map((c) => (
              <div key={c.index} className="field" style={{ minWidth: 160, marginBottom: 0 }}>
                <label htmlFor={`import-filter-col-${c.index}`}>{c.header}</label>
                <select
                  id={`import-filter-col-${c.index}`}
                  className="input"
                  value={columnFilters[c.index] ?? ALL}
                  onChange={(e) =>
                    setColumnFilters((f) => ({ ...f, [c.index]: e.target.value }))
                  }
                >
                  <option value={ALL}>All</option>
                  {c.values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="field" style={{ minWidth: 200, flex: 1, marginBottom: 0 }}>
              <label htmlFor="import-filter-search">Search address</label>
              <input
                id="import-filter-search"
                className="input"
                placeholder="e.g. Portland"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
            <span className="text-muted" style={{ fontSize: 12 }}>
              Showing {visibleIndices.length} of {previewRows.length} row{previewRows.length === 1 ? '' : 's'}
            </span>
            <button
              className="btn btn-secondary"
              style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => setIncludedForIndices(visibleIndices, true)}
              disabled={visibleIndices.length === 0}
            >
              Select all shown
            </button>
            <button
              className="btn btn-secondary"
              style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => setIncludedForIndices(visibleIndices, false)}
              disabled={visibleIndices.length === 0}
            >
              Deselect all shown
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  <th>Address</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleIndices.map((i) => {
                  const r = previewRows[i];
                  return (
                    <tr key={i}>
                      <td>
                        <input
                          type="checkbox"
                          checked={included[i] ?? false}
                          onChange={(e) =>
                            setIncluded((arr) => arr.map((v, j) => (j === i ? e.target.checked : v)))
                          }
                        />
                      </td>
                      <td>{r.address || <span className="text-muted">(empty)</span>}</td>
                      <td>
                        {r.valid ? (
                          <span className="tag tag-accent">OK</span>
                        ) : (
                          <span style={{ color: '#a4402a', fontSize: 12 }}>missing number or ZIP</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <button className="btn btn-secondary" onClick={() => setStep('map')}>
              Back to mapping
            </button>
            <button className="btn btn-primary" onClick={handleSendToBatch} disabled={includedCount === 0}>
              Send to Batch geocode
            </button>
            <button className="btn btn-secondary" onClick={handleDownload} disabled={includedCount === 0}>
              Download address list (.txt)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
