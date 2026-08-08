import * as Location from 'expo-location';
import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { reverseGeocode } from '../../shared/api/client';
import type { ReverseGeocodeResult } from '../../shared/api/types';
import { parseCoordinateInput } from '../../shared/parseCoordinateInput';
import { colors, radius, space } from '../../shared/theme';
import GeocodeMap from './GeocodeMap';
import ThemedButton from './ThemedButton';

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
      <Text style={styles.title}>Reverse geocode</Text>
      <Text style={styles.subtitle}>Get the nearest address for a coordinate.</Text>

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Lost in an unfamiliar city? This is exactly what reverse geocoding is for. A visitor
          standing on an unfamiliar street doesn't know the address — but their phone knows its
          own coordinates. Tap "Use Current Location" and we'll tell you exactly where you're
          standing, down to the nearest street and side.
        </Text>
      </View>

      <Text style={styles.label}>Coordinate (latitude, longitude)</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. 43.834391, -70.778549"
        placeholderTextColor={colors.neutral500}
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
          <ThemedButton
            title="Use Current Location"
            onPress={handleUseCurrentLocation}
            loading={locating}
            disabled={loading}
            variant="secondary"
            block
          />
        </View>
        <View style={styles.buttonSpacer}>
          <ThemedButton
            title="Reverse Geocode"
            onPress={handleReverseGeocode}
            loading={loading}
            disabled={locating}
            block
          />
        </View>
      </View>

      {!loading && !locating && result && (
        <View style={[styles.card, styles.spacing]}>
          <Text style={styles.cardKicker}>Result</Text>
          <Text style={styles.cardTitle}>{result.address}</Text>
          <Text style={styles.cardMeta}>
            {result.matchedCoordinates.latitude.toFixed(6)}, {result.matchedCoordinates.longitude.toFixed(6)} ·{' '}
            {result.distanceMeters.toFixed(1)} m to street · {result.side} side
          </Text>
          <View style={styles.spacing}>
            <GeocodeMap
              latitude={result.matchedCoordinates.latitude}
              longitude={result.matchedCoordinates.longitude}
              label={result.address}
            />
          </View>
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
    gap: space[2],
  },
  buttonSpacer: {
    flex: 1,
  },
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
  spacing: {
    marginTop: space[4],
  },
  card: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: space[3],
  },
  cardKicker: {
    fontFamily: 'Lora_400Regular',
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.accent,
    marginBottom: 4,
  },
  cardTitle: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 17,
    color: colors.text,
  },
  cardMeta: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
    marginTop: 2,
  },
  errorText: {
    fontFamily: 'Lora_400Regular',
    color: colors.errorText,
  },
});
