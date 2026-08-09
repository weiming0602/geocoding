import * as DocumentPicker from 'expo-document-picker';
// expo-file-system's new Paths/File API (SDK 57) has a broken internal
// import under Metro's web bundler -- the legacy module sidesteps it
// (see the same note in BatchGeocodeForm.tsx).
import * as FileSystem from 'expo-file-system/legacy';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as XLSX from 'xlsx';

import { ROLE_OPTIONS, guessRole, buildAddressLine, isGeocodableAddressLine, type ColumnRole } from '../../shared/importAddresses';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';

export type Step = 'upload' | 'map' | 'preview';
export type StatusFilter = 'all' | 'valid' | 'flagged';

export type ImportWizardState = {
  step: Step;
  fileName: string;
  headers: string[];
  rows: string[][];
  hasHeaderRow: boolean;
  mapping: Record<number, ColumnRole>;
  included: boolean[];
  statusFilter: StatusFilter;
  search: string;
  error: string | null;
};

export const INITIAL_IMPORT_STATE: ImportWizardState = {
  step: 'upload',
  fileName: '',
  headers: [],
  rows: [],
  hasHeaderRow: true,
  mapping: {},
  included: [],
  statusFilter: 'all',
  search: '',
  error: null,
};

// This app has no FlatList anywhere -- every list (Batch results,
// Progress milestones) is a plain .map() over Views inside a ScrollView,
// same convention followed here. A file with thousands of rows needs a
// hard render cap given that non-virtualized rendering; kept smaller
// than desktop's 100-row sample since a real phone renders this less
// cheaply than a desktop browser.
const SAMPLE_SIZE = 50;

type Props = {
  state: ImportWizardState;
  onChange: (patch: Partial<ImportWizardState>) => void;
  onSendToBatch: (file: { name: string; content: string }) => void;
};

