import { useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import * as XLSX from 'xlsx';

import {
  ROLE_OPTIONS,
  guessRole,
  buildAddressLine,
  getMappedValue,
  isGeocodableAddressLine,
  type ColumnRole,
} from '../../../shared/importAddresses';
import { ALL_FILTER_VALUE, useImportAddressesState, type StatusFilter } from '../state/ImportAddressesState';

export type { ColumnRole } from '../../../shared/importAddresses';
export { guessRole, buildAddressLine, isGeocodableAddressLine } from '../../../shared/importAddresses';

// Rendering every matching row for a file with thousands of rows would
// make the preview table itself the bottleneck -- the table shows only
// a sample; "Select/Deselect all matching" and the selected count still
// operate on the full filtered set, not just what's rendered.
const SAMPLE_SIZE = 100;

export default function ImportAddresses() {
  const navigate = useNavigate();
  const {
    step,
    setStep,
    fileName,
    setFileName,
    headers,
    setHeaders,
    rows,
    setRows,
    hasHeaderRow,
    setHasHeaderRow,
    mapping,
    setMapping,
    included,
    setIncluded,
    statusFilter,
    setStatusFilter,
    columnFilters,
    setColumnFilters,
    search,
    setSearch,
    error,
    setError,
  } = useImportAddressesState();
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

  const hasIdColumn = useMemo(() => Object.values(mapping).includes('id'), [mapping]);

  const previewRows = useMemo(
    () =>
      rows.map((row) => {
        const address = buildAddressLine(row, mapping);
        return { row, address, id: getMappedValue(row, mapping, 'id'), valid: isGeocodableAddressLine(address) };
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
        if (value !== ALL_FILTER_VALUE && r.row[Number(colIndex)] !== value) return acc;
      }
      if (searchLower && !r.address.toLowerCase().includes(searchLower)) return acc;
      acc.push(i);
      return acc;
    }, []);
  }, [previewRows, statusFilter, columnFilters, search]);

  const displayedIndices = useMemo(() => visibleIndices.slice(0, SAMPLE_SIZE), [visibleIndices]);
  const isSampled = visibleIndices.length > displayedIndices.length;

  const setIncludedForIndices = useCallback((indices: number[], value: boolean) => {
    setIncluded((arr) => arr.map((v, i) => (indices.includes(i) ? value : v)));
  }, []);

  // Kept as one filtered array (not two separately-filtered ones) so the
  // address at selectedRows[i] and the ID at selectedRows[i] can never
  // drift out of correspondence with each other.
  const selectedRows = useMemo(
    () => previewRows.filter((_, i) => included[i]),
    [previewRows, included]
  );
  const selectedLines = useMemo(() => selectedRows.map((r) => r.address), [selectedRows]);
  const selectedIds = useMemo(() => selectedRows.map((r) => r.id), [selectedRows]);

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
  // via its pickedFile initializer reading location.state on mount. The
  // mapped ID column (if any) rides along as a same-order parallel array
  // -- the server's batch endpoint only ever sees plain address lines
  // (fileContent, unchanged), so this doesn't touch that contract at
  // all; Batch.tsx re-associates ids[i] with results[i] itself once the
  // response comes back in the same order the addresses were sent.
  const handleSendToBatch = useCallback(() => {
    if (selectedLines.length === 0) return;
    navigate('/batch', {
      state: {
        fileContent: selectedLines.join('\n'),
        fileName: 'imported-addresses.txt',
        ids: hasIdColumn ? selectedIds : undefined,
      },
    });
  }, [selectedLines, selectedIds, hasIdColumn, navigate]);

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
      <h1>Import addresses</h1>
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
            row individually. The status and column dropdowns match on one value; "Search address"
            matches anywhere in the full generated address line, useful for columns without their
            own dropdown (too many distinct values) or for matching part of a street name.
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
                  value={columnFilters[c.index] ?? ALL_FILTER_VALUE}
                  onChange={(e) =>
                    setColumnFilters((f) => ({ ...f, [c.index]: e.target.value }))
                  }
                >
                  <option value={ALL_FILTER_VALUE}>All</option>
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
              {isSampled
                ? `Showing a sample of ${displayedIndices.length} of ${visibleIndices.length} matching rows`
                : `Showing ${visibleIndices.length} of ${previewRows.length} row${previewRows.length === 1 ? '' : 's'}`}
            </span>
            <button
              className="btn btn-secondary"
              style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => setIncludedForIndices(visibleIndices, true)}
              disabled={visibleIndices.length === 0}
            >
              Select all matching
            </button>
            <button
              className="btn btn-secondary"
              style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => setIncludedForIndices(visibleIndices, false)}
              disabled={visibleIndices.length === 0}
            >
              Deselect all matching
            </button>
          </div>

          {isSampled && (
            <p className="text-muted" style={{ fontSize: 12, marginBottom: 'var(--space-2)' }}>
              Only a sample of {displayedIndices.length} rows is listed below to keep this page fast
              with {visibleIndices.length.toLocaleString()} matching rows -- "Select/Deselect all
              matching" above, and the count at the top, both cover all {visibleIndices.length.toLocaleString()},
              not just what's shown here. Narrow the filters to see a specific row.
            </p>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  {hasIdColumn && <th>ID</th>}
                  <th>Address</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {displayedIndices.map((i) => {
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
                      {hasIdColumn && (
                        <td className="text-muted">{r.id || <span style={{ opacity: 0.5 }}>—</span>}</td>
                      )}
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
