import { AppleMaps, GoogleMaps } from 'expo-maps';
import React, { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import type { RerouteOption } from '../../shared/api/types';

type Point = { latitude: number; longitude: number };

type Props = {
  driverPosition: Point;
  hazardPosition: Point;
  // Both optional -- this map is used two ways: alone (just "where is the
  // hazard relative to me", no server round trip needed) and, once a
  // driver also asks to see a way around it, augmented with the rejoin
  // point and route candidates from /road-signals/reroute (see
  // RoadRerouteMap.tsx on desktop -- same three fixed points, same
  // one-color-per-option scheme, ported to expo-maps' marker/polyline
  // shape instead of maplibre-gl's).
  rejoinPoint?: Point;
  options?: RerouteOption[];
  // Which option (index into `options`) to visually call out -- e.g. the
  // one the driver just tapped in the option list below the map. expo-maps
  // (alpha) documents no per-feature opacity for polylines, so "dimming"
  // the rest is faked by switching them to the same flat gray the rejoin
  // marker uses and thinning them, rather than true opacity like the
  // maplibre-based .web.tsx variant. null/undefined draws every route the
  // same as always.
  highlightedIndex?: number | null;
};

// Reuses the same route colors as desktop's RoadRerouteMap.tsx so the two
// apps read as the same product.
export const ROUTE_COLORS = ['#1e3a8a', '#f2a52d', '#7c3aed'];

// expo-maps (alpha) has no documented fitBounds/fitToCoordinates helper
// (unlike maplibre-gl's LngLatBounds, which desktop's RoadRerouteMap.tsx
// uses) -- centering on the midpoint of driver+hazard with a fixed zoom
// is an approximation, not a true fit. Good enough for the short
// driver-to-hazard distances these alerts are filtered to (radius capped
// well under this zoom level's visible span); wide outliers may render
// off-screen until the driver pans.
function approximateCenter(a: Point, b: Point): Point {
  return { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 };
}

export default function RoadAlertsMap({
  driverPosition,
  hazardPosition,
  rejoinPoint,
  options = [],
  highlightedIndex = null,
}: Props) {
  const cameraPosition = useMemo(
    () => ({ coordinates: approximateCenter(driverPosition, hazardPosition), zoom: 14 }),
    [driverPosition, hazardPosition]
  );

  const markers = useMemo(() => {
    const list = [
      { id: 'driver', coordinates: driverPosition, title: 'You' },
      { id: 'hazard', coordinates: hazardPosition, title: 'Hazard' },
    ];
    if (rejoinPoint) {
      list.push({ id: 'rejoin', coordinates: rejoinPoint, title: 'Estimated rejoin point (not exact)' });
    }
    return list;
  }, [driverPosition, hazardPosition, rejoinPoint]);

  // Reversed before mapping (option 0 last, i.e. on top) so the primary
  // route's thick dark-blue line draws on top wherever pgr_ksp's options
  // happen to overlap or fully coincide -- same reasoning as the .web.tsx
  // variant's toGeoJSON. When a specific option is highlighted (tapped),
  // that one is moved to the very end instead, so it always draws on top
  // regardless of its own index -- and gets a bigger width plus its real
  // color while every other option fades to a flat gray.
  const polylines = useMemo(() => {
    const indexed = options.map((option, index) => ({ option, index }));
    const ordered =
      highlightedIndex == null
        ? [...indexed].reverse()
        : [...indexed.filter((o) => o.index !== highlightedIndex), ...indexed.filter((o) => o.index === highlightedIndex)];
    return ordered.map(({ option, index }) => {
      const isHighlighted = highlightedIndex === index;
      const dimmed = highlightedIndex != null && !isHighlighted;
      return {
        id: `route-${index}`,
        coordinates: option.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
        color: dimmed ? '#9b9797' : ROUTE_COLORS[index % ROUTE_COLORS.length],
        width: isHighlighted ? 10 : dimmed ? 3 : 6,
      };
    });
  }, [options, highlightedIndex]);

  // Neither platform's map works in plain Expo Go -- see app.config.js's
  // expo-maps plugin entry and CLAUDE.md's note on this. A driver running
  // this screen through Expo Go would otherwise crash on the native
  // module lookup; this project has no way to detect that at runtime
  // beyond the platform check below, which is a separate concern (iOS vs.
  // Android, not Expo Go vs. dev client).
  const MapView = Platform.OS === 'ios' ? AppleMaps.View : GoogleMaps.View;

  return (
    <View style={styles.container}>
      <MapView style={styles.map} cameraPosition={cameraPosition} markers={markers} polylines={polylines} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 260,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 8,
  },
  map: {
    flex: 1,
  },
});
