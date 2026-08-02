import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
// expo-file-system's new Paths/File API (SDK 57) has a broken internal
// import (./pathUtilities fails to resolve under Metro's web bundler) --
// the legacy module is a separate, working export path that sidesteps it.
import * as FileSystem from 'expo-file-system/legacy';

import BatchGeocodeMap from './BatchGeocodeMap';

// Points at the geocoding-server Express API (C:\software\geocoding\geocoding-server).
// The file path is read on the server (it has local filesystem access),
// not in the app, so this only works when server and app share a filesystem
// (e.g. both on your dev machine) or the path is reachable from wherever
// geocoding-server actually runs.
const BATCH_GEOCODE_API_URL = 'http://localhost:3001/geocode/batch';
const BATCH_DOWNLOAD_API_URL = 'http://localhost:3001/geocode/batch/download';

// Rendering a marker per result works well up to a few hundred, but a
// few thousand DOM-backed MapLibre markers noticeably bogs down the
// browser. Skip the map above this and point at the list/download instead.
const MAX_MARKERS_FOR_MAP = 300;

type Coordinates = {
  latitude: number;
  longitude: number;
};

type BatchResult =
  | {
      address: string;
      success: true;
      match: { fullname: string; id: number };
      rangeSide: 'left' | 'right';
      coordinates: Coordinates;
    }
  | {
      address: string;
      success: false;
      error: string;
    };

type BatchResponse = {
  results: BatchResult[];
};

type BatchErrorResponse = {
  error: string;
};

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
  const buildBatchRequestBody = useCallback(() => {
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
      const response = await fetch(BATCH_GEOCODE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBatchRequestBody()),
      });

      const body = (await response.json()) as BatchResponse | BatchErrorResponse;

      if (!response.ok || 'error' in body) {
        const message = 'error' in body ? body.error : 'Batch geocoding failed.';
        throw new Error(message);
      }

      setResults(body.results);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Batch geocoding failed.';
      setError(message);
      Alert.alert('Batch geocoding error', message);
    } finally {
      setLoading(false);
    }
  }, [hasSource, buildBatchRequestBody]);

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
      const response = await fetch(BATCH_DOWNLOAD_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBatchRequestBody()),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as BatchErrorResponse | null;
        throw new Error(body?.error ?? `Download failed (${response.status}).`);
      }

      const blob = await response.blob();
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
  }, [hasSource, buildBatchRequestBody]);

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
      <Text style={styles.label}>Resource file (one address per line)</Text>
      <View style={styles.pathRow}>
        <TextInput
          style={[styles.input, styles.pathInput]}
          placeholder="e.g. C:\software\database\addresses.txt"
          value={pickedFile ? pickedFile.name : filePath}
          onChangeText={setFilePath}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading && !downloading && !pickedFile}
          returnKeyType="search"
          onSubmitEditing={handleBatchGeocode}
        />
        <Button
          title={pickedFile ? 'Clear' : 'Choose File'}
          onPress={pickedFile ? handleClearPickedFile : handleChooseFile}
          disabled={loading || downloading || picking}
        />
      </View>

      <View style={styles.buttonRow}>
        <View style={styles.buttonSpacer}>
          <Button title="Batch Geocode" onPress={handleBatchGeocode} disabled={loading || downloading} />
        </View>
        <View style={styles.buttonSpacer}>
          <Button title="Download Results" onPress={handleDownload} disabled={loading || downloading} />
        </View>
      </View>

      {(loading || downloading) && <ActivityIndicator style={styles.spacing} size="small" />}

      {!loading && results && (
        <View style={styles.spacing}>
          <Text style={styles.resultLabel}>
            {successCount} of {results.length} succeeded
          </Text>
          {results.map((result, index) => (
            <View key={index} style={styles.resultRow}>
              <Text style={styles.resultAddress}>{result.address}</Text>
              {result.success ? (
                <Text selectable>
                  latitude, longitude: {result.coordinates.latitude.toFixed(6)},{' '}
                  {result.coordinates.longitude.toFixed(6)} ({result.rangeSide} side)
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
    padding: 16,
  },
  label: {
    fontSize: 14,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  pathInput: {
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  buttonSpacer: {
    flex: 1,
  },
  spacing: {
    marginTop: 16,
  },
  resultLabel: {
    fontWeight: '600',
    marginBottom: 8,
  },
  resultRow: {
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  resultAddress: {
    fontWeight: '500',
  },
  mapSkippedText: {
    color: '#666',
    fontStyle: 'italic',
  },
  errorText: {
    color: '#c0392b',
  },
});
