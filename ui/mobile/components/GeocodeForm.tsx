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

import { geocode } from '../../shared/api/client';
import type { Coordinates, StreetMatch } from '../../shared/api/types';
import GeocodeMap from './GeocodeMap';

export default function GeocodeForm() {
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [matchedStreet, setMatchedStreet] = useState<string | null>(null);
  const [match, setMatch] = useState<StreetMatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGeocode = useCallback(async () => {
    const trimmedAddress = address.trim();
    if (!trimmedAddress) {
      setCoordinates(null);
      setMatchedStreet(null);
      setMatch(null);
      setError('Enter an address first.');
      return;
    }

    setLoading(true);
    setError(null);
    setCoordinates(null);
    setMatchedStreet(null);
    setMatch(null);

    try {
      const result = await geocode(trimmedAddress);
      setCoordinates(result.coordinates);
      setMatchedStreet(`${result.match.fullname} (${result.rangeSide} side)`);
      setMatch(result.match);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Geocoding failed.';
      setError(message);
      Alert.alert('Geocoding error', message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Street address</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. 997 Pequawket Trl, Standish, ME 04091"
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loading}
        returnKeyType="search"
        onSubmitEditing={handleGeocode}
      />

      <Button title="Geocode" onPress={handleGeocode} disabled={loading} />

      {loading && <ActivityIndicator style={styles.spacing} size="small" />}

      {!loading && coordinates && (
        <View style={styles.spacing}>
          <Text style={styles.resultLabel}>{matchedStreet}</Text>
          <Text selectable>
            latitude, longitude: {coordinates.latitude.toFixed(6)}, {coordinates.longitude.toFixed(6)}
          </Text>
          {match && <Text>Street ID: {match.id}</Text>}
          <GeocodeMap
            latitude={coordinates.latitude}
            longitude={coordinates.longitude}
            label={matchedStreet ?? undefined}
          />
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
    marginBottom: 4,
  },
  errorText: {
    color: '#c0392b',
  },
});
