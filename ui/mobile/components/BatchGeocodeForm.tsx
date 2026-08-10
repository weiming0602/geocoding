import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
// expo-file-system's new Paths/File API (SDK 57) has a broken internal
// import (./pathUtilities fails to resolve under Metro's web bundler) --
// the legacy module is a separate, working export path that sidesteps it.
import * as FileSystem from 'expo-file-system/legacy';

import { batchGeocode, batchGeocodeDownload } from '../../shared/api/client';
import type { BatchResult, BatchSource } from '../../shared/api/types';
import { colors, radius, space } from '../../shared/theme';
import BatchGeocodeMap from './BatchGeocodeMap';
import ThemedButton from './ThemedButton';

type PickedFile = {
  name: string;
  content: string;
};

// RFC 4180-ish: only quote (and double internal quotes) when needed.
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

type Props = {
  // Set once by App.tsx when arriving via Import Addresses' "Send to
  // Batch" button -- consumed as pickedFile's initial value below, then
  // immediately reported back as consumed (onConsumedInitialFile) so
  // App.tsx can clear it; without that, revisiting this tab later
  // (unrelated to Import) would keep reverting to the old imported file.
  initialFile?: PickedFile | null;
  // The ID column mapped in Import Addresses (if any), one per address
  // line in initialFile.content, same order. Only ever valid alongside
  // that exact file -- cleared the moment pickedFile changes away from
  // it (see handleChooseFile/handleClearPickedFile), so an ID never ends
  // up misattributed to a different, later-picked source.
  initialIds?: string[] | null;
  onConsumedInitialFile?: () => void;
  // Independent of initialFile's one-shot lifecycle -- stays true for
  // this whole Batch visit (App.tsx only resets it on a direct tab-bar
  // switch), so the way back to Import Addresses doesn't disappear just
  // because the picked file was cleared or already consumed.
  showBackToImport?: boolean;
  onBackToImport?: () => void;
};

