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

/** Splits geocodeBatch() results into a successes CSV and a failures CSV. */
function resultsToCsv(results) {
  const successRows = [
    ['address', 'latitude', 'longitude', 'rangeSide', 'matchFullname', 'streetId'],
  ];
  const errorRows = [['address', 'error']];

  for (const result of results) {
    if (result.success) {
      successRows.push([
        result.address,
        result.coordinates.latitude,
        result.coordinates.longitude,
        result.rangeSide,
        result.match.fullname,
        result.match.id,
      ]);
    } else {
      errorRows.push([result.address, result.error]);
    }
  }

  return { successCsv: rowsToCsv(successRows), errorCsv: rowsToCsv(errorRows) };
}

module.exports = { resultsToCsv, csvEscape };
