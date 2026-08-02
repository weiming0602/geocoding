import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { geocode } from '../../shared/api/client';
import type { Coordinates, StreetMatch } from '../../shared/api/types';
import { colors, radius, space } from '../../shared/theme';
import GeocodeMap from './GeocodeMap';
import ThemedButton from './ThemedButton';

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
      <Text style={styles.title}>Geocode</Text>
      <Text style={styles.subtitle}>Convert a street address to coordinates.</Text>

      <Text style={styles.label}>Address or place</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. 997 Pequawket Trl, Standish, ME 04091"
        placeholderTextColor={colors.neutral500}
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loading}
        returnKeyType="search"
        onSubmitEditing={handleGeocode}
      />

      <ThemedButton title="Geocode" onPress={handleGeocode} loading={loading} block />

      {!loading && coordinates && (
        <View style={[styles.card, styles.spacing]}>
          <Text style={styles.cardKicker}>Result</Text>
          <Text style={styles.cardTitle}>{matchedStreet}</Text>
          <Text style={styles.cardMeta} selectable>
            {coordinates.latitude.toFixed(6)}, {coordinates.longitude.toFixed(6)}
          </Text>
          {match && <Text style={styles.cardMeta}>Street ID: {match.id}</Text>}
          <View style={styles.spacing}>
            <GeocodeMap
              latitude={coordinates.latitude}
              longitude={coordinates.longitude}
              label={matchedStreet ?? undefined}
            />
          </View>
        </View>
      )}

      {!loading && error && <Text style={[styles.spacing, styles.errorText]}>{error}</Text>}
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
