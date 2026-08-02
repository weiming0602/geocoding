import * as Location from 'expo-location';
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

import { reverseGeocode } from '../../shared/api/client';
import type { ReverseGeocodeResult } from '../../shared/api/types';
import { parseCoordinateInput } from '../../shared/parseCoordinateInput';
import GeocodeMap from './GeocodeMap';

export default function ReverseGeocodeForm() {
  const [coordinateInput, setCoordinateInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [result, setResult] = useState<ReverseGeocodeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUseCurrentLocation = useCallback(async () => {
    setLocating(true);
    setError(null);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Location permission was not granted.');
      }

      const position = await Location.getCurrentPositionAsync();
      const { latitude, longitude } = position.coords;
      setCoordinateInput(`${latitude}, ${longitude}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not detect current location.';
      setError(message);
      Alert.alert('Location error', message);
    } finally {
      setLocating(false);
    }
  }, []);

  const handleReverseGeocode = useCallback(async () => {
    const coordinates = parseCoordinateInput(coordinateInput);
    if (!coordinates) {
      setResult(null);
      setError('Enter coordinates as "latitude, longitude", e.g. 43.834391, -70.778549.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const result = await reverseGeocode(coordinates);
      setResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reverse geocoding failed.';
      setError(message);
      Alert.alert('Reverse geocoding error', message);
    } finally {
      setLoading(false);
    }
  }, [coordinateInput]);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Coordinate (latitude, longitude)</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. 43.834391, -70.778549"
        value={coordinateInput}
        onChangeText={setCoordinateInput}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loading && !locating}
        returnKeyType="search"
        onSubmitEditing={handleReverseGeocode}
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonSpacer}>
          <Button
            title="Use Current Location"
            onPress={handleUseCurrentLocation}
            disabled={loading || locating}
          />
        </View>
        <View style={styles.buttonSpacer}>
          <Button
            title="Reverse Geocode"
            onPress={handleReverseGeocode}
            disabled={loading || locating}
          />
        </View>
      </View>

      {(loading || locating) && <ActivityIndicator style={styles.spacing} size="small" />}

      {!loading && !locating && result && (
        <View style={styles.spacing}>
          <Text style={styles.resultLabel}>{result.address}</Text>
          <Text>Side: {result.side}</Text>
          <Text>Distance to street: {result.distanceMeters.toFixed(1)} m</Text>
          <Text>
            Matched at: {result.matchedCoordinates.latitude.toFixed(6)},{' '}
            {result.matchedCoordinates.longitude.toFixed(6)}
          </Text>
          <GeocodeMap
            latitude={result.matchedCoordinates.latitude}
            longitude={result.matchedCoordinates.longitude}
            label={result.address}
          />
        </View>
      )}

      {!loading && !locating && error && (
        <Text style={[styles.spacing, styles.errorText]}>{error}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  buttonSpacer: {
    flex: 1,
  },
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
    marginBottom: 4,
  },
  errorText: {
    color: '#c0392b',
  },
});
