import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

// Points at the geocoding-server Express API (C:\software\geocoding\geocoding-server).
// The file path is read on the server (it has local filesystem access),
// not in the app, so this only works when server and app share a filesystem
// (e.g. both on your dev machine) or the path is reachable from wherever
// geocoding-server actually runs.
const BATCH_GEOCODE_API_URL = 'http://localhost:3001/geocode/batch';

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

export default function BatchGeocodeForm() {
  const [filePath, setFilePath] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBatchGeocode = useCallback(async () => {
    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
      setResults(null);
      setError('Enter a file path first.');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const response = await fetch(BATCH_GEOCODE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: trimmedPath }),
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
  }, [filePath]);

  const successCount = results ? results.filter((r) => r.success).length : 0;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Resource file path (one address per line)</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. C:\software\database\addresses.txt"
        value={filePath}
        onChangeText={setFilePath}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loading}
        returnKeyType="search"
        onSubmitEditing={handleBatchGeocode}
      />

      <Button title="Batch Geocode" onPress={handleBatchGeocode} disabled={loading} />

      {loading && <ActivityIndicator style={styles.spacing} size="small" />}

      {!loading && results && (
        <View style={styles.spacing}>
          <Text style={styles.resultLabel}>
            {successCount} of {results.length} succeeded
          </Text>
          {results.map((result, index) => (
            <View key={index} style={styles.resultRow}>
              <Text style={styles.resultAddress}>{result.address}</Text>
              {result.success ? (
                <Text>
                  {result.coordinates.latitude.toFixed(6)}, {result.coordinates.longitude.toFixed(6)}
                  {' '}({result.rangeSide} side)
                </Text>
              ) : (
                <Text style={styles.errorText}>{result.error}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {!loading && error && (
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
    marginBottom: 12,
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
  errorText: {
    color: '#c0392b',
  },
});
