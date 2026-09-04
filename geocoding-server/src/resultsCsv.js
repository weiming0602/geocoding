function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

/**
 * Splits geocodeBatch() results into a successes CSV and a failures CSV.
 * `ids` (optional) is the client's own per-row identifier list -- from a
 * picked file's id column, or the "add sequential IDs?" prompt (see
 * ui/desktop's Batch.tsx) -- included as a leading `id` column only when
 * it's an array whose length matches `results` exactly; a missing or
 * mismatched array (e.g. a stale one from a previously-loaded file)
 * silently omits the column entirely rather than risk attaching a wrong
 * ID to a row.
 */
function resultsToCsv(results, ids) {
  const idsMatch = Array.isArray(ids) && ids.length === results.length;
  const successRows = [
    idsMatch
      ? ['id', 'address', 'latitude', 'longitude', 'source', 'matchFullname']
      : ['address', 'latitude', 'longitude', 'source', 'matchFullname'],
  ];
  const errorRows = [idsMatch ? ['id', 'address', 'error'] : ['address', 'error']];

  results.forEach((result, i) => {
    const idCell = idsMatch ? [ids[i]] : [];
    if (result.success) {
      successRows.push([
        ...idCell,
        result.address,
        result.coordinates.latitude,
        result.coordinates.longitude,
        result.source,
        result.match.fullname,
      ]);
    } else {
      errorRows.push([...idCell, result.address, result.error]);
    }
  });

  return { successCsv: rowsToCsv(successRows), errorCsv: rowsToCsv(errorRows) };
}

module.exports = { resultsToCsv, csvEscape };
