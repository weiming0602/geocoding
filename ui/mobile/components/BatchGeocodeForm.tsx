import React, { useCallback, useState } from 'react';
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

// Rendering a marker per result works well up to a few hundred, but a
// few thousand DOM-backed MapLibre markers noticeably bogs down the
// browser. Skip the map above this and point at the list/download instead.
const MAX_MARKERS_FOR_MAP = 300;

type PickedFile = {
  name: string;
  content: string;
};

export default function BatchGeocodeForm() {
  const [filePath, setFilePath] = useState('');
  const [pickedFile, setPickedFile] = useState<PickedFile | null>(null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Builds the request body from whichever source is active: a file picked
  // on-device (its contents are read up front, since the server has no way
  // to reach a phone's local storage) takes priority over a manually typed
  // path (the original workflow, which only works when the server can read
  // that path off its own disk -- e.g. server and app on the same machine).
  const buildBatchSource = useCallback((): BatchSource => {
    if (pickedFile) return { fileContent: pickedFile.content };
    return { filePath: filePath.trim() };
  }, [pickedFile, filePath]);

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
  }, []);

  const handleBatchGeocode = useCallback(async () => {
    if (!hasSource) {
      setResults(null);
      setError('Enter a file path or choose a file first.');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const response = await batchGeocode(buildBatchSource());
      setResults(response.results);
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

    try {
      const blob = await batchGeocodeDownload(buildBatchSource());
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
      <Text style={styles.subtitle}>One address per line, up to 5,000.</Text>

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

      {!loading && results && (
        <View style={styles.spacing}>
          <Text style={styles.cardTitle}>
            {successCount} of {results.length} succeeded
          </Text>
          {results.map((result, index) => (
            <View key={index} style={styles.resultRow}>
              <Text style={styles.resultAddress}>{result.address}</Text>
              {result.success ? (
                <Text style={styles.cardMeta} selectable>
                  {result.coordinates.latitude.toFixed(6)}, {result.coordinates.longitude.toFixed(6)} (
                  {result.rangeSide} side)
                </Text>
              ) : (
                <Text style={styles.errorText}>{result.error}</Text>
              )}
            </View>
          ))}
          {successMarkers.length > 0 && successMarkers.length < MAX_MARKERS_FOR_MAP && (
            <BatchGeocodeMap markers={successMarkers} />
          )}
          {successMarkers.length >= MAX_MARKERS_FOR_MAP && (
            <Text style={[styles.spacing, styles.mapSkippedText]}>
              Map skipped: {successMarkers.length} successful results is too many to render as
              markers smoothly. Use Download Results to get the coordinates instead.
            </Text>
          )}
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
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginBottom: space[4],
  },
  pathInput: {
    flex: 1,
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
  mapSkippedText: {
    fontFamily: 'Lora_400Regular',
    color: colors.text,
    opacity: 0.6,
    fontStyle: 'italic',
  },
  errorText: {
    fontFamily: 'Lora_400Regular',
    color: colors.errorText,
  },
});
