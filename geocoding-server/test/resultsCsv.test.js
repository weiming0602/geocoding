const test = require('node:test');
const assert = require('node:assert/strict');

const { resultsToCsv, csvEscape } = require('../src/resultsCsv');

test('csvEscape wraps values containing commas, quotes, or newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
  assert.equal(csvEscape(undefined), '');
});

test('resultsToCsv splits successes and failures into separate CSVs', () => {
  const results = [
    {
      address: '997 Pequawket Trl, Standish, ME 04091',
      success: true,
      rangeSide: 'left',
      match: { id: 12, fullname: 'Pequawket Trl' },
      coordinates: { latitude: 43.834391, longitude: -70.778549 },
    },
    {
      address: '123 Nonexistent Way, Nowhere, ME 99999',
      success: false,
      error: 'no street found matching "Nonexistent Way" in ZIP 99999',
    },
  ];

  const { successCsv, errorCsv } = resultsToCsv(results);

  const successLines = successCsv.trim().split('\r\n');
  assert.equal(successLines[0], 'address,latitude,longitude,rangeSide,matchFullname,streetId');
  assert.equal(
    successLines[1],
    '"997 Pequawket Trl, Standish, ME 04091",43.834391,-70.778549,left,Pequawket Trl,12'
  );

  const errorLines = errorCsv.trim().split('\r\n');
  assert.equal(errorLines[0], 'address,error');
  assert.equal(
    errorLines[1],
    '"123 Nonexistent Way, Nowhere, ME 99999","no street found matching ""Nonexistent Way"" in ZIP 99999"'
  );
});

test('resultsToCsv handles an all-success or all-failure batch', () => {
  const allSuccess = resultsToCsv([
    {
      address: 'A',
      success: true,
      rangeSide: 'right',
      match: { id: 1, fullname: 'A St' },
      coordinates: { latitude: 1, longitude: 2 },
    },
  ]);
  assert.equal(allSuccess.errorCsv.trim(), 'address,error');

  const allFailure = resultsToCsv([{ address: 'B', success: false, error: 'nope' }]);
  assert.equal(
    allFailure.successCsv.trim(),
    'address,latitude,longitude,rangeSide,matchFullname,streetId'
  );
});
