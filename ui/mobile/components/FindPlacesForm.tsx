import * as Location from 'expo-location';
import React, { useCallback, useRef, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { searchPlaces } from '../../shared/api/client';
import type { PlaceResult } from '../../shared/api/types';
import { colors, radius, space } from '../../shared/theme';
import FindPlacesMap from './FindPlacesMap';
import ThemedButton from './ThemedButton';

const RADIUS_OPTIONS = [
  { label: '1 km', meters: 1000 },
  { label: '5 km', meters: 5000 },
  { label: '10 km', meters: 10000 },
  { label: '25 km', meters: 25000 },
];

// No interactive map exists on native (see GeocodeMap.tsx -- native has
// no maplibre/expo-maps setup, only a deep-link-out "Open in Maps"
// button, and FindPlacesMap.tsx follows the same list-of-pins limitation
// as BatchGeocodeMap.tsx), so unlike the desktop version, there's no
// click-a-point fallback here at all -- a query needs either a "near
// <place>" clause (resolved server-side via Nominatim) or a GPS fix from
// "Use My Location". That pairing covers the same ground a map tap would.
// The web build (FindPlacesMap.web.tsx) does render a real interactive
// map with list<->map linking, same as BatchGeocodeForm/BatchGeocodeMap.
export default function FindPlacesForm() {
  const [query, setQuery] = useState('');
  const [center, setCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [radiusMeters, setRadiusMeters] = useState(RADIUS_OPTIONS[1].meters);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // List<->map linking (see FindPlacesMap.web.tsx). selectedIndex is
  // highlight-only, set from either direction; focusRequest additionally
  // pans/zooms the map, and is only ever set from a list-row tap.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ index: number; nonce: number } | null>(null);
  const rowRefs = useRef<Record<number, View | null>>({});
  const mapWrapperRef = useRef<View>(null);

  const hasNearClause = /\bnear\b/i.test(query);

  const handleUseCurrentLocation = useCallback(async () => {
    setLocating(true);
    setError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Location permission was not granted.');
      }
      const position = await Location.getCurrentPositionAsync();
      setCenter({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not detect current location.';
      setError(message);
      Alert.alert('Location error', message);
    } finally {
      setLocating(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setError('Enter what you’re looking for first.');
      return;
    }
    if (!hasNearClause && !center) {
      setError('Tap "Use My Location", or add "near <place>" to your search.');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    setSelectedIndex(null);
    setFocusRequest(null);
    try {
      const response = await searchPlaces({
        query: query.trim(),
        latitude: center?.latitude,
        longitude: center?.longitude,
        radiusMeters,
      });
      setResults(response.results);
      setSkipped(response.skipped);
      setTruncated(response.truncated);
      if (response.center) setCenter(response.center);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed.';
      setError(message);
      Alert.alert('Search error', message);
    } finally {
      setLoading(false);
    }
  }, [query, hasNearClause, center, radiusMeters]);

  const handleDownload = useCallback(() => {
    if (!results || results.length === 0) return;
    if (Platform.OS !== 'web') {
      Alert.alert('Not supported', 'Downloading a .txt file is only supported in the web build.');
      return;
    }
    const content = results.map((r) => r.address).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'places-addresses.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  }, [results]);

  // Defensive: a place without a usable coordinate has no marker to plot
  // -- filtered out here (after indexing, so resultIndex still lines up
  // with the results array) rather than ever handing maplibre a NaN
  // LngLat, which throws and blanks the whole page (see FindPlacesMap.web.tsx).
  const places = (results ?? [])
    .map((r, resultIndex) => ({
      name: r.name,
      address: r.address,
      latitude: r.latitude,
      longitude: r.longitude,
      resultIndex,
    }))
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

  // Row tap (list -> map): highlight + pan/zoom + scroll to the map.
  const handleSelectRow = useCallback((index: number) => {
    setSelectedIndex(index);
    setFocusRequest({ index, nonce: Date.now() });
    if (Platform.OS === 'web') {
      (mapWrapperRef.current as unknown as HTMLElement | null)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, []);

  // Marker click (map -> list): highlight + scroll to that row only --
  // never re-centers the map, which would fight the pan/zoom the click
  // itself may have already caused.
  const handlePlaceClick = useCallback((index: number) => {
    setSelectedIndex(index);
    if (Platform.OS === 'web') {
      (rowRefs.current[index] as unknown as HTMLElement | null)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Find places</Text>
      <Text style={styles.subtitle}>
        Search OpenStreetMap for a kind of place, download the results as an address list.
      </Text>

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          This search doesn't use Meridian's own geocoding -- it's powered by public OpenStreetMap
          data. Add "near &lt;place&gt;" (e.g. "barber shop near Brunswick, Maine") to search near
          a named place via OSM's Nominatim, or tap "Use My Location" -- no map needed. What you
          get back is a plain address list, ready to run through Batch geocode for precise,
          Meridian-computed coordinates.
        </Text>
      </View>

      <Text style={styles.label}>What are you looking for?</Text>
      <TextInput
        style={styles.input}
        placeholder='e.g. "pizza" or "barber shop near Brunswick, ME"'
        placeholderTextColor={colors.neutral500}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={handleSearch}
        editable={!loading}
      />

      <Text style={styles.label}>Search radius</Text>
      <View style={styles.radiusRow}>
        {RADIUS_OPTIONS.map((opt) => (
          <View key={opt.meters} style={styles.radiusButton}>
            <ThemedButton
              title={opt.label}
              onPress={() => setRadiusMeters(opt.meters)}
              variant={radiusMeters === opt.meters ? 'primary' : 'secondary'}
              block
            />
          </View>
        ))}
      </View>

      <Text style={styles.cardMeta}>
        {center
          ? `Searching near ${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`
          : hasNearClause
            ? 'Will look up that location when you search.'
            : 'No location set yet.'}
      </Text>

      <View style={styles.buttonRow}>
        <View style={styles.buttonSpacer}>
          <ThemedButton
            title="Use My Location"
            onPress={handleUseCurrentLocation}
            loading={locating}
            disabled={loading}
            variant="secondary"
            block
          />
        </View>
        <View style={styles.buttonSpacer}>
          <ThemedButton title="Search" onPress={handleSearch} loading={loading} disabled={locating} block />
        </View>
      </View>

      {!loading && error && <Text style={[styles.spacing, styles.errorText]}>{error}</Text>}

      {!loading && results && (
        <View style={styles.spacing}>
          <Text style={styles.cardTitle}>
            {results.length} result{results.length === 1 ? '' : 's'} with a usable address
          </Text>
          {skipped > 0 && (
            <Text style={styles.cardMeta}>
              {skipped} more matched but didn't have enough of a street address to geocode.
            </Text>
          )}
          {truncated && (
            <Text style={styles.cardMeta}>
              Capped at {results.length} results -- try a smaller radius for a more complete list.
            </Text>
          )}
          {results.map((result, index) => (
            <TouchableOpacity
              key={index}
              ref={(r) => {
                rowRefs.current[index] = r as unknown as View | null;
              }}
              style={[styles.resultRow, selectedIndex === index && styles.resultRowSelected]}
              onPress={() => handleSelectRow(index)}
            >
              <Text style={styles.resultAddress}>{result.name}</Text>
              <Text style={styles.cardMeta}>{result.address}</Text>
            </TouchableOpacity>
          ))}
          {places.length > 0 && (
            <View style={styles.spacing} ref={mapWrapperRef}>
              <FindPlacesMap
                center={center}
                places={places}
                selectedIndex={selectedIndex}
                focusRequest={focusRequest}
                onPlaceClick={handlePlaceClick}
              />
            </View>
          )}
          {results.length > 0 && (
            <View style={styles.spacing}>
              <ThemedButton title="Download Address List (.txt)" onPress={handleDownload} variant="secondary" block />
            </View>
          )}
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
  radiusRow: {
    flexDirection: 'row',
    gap: space[2],
    marginBottom: space[3],
  },
  radiusButton: {
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: space[2],
    marginTop: space[3],
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
    marginTop: space[2],
    paddingBottom: space[2],
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  resultRowSelected: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingLeft: space[2],
    backgroundColor: colors.surface,
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