export default function BatchGeocodeForm({
  initialFile,
  initialIds,
  onConsumedInitialFile,
  showBackToImport,
  onBackToImport,
}: Props) {
  const [email, setEmail] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [filePath, setFilePath] = useState('');
  const [pickedFile, setPickedFile] = useState<PickedFile | null>(() => initialFile ?? null);
  const [forwardedIds, setForwardedIds] = useState<string[] | null>(() => initialIds ?? null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [quota, setQuota] = useState<{ remaining: number; tier: number } | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Runs once per mount (this component fully unmounts/remounts on every
  // tab switch, per App.tsx's conditional rendering) -- reports the
  // initial file as consumed right away so App.tsx can clear it, rather
  // than it silently reapplying on some later, unrelated visit to this tab.
  useEffect(() => {
    if (initialFile) onConsumedInitialFile?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Builds the request body from whichever source is active: a file picked
  // on-device (its contents are read up front, since the server has no way
  // to reach a phone's local storage) takes priority over a manually typed
  // path (the original workflow, which only works when the server can read
  // that path off its own disk -- e.g. server and app on the same machine).
  const buildBatchSource = useCallback((): BatchSource => {
    const base = pickedFile ? { fileContent: pickedFile.content } : { filePath: filePath.trim() };
    return { ...base, email: email.trim(), serviceKey: serviceKey.trim() };
  }, [pickedFile, filePath, email, serviceKey]);

  const hasSource = Boolean(pickedFile) || filePath.trim().length > 0;

  const handleChooseFile = useCallback(async () => {
    setPicking(true);
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (result.canceled || result.assets.length === 0) return;

      const asset = result.assets[0];
      const content =
        Platform.OS === 'web' && asset.file
          ? await asset.file.text()
          : await FileSystem.readAsStringAsync(asset.uri, {
              encoding: FileSystem.EncodingType.UTF8,
            });

      setPickedFile({ name: asset.name, content });
      // A manually chosen file has no known ID mapping -- any IDs
      // forwarded from Import Addresses applied to a different file.
      setForwardedIds(null);
      setResults(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file.';
      setError(message);
      Alert.alert('File picker error', message);
    } finally {
      setPicking(false);
    }
  }, []);

  const handleClearPickedFile = useCallback(() => {
    setPickedFile(null);
    setForwardedIds(null);
  }, []);

  const handleBatchGeocode = useCallback(async () => {
    // No client-side check that email/serviceKey are non-empty -- the
    // server decides whether an empty one is acceptable (see
    // ALLOW_TEST_EMPTY_SERVICE_KEY in CLAUDE.md) and returns a clear
    // error either way.
    if (!hasSource) {
      setResults(null);
      setError('Enter a file path or choose a file first.');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);
    setQuota(null);

    try {
      const response = await batchGeocode(buildBatchSource());
      setResults(response.results);
      // Omitted entirely (not just zero) when the request ran in test
      // mode with no email -- no account/quota was involved.
      if (typeof response.tier === 'number' && typeof response.remaining === 'number') {
        setQuota({ remaining: response.remaining, tier: response.tier });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Batch geocoding failed.';
      setError(message);
      Alert.alert('Batch geocoding error', message);
    } finally {
      setLoading(false);
    }
  }, [hasSource, buildBatchSource]);

  const handleDownload = useCallback(async () => {
    if (!hasSource) {
      setError('Enter a file path or choose a file first.');
      return;
    }

    if (Platform.OS !== 'web') {
      Alert.alert('Not supported', 'Downloading a ZIP is only supported in the web build.');
      return;
    }

    setDownloading(true);
    setError(null);
    setQuota(null);

    try {
      const { blob, quota: quotaHeader } = await batchGeocodeDownload(buildBatchSource());
      setQuota(quotaHeader);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'batch-geocode-results.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Download failed.';
      setError(message);
      Alert.alert('Download error', message);
    } finally {
      setDownloading(false);
    }
  }, [hasSource, buildBatchSource]);

  const idsMatchResults = forwardedIds !== null && results !== null && forwardedIds.length === results.length;

  const handleDownloadCsv = useCallback(() => {
    if (!results || !idsMatchResults) return;

    if (Platform.OS !== 'web') {
      Alert.alert('Not supported', 'Downloading a CSV is only supported in the web build.');
      return;
    }

    const header = 'ID,Address,Success,Latitude,Longitude,Side,Error';
    const rows = results.map((result, index) => {
      const id = forwardedIds![index];
      if (result.success) {
        return [
          id,
          result.address,
          'true',
          String(result.coordinates.latitude),
          String(result.coordinates.longitude),
          result.source === 'interpolation' ? result.rangeSide : '',
          '',
        ]
          .map(csvField)
          .join(',');
      }
      return [id, result.address, 'false', '', '', '', result.error].map(csvField).join(',');
    });
    const csv = [header, ...rows].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'batch-geocode-results.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  }, [results, idsMatchResults, forwardedIds]);

  const successCount = results ? results.filter((r) => r.success).length : 0;
  const successMarkers = (results ?? [])
    .filter((r): r is Extract<BatchResult, { success: true }> => r.success)
    .map((r) => ({
      address: r.address,
      latitude: r.coordinates.latitude,
      longitude: r.coordinates.longitude,
    }));

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Batch geocoding</Text>
      <Text style={styles.subtitle}>One address per line.</Text>

      {showBackToImport && (
        <View style={styles.spacing}>
          <ThemedButton title="← Back to Import Addresses" onPress={() => onBackToImport?.()} variant="secondary" block />
        </View>
      )}

      <Text style={styles.label}>Account email</Text>
      <TextInput
        style={styles.input}
        placeholder="you@company.com"
        placeholderTextColor={colors.neutral500}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />
      <Text style={styles.label}>Service key</Text>
      <TextInput
        style={styles.input}
        placeholder="mk_..."
        placeholderTextColor={colors.neutral500}
        value={serviceKey}
        onChangeText={setServiceKey}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.warningText}>
        Sent to you when you purchased your plan. Both the email and this key are required to run
        batch geocoding.
      </Text>

      <Text style={styles.label}>Resource file (one address per line)</Text>
      <View style={styles.pathRow}>
        <TextInput
          style={[styles.input, styles.pathInput]}
          placeholder="e.g. C:\software\database\addresses.txt"
          placeholderTextColor={colors.neutral500}
          value={pickedFile ? pickedFile.name : filePath}
          onChangeText={setFilePath}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading && !downloading && !pickedFile}
          returnKeyType="search"
          onSubmitEditing={handleBatchGeocode}
        />
        <ThemedButton
          title={pickedFile ? 'Clear' : 'Choose File'}
          onPress={pickedFile ? handleClearPickedFile : handleChooseFile}
          disabled={loading || downloading}
          loading={picking}
          variant="secondary"
        />
      </View>

      <Text style={styles.templateLabel}>Example format (tap and hold to copy):</Text>
      <Text style={styles.templateBlock} selectable>
        91 Chestnut St, Portland, ME 04101{'\n'}13 Deerfield Dr, Brunswick, ME 04011{'\n'}997
        Pequawket Trl, Standish, ME 04091
      </Text>

      <View style={styles.buttonRow}>
        <View style={styles.buttonSpacer}>
          <ThemedButton
            title="Batch Geocode"
            onPress={handleBatchGeocode}
            loading={loading}
            disabled={downloading}
            block
          />
        </View>
        <View style={styles.buttonSpacer}>
          <ThemedButton
            title="Download Results"
            onPress={handleDownload}
            loading={downloading}
            disabled={loading}
            variant="secondary"
            block
          />
        </View>
      </View>

      {quota && (
        <Text style={[styles.cardMeta, styles.spacing]}>
          {typeof quota === 'string'
            ? `Used ${quota} this period`
            : `${quota.remaining.toLocaleString()} of ${quota.tier.toLocaleString()} remaining this period`}
        </Text>
      )}

      {!loading && results && (
        <View style={styles.spacing}>
          <View style={styles.resultsHeaderRow}>
            <Text style={styles.cardTitle}>
              {successCount} of {results.length} succeeded
            </Text>
            {idsMatchResults && (
              <ThemedButton
                title="Download results as CSV (with ID)"
                onPress={handleDownloadCsv}
                variant="secondary"
              />
            )}
          </View>
          {forwardedIds !== null && !idsMatchResults && (
            <Text style={[styles.warningText, styles.spacing]}>
              ID list from Import Addresses didn't line up with these results, so IDs are omitted.
            </Text>
          )}
          {results.map((result, index) => (
            <View key={index} style={styles.resultRow}>
              {idsMatchResults && <Text style={styles.cardMeta}>{forwardedIds![index] || '—'}</Text>}
              <Text style={styles.resultAddress}>{result.address}</Text>
              {result.success ? (
                <Text style={styles.cardMeta} selectable>
                  {result.coordinates.latitude.toFixed(6)}, {result.coordinates.longitude.toFixed(6)}
                  {result.source === 'interpolation' ? ` (${result.rangeSide} side)` : ''}
                </Text>
              ) : (
                <Text style={styles.errorText}>{result.error}</Text>
              )}
            </View>
          ))}
          {successMarkers.length > 0 && <BatchGeocodeMap markers={successMarkers} />}
        </View>
      )}

      {!loading && !downloading && error && (
        <Text style={[styles.spacing, styles.errorText]}>{error}</Text>
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
    marginBottom: space[6],
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
    color: colors.text,
  },
  warningText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 11,
    color: colors.text,
    opacity: 0.6,
    marginBottom: space[4],
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginBottom: space[4],
  },
  pathInput: {
    flex: 1,
  },
  templateLabel: {
    fontFamily: 'Lora_400Regular',
    fontSize: 11,
    color: colors.text,
    opacity: 0.6,
    marginBottom: 4,
  },
  templateBlock: {
    fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier',
    fontSize: 12,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space[3],
    marginBottom: space[4],
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
  resultsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space[2],
  },
  cardMeta: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
  },
  resultRow: {
    marginBottom: space[2],
    paddingBottom: space[2],
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  resultAddress: {
    fontFamily: 'Lora_400Regular',
    fontWeight: '600',
    color: colors.text,
  },
  errorText: {
    fontFamily: 'Lora_400Regular',
    color: colors.errorText,
  },
});