// Column-value filters (desktop's per-column dropdowns) are deliberately
// left out here -- with no native <select>, one dropdown per column
// would mean a modal per column on a small screen, unwieldy once a file
// has more than a couple of filterable columns. Status + a single search
// box covers the common "narrow it down" need without that.
export default function ImportAddressesForm({ state, onChange, onSendToBatch }: Props) {
  const { step, fileName, headers, rows, hasHeaderRow, mapping, included, statusFilter, search, error } = state;
  const [picking, setPicking] = useState(false);
  const [rolePickerColumn, setRolePickerColumn] = useState<number | null>(null);

  const handleChooseFile = useCallback(async () => {
    setPicking(true);
    onChange({ error: null });
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '*/*', // some Android providers don't report a matching MIME type for .csv
        ],
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];

      let workbook: XLSX.WorkBook;
      if (Platform.OS === 'web' && asset.file) {
        const buffer = await asset.file.arrayBuffer();
        workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      } else {
        const base64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        workbook = XLSX.read(base64, { type: 'base64' });
      }

      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][];
      const asStrings = raw
        .map((r) => r.map((c) => (c === undefined || c === null ? '' : String(c).trim())))
        .filter((r) => r.some((c) => c !== ''));
      if (asStrings.length === 0) {
        onChange({ error: 'That file has no rows Meridian could read.' });
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

      onChange({
        fileName: asset.name,
        headers: headerRow,
        rows: dataRows,
        hasHeaderRow: looksLikeHeader,
        mapping: guessed,
        step: 'map',
      });
    } catch (err) {
      const message = err instanceof Error ? `Could not read that file: ${err.message}` : 'Could not read that file.';
      onChange({ error: message });
      Alert.alert('File picker error', message);
    } finally {
      setPicking(false);
    }
  }, [onChange]);

  const previewRows = useMemo(
    () =>
      rows.map((row) => {
        const address = buildAddressLine(row, mapping);
        return { row, address, valid: isGeocodableAddressLine(address) };
      }),
    [rows, mapping]
  );

  const handleContinueToPreview = useCallback(() => {
    onChange({
      included: previewRows.map((r) => r.valid),
      statusFilter: 'all',
      search: '',
      step: 'preview',
    });
  }, [previewRows, onChange]);

  const includedCount = included.filter(Boolean).length;

  const visibleIndices = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return previewRows.reduce<number[]>((acc, r, i) => {
      if (statusFilter === 'valid' && !r.valid) return acc;
      if (statusFilter === 'flagged' && r.valid) return acc;
      if (searchLower && !r.address.toLowerCase().includes(searchLower)) return acc;
      acc.push(i);
      return acc;
    }, []);
  }, [previewRows, statusFilter, search]);

  const displayedIndices = useMemo(() => visibleIndices.slice(0, SAMPLE_SIZE), [visibleIndices]);
  const isSampled = visibleIndices.length > displayedIndices.length;

  const setIncludedForIndices = useCallback(
    (indices: number[], value: boolean) => {
      onChange({ included: included.map((v, i) => (indices.includes(i) ? value : v)) });
    },
    [included, onChange]
  );

  const toggleRow = useCallback(
    (index: number) => {
      onChange({ included: included.map((v, i) => (i === index ? !v : v)) });
    },
    [included, onChange]
  );

  const selectedLines = useMemo(
    () => previewRows.filter((_, i) => included[i]).map((r) => r.address),
    [previewRows, included]
  );

  const handleSendToBatch = useCallback(() => {
    if (selectedLines.length === 0) return;
    onSendToBatch({ name: 'imported-addresses.txt', content: selectedLines.join('\n') });
  }, [selectedLines, onSendToBatch]);

  const reset = useCallback(() => {
    onChange({ ...INITIAL_IMPORT_STATE });
  }, [onChange]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Import addresses</Text>
      <Text style={styles.subtitle}>
        Turn a CSV or Excel export -- even one with street number, name, city, and state/ZIP each
        in their own column -- into a clean address list for Batch geocode.
      </Text>

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Nothing here is uploaded to Meridian's servers -- the file is read and converted
          entirely on your device. Rows missing a street number or ZIP can't be geocoded, so
          they're flagged (and unchecked by default) rather than silently dropped or sent through
          anyway.
        </Text>
      </View>

      {step === 'upload' && (
        <View>
          <ThemedButton title="Choose File" onPress={handleChooseFile} loading={picking} block />
          {error && <Text style={[styles.spacing, styles.errorText]}>{error}</Text>}
        </View>
      )}

      {step === 'map' && (
        <View>
          <Text style={styles.cardTitle}>Map your columns</Text>
          <Text style={styles.cardMeta}>
            {fileName} · {rows.length} row{rows.length === 1 ? '' : 's'} detected
            {hasHeaderRow ? '' : ' (no header row found -- columns are numbered)'}
          </Text>

          {headers.map((h, i) => {
            const role = mapping[i] ?? 'ignore';
            const roleLabel = ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;
            const sample = rows
              .slice(0, 2)
              .map((r) => r[i])
              .filter(Boolean)
              .join(' · ');
            return (
              <View key={i} style={[styles.columnRow, styles.spacing]}>
                <Text style={styles.columnHeader}>{h}</Text>
                {sample ? <Text style={styles.cardMeta}>{sample}</Text> : null}
                <View style={styles.spacing}>
                  <ThemedButton title={`Maps to: ${roleLabel}`} onPress={() => setRolePickerColumn(i)} variant="secondary" block />
                </View>
              </View>
            );
          })}

          <View style={[styles.buttonRow, styles.spacing]}>
            <View style={styles.buttonSpacer}>
              <ThemedButton title="Start Over" onPress={reset} variant="secondary" block />
            </View>
            <View style={styles.buttonSpacer}>
              <ThemedButton title="Preview Addresses" onPress={handleContinueToPreview} block />
            </View>
          </View>

          <Modal visible={rolePickerColumn !== null} transparent animationType="fade" onRequestClose={() => setRolePickerColumn(null)}>
            <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setRolePickerColumn(null)}>
              <View style={styles.modalCard}>
                <Text style={styles.cardTitle}>
                  {rolePickerColumn !== null ? headers[rolePickerColumn] : ''}
                </Text>
                {ROLE_OPTIONS.map((o) => (
                  <TouchableOpacity
                    key={o.value}
                    style={styles.modalOption}
                    onPress={() => {
                      if (rolePickerColumn === null) return;
                      onChange({ mapping: { ...mapping, [rolePickerColumn]: o.value } });
                      setRolePickerColumn(null);
                    }}
                  >
                    <Text style={styles.modalOptionText}>{o.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </TouchableOpacity>
          </Modal>
        </View>
      )}

      {step === 'preview' && (
        <View>
          <Text style={styles.cardTitle}>
            {includedCount} of {previewRows.length} row{previewRows.length === 1 ? '' : 's'} selected
          </Text>
          <Text style={styles.cardMeta}>
            Rows missing a street number or ZIP are unchecked by default. Tap any row to
            check/uncheck it.
          </Text>

          <Text style={[styles.label, styles.spacing]}>Status</Text>
          <View style={styles.statusRow}>
            {(['all', 'valid', 'flagged'] as StatusFilter[]).map((s) => (
              <View key={s} style={styles.statusButton}>
                <ThemedButton
                  title={s === 'all' ? 'All rows' : s === 'valid' ? 'Valid only' : 'Flagged only'}
                  onPress={() => onChange({ statusFilter: s })}
                  variant={statusFilter === s ? 'primary' : 'secondary'}
                  block
                />
              </View>
            ))}
          </View>

          <Text style={styles.label}>Search address</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Portland"
            placeholderTextColor={colors.neutral500}
            value={search}
            onChangeText={(v) => onChange({ search: v })}
            autoCapitalize="none"
          />

          <View style={styles.buttonRow}>
            <View style={styles.buttonSpacer}>
              <ThemedButton
                title="Select All Matching"
                onPress={() => setIncludedForIndices(visibleIndices, true)}
                variant="secondary"
                disabled={visibleIndices.length === 0}
                block
              />
            </View>
            <View style={styles.buttonSpacer}>
              <ThemedButton
                title="Deselect All Matching"
                onPress={() => setIncludedForIndices(visibleIndices, false)}
                variant="secondary"
                disabled={visibleIndices.length === 0}
                block
              />
            </View>
          </View>
          <Text style={[styles.cardMeta, styles.spacing]}>
            {isSampled
              ? `Showing a sample of ${displayedIndices.length} of ${visibleIndices.length} matching rows -- the count and buttons above cover all ${visibleIndices.length}, not just what's listed below.`
              : `Showing ${visibleIndices.length} of ${previewRows.length} row${previewRows.length === 1 ? '' : 's'}`}
          </Text>

          {displayedIndices.map((i) => {
            const r = previewRows[i];
            const checked = included[i] ?? false;
            return (
              <TouchableOpacity key={i} style={[styles.rowCard, styles.spacing]} onPress={() => toggleRow(i)} activeOpacity={0.7}>
                <View style={styles.rowCardHeader}>
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <Text style={styles.rowAddress}>{r.address || '(empty)'}</Text>
                </View>
                <Text style={r.valid ? styles.tagOk : styles.tagFlagged}>
                  {r.valid ? 'OK' : 'missing number or ZIP'}
                </Text>
              </TouchableOpacity>
            );
          })}

          <View style={[styles.buttonRow, styles.spacing]}>
            <View style={styles.buttonSpacer}>
              <ThemedButton title="Back to Mapping" onPress={() => onChange({ step: 'map' })} variant="secondary" block />
            </View>
            <View style={styles.buttonSpacer}>
              <ThemedButton title="Send to Batch" onPress={handleSendToBatch} disabled={includedCount === 0} block />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 30,
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[4],
  },
  noteCard: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: space[3],
    marginBottom: space[6],
  },
  noteText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  label: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.7,
    marginBottom: 5,
  },
  input: {
    fontFamily: 'Lora_400Regular',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: space[4],
    color: colors.text,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: space[2],
  },
  buttonSpacer: {
    flex: 1,
  },
  spacing: {
    marginTop: space[4],
  },
  cardTitle: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 17,
    color: colors.text,
    marginBottom: space[2],
  },
  cardMeta: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
  },
  errorText: {
    fontFamily: 'Lora_400Regular',
    color: colors.errorText,
  },
  columnRow: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: space[3],
  },
  columnHeader: {
    fontFamily: 'Lora_400Regular',
    fontWeight: '600',
    color: colors.text,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: space[4],
  },
  modalCard: {
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: space[4],
  },
  modalOption: {
    paddingVertical: space[2],
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  modalOptionText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 15,
    color: colors.text,
  },
  statusRow: {
    flexDirection: 'row',
    gap: space[2],
    marginBottom: space[3],
  },
  statusButton: {
    flex: 1,
  },
  rowCard: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: space[3],
  },
  rowCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkboxChecked: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  checkboxMark: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '700',
  },
  rowAddress: {
    fontFamily: 'Lora_400Regular',
    color: colors.text,
    flex: 1,
  },
  tagOk: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.accent2,
    marginTop: 4,
  },
  tagFlagged: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.errorText,
    marginTop: 4,
  },
});
