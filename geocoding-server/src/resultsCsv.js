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
      ? ['id', 'address', 'latitude', 'longitude', 'source', 'matchFullname', 'correctedStreet', 'approximate', 'correctedZip']
      : ['address', 'latitude', 'longitude', 'source', 'matchFullname', 'correctedStreet', 'approximate', 'correctedZip'],
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
        // Set only when source is llm_assisted: the street name the LLM
        // read the input as (see llmAssist.js) -- empty otherwise.
        result.correctedStreet ?? '',
        // "true" when placed in a gap between two segments' address
        // ranges (geocodeMatching.js's rangeGapFallback), else empty.
        result.approximate ? 'true' : '',
        // The street's real ZIP, when it was found in the address's named
        // town under a different ZIP than the one given (matchByStreetAndTown).
        result.correctedZip ?? '',
      ]);
    } else {
      errorRows.push([...idCell, result.address, result.error]);
    }
  });

  return { successCsv: rowsToCsv(successRows), errorCsv: rowsToCsv(errorRows) };
}

module.exports = { resultsToCsv, csvEscape };
