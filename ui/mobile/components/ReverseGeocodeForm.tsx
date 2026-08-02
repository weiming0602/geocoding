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

import GeocodeMap from './GeocodeMap';

// Points at the geocoding-server Express API (C:\software\geocoding-server).
// On a physical device/simulator, "localhost" means the device itself, so
// swap this for your dev machine's LAN IP (e.g. http://192.168.1.23:3001).
const REVERSE_GEOCODE_API_URL = 'http://localhost:3001/reverse-geocode';

type Coordinates = {
  latitude: number;
  longitude: number;
};

type Match = {
  fullname: string;
  id: number;
};

type ReverseGeocodeResponse = {
  match: Match;
  side: 'left' | 'right';
  number: number | null;
  address: string;
  distanceMeters: number;
  matchedCoordinates: Coordinates;
};

type ReverseGeocodeErrorResponse = {
  error: string;
};

/** Parses "lat, lon" (or "lat lon") into { latitude, longitude }, or null if unparseable. */
function parseCoordinateInput(input: string): Coordinates | null {
  const parts = input
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (parts.length !== 2) return null;

  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return { latitude, longitude };
}

export default function ReverseGeocodeForm() {
  const [coordinateInput, setCoordinateInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [result, setResult] = useState<ReverseGeocodeResponse | null>(null);
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
      const response = await fetch(REVERSE_GEOCODE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(coordinates),
      });

      const body = (await response.json()) as ReverseGeocodeResponse | ReverseGeocodeErrorResponse;

      if (!response.ok || 'error' in body) {
        const message = 'error' in body ? body.error : 'Reverse geocoding failed.';
        throw new Error(message);
      }

      setResult(body);
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
